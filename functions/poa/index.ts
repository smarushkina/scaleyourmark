/* Подписване на адвокатското пълномощно с прост електронен подпис.

   Две действия:
     {action:"send_code", matter_id}  — праща шестцифрен код на имейла на
                                        клиента (същия, с който е влязъл)
     {action:"sign", matter_id, code, signatory_name, signatory_capacity,
                     poa_html, signature_png}

   Подписът е „прост“ по смисъла на eIDAS: рисуван подпис, свързан с
   документа, потвърден с код на адреса на подписващия. Запазват се самият
   документ, отпечатъкът му (SHA-256), времето, адресът и браузърът — това
   е доказателствената следа.

   Функцията сама проверява кой вика: жетонът на влезлия потребител се
   сверява през /auth/v1/user, а преписката трябва да е негова.           */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const RESEND_KEY   = Deno.env.get("RESEND_API_KEY")!;
const FROM         = "ScaleYourMark <office@scaleyourmark.com>";
const BUCKET       = "matter-files";

const ALLOWED = ["https://scaleyourmark.com", "https://www.scaleyourmark.com"];
function cors(origin: string | null) {
  const o = origin && ALLOWED.includes(origin) ? origin : ALLOWED[0];
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const esc = (s: string) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const clean = (s: unknown, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

async function sha256hex(s: string | Uint8Array) {
  const data = typeof s === "string" ? new TextEncoder().encode(s) : s;
  const b = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function db(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Accept-Profile": "app",
      "Content-Profile": "app",
      ...(init.headers ?? {}),
    },
  });
}
async function rows(path: string) {
  const r = await db(path);
  if (!r.ok) return [];
  try { return await r.json(); } catch { return []; }
}

async function caller(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!/^Bearer\s+\S+/i.test(auth)) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: ANON_KEY || SERVICE_KEY },
  });
  if (!r.ok) return null;
  try {
    const u = await r.json();
    return u && u.id ? { id: u.id as string, email: String(u.email || "") } : null;
  } catch { return null; }
}

async function sendMail(to: string, subject: string, html: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject, html }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

async function putObject(path: string, body: Uint8Array | string, contentType: string) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body,
  });
  if (!r.ok) throw new Error(`storage ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
}

Deno.serve(async (req) => {
  const H = cors(req.headers.get("origin"));
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...H, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: H });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const me = await caller(req);
  if (!me) return json({ error: "auth" }, 401);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  const matterId = String(b.matter_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(matterId)) return json({ error: "matter" }, 422);

  const mrows = await rows(`matters?select=id,ref,user_id,locked_at&id=eq.${matterId}&limit=1`);
  const matter = mrows[0];
  if (!matter || matter.user_id !== me.id) return json({ error: "matter" }, 404);
  if (matter.locked_at) return json({ error: "locked" }, 409);

  const action = String(b.action ?? "");

  /* ------------------------------------------------------------- код */
  if (action === "send_code") {
    const recent = await rows(
      `poa_sign_codes?select=id,created_at&matter_id=eq.${matterId}&order=created_at.desc&limit=5`,
    );
    if (recent[0] && Date.now() - Date.parse(recent[0].created_at) < 60 * 1000) {
      return json({ error: "too_soon" }, 429);
    }
    const lastHour = recent.filter((r: { created_at: string }) =>
      Date.now() - Date.parse(r.created_at) < 60 * 60 * 1000).length;
    if (lastHour >= 5) return json({ error: "too_many" }, 429);

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const hash = await sha256hex(matterId + ":" + code);
    const ins = await db("poa_sign_codes", {
      method: "POST",
      body: JSON.stringify({
        matter_id: matterId,
        email: me.email,
        code_hash: hash,
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      }),
    });
    if (!ins.ok) return json({ error: "store" }, 500);

    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#0A1730;line-height:1.55">
  <h2 style="font-size:17px;margin:0 0 12px">Код за подписване на пълномощното</h2>
  <p style="margin:0 0 10px">Преписка <b>${esc(matter.ref || "")}</b>. Въведете кода в страницата, за да положите подписа си.</p>
  <p style="margin:0 0 14px;font-size:30px;font-weight:700;letter-spacing:.14em">${esc(code)}</p>
  <p style="margin:0;font-size:13px;color:#6A6155">Валиден 15 минути. Ако не сте поискали подписване, не въвеждайте кода — пълномощното няма да бъде подписано.</p>
</div>`;
    try { await sendMail(me.email, "ScaleYourMark — код за подписване на пълномощното", html); }
    catch (e) { return json({ error: "mail", detail: String((e as Error)?.message ?? e) }, 502); }
    return json({ ok: true, email: me.email });
  }

  /* ---------------------------------------------------------- подпис */
  if (action === "sign") {
    const code = String(b.code ?? "").replace(/\D+/g, "");
    if (code.length !== 6) return json({ error: "code" }, 422);

    const name = clean(b.signatory_name, 160);
    const capacity = clean(b.signatory_capacity, 120) || "заявител";
    const poaHtml = String(b.poa_html ?? "");
    const sigPng = String(b.signature_png ?? "");
    if (name.length < 3) return json({ error: "name" }, 422);
    if (poaHtml.length < 200 || poaHtml.length > 400000) return json({ error: "document" }, 422);
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]{200,}$/.test(sigPng)) return json({ error: "signature" }, 422);

    const hash = await sha256hex(matterId + ":" + code);
    const found = await rows(
      `poa_sign_codes?select=id,expires_at,used_at,attempts&matter_id=eq.${matterId}&code_hash=eq.${hash}&limit=1`,
    );
    const rec = found[0];
    if (!rec) {
      const open = await rows(
        `poa_sign_codes?select=id,attempts&matter_id=eq.${matterId}&used_at=is.null&order=created_at.desc&limit=1`,
      );
      if (open[0]) {
        await db(`poa_sign_codes?id=eq.${open[0].id}`, {
          method: "PATCH", body: JSON.stringify({ attempts: (open[0].attempts || 0) + 1 }),
        });
      }
      return json({ error: "code" }, 403);
    }
    if (rec.used_at) return json({ error: "code_used" }, 403);
    if (Date.parse(rec.expires_at) < Date.now()) return json({ error: "code_expired" }, 403);
    if ((rec.attempts || 0) >= 5) return json({ error: "code" }, 403);

    const signedAt = new Date().toISOString();
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
    const ua = (req.headers.get("user-agent") || "").slice(0, 300);
    const docHash = await sha256hex(poaHtml);

    try {
      const sigBytes = Uint8Array.from(atob(sigPng.split(",")[1]), (c) => c.charCodeAt(0));
      await putObject(`${matterId}/poa-signature-${docHash.slice(0, 12)}.png`, sigBytes, "image/png");
      await putObject(`${matterId}/poa-${docHash.slice(0, 12)}.html`, poaHtml, "text/html; charset=utf-8");
    } catch (e) {
      return json({ error: "store", detail: String((e as Error)?.message ?? e) }, 500);
    }

    const docIns = await db("documents", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        matter_id: matterId,
        kind: "power_of_attorney",
        storage_key: `${matterId}/poa-${docHash.slice(0, 12)}.html`,
        filename: `${matter.ref || "poa"} — пълномощно.html`,
        mime_type: "text/html",
        byte_size: new TextEncoder().encode(poaHtml).length,
        sha256: docHash,
      }),
    });
    if (!docIns.ok) return json({ error: "document", detail: (await docIns.text()).slice(0, 200) }, 500);
    const doc = (await docIns.json())[0];

    await db(`powers_of_attorney?matter_id=eq.${matterId}`, { method: "DELETE" });
    const poaIns = await db("powers_of_attorney", {
      method: "POST",
      body: JSON.stringify({
        matter_id: matterId,
        signatory_name: name,
        signatory_capacity: capacity,
        method: "ses_drawn",
        provider: `ScaleYourMark SES · код на ${me.email} · ${ip || "ip n/a"} · ${ua}`,
        signed_at: signedAt,
        document_id: doc.id,
      }),
    });
    if (!poaIns.ok) return json({ error: "poa", detail: (await poaIns.text()).slice(0, 200) }, 500);

    await db(`poa_sign_codes?id=eq.${rec.id}`, {
      method: "PATCH", body: JSON.stringify({ used_at: signedAt }),
    });

    try {
      await sendMail(me.email, `ScaleYourMark — подписано пълномощно ${matter.ref || ""}`,
        `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#0A1730;line-height:1.55">
  <h2 style="font-size:17px;margin:0 0 12px">Пълномощното е подписано</h2>
  <p style="margin:0 0 8px">Преписка <b>${esc(matter.ref || "")}</b></p>
  <p style="margin:0 0 8px">Подписал: <b>${esc(name)}</b>, ${esc(capacity)}</p>
  <p style="margin:0 0 8px">Дата и час: ${esc(new Date(signedAt).toLocaleString("bg-BG"))}</p>
  <p style="margin:0 0 14px">Отпечатък на документа (SHA-256): <span style="font-family:monospace;font-size:12px">${esc(docHash)}</span></p>
  <p style="margin:0;font-size:13px;color:#6A6155">Копие от документа можете да свалите от страницата на заявяването.</p>
</div>`);
    } catch { /* потвърждението не бива да отменя подписа */ }

    return json({ ok: true, signed_at: signedAt, hash: docHash });
  }

  return json({ error: "action" }, 400);
});
