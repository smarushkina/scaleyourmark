/* Месечният бюлетин на scaleyourmark.com.

   Съгласието е с потвърждение по имейл: адресът стои „pending“, докато
   човекът не отвори връзката от писмото. Така в списъка не може да влезе
   чужд адрес и има запис кога и от кой адрес е дадено съгласието.

   Три действия, всички по POST:
     {action:"subscribe",   email, lang}
     {action:"confirm",     token}
     {action:"unsubscribe", token}                                         */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY   = Deno.env.get("RESEND_API_KEY")!;
const FROM         = "ScaleYourMark <office@scaleyourmark.com>";
const SITE         = "https://scaleyourmark.com";

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
const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

function newToken() {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
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

function confirmMail(email: string, token: string, lang: string) {
  const bg = lang !== "en";
  const url = `${SITE}/?nl=${token}`;
  const off = `${SITE}/?nlu=${token}`;
  const subject = bg ? "Потвърдете абонамента за бюлетина" : "Confirm your newsletter subscription";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#0A1730;line-height:1.55">
  <h2 style="font-size:17px;margin:0 0 12px">${bg ? "Още една стъпка" : "One more step"}</h2>
  <p style="margin:0 0 14px">${bg
    ? `Някой — вероятно Вие — е заявил месечния бюлетин на ScaleYourMark за <b>${esc(email)}</b>. Абонаментът влиза в сила чак след потвърждение.`
    : `Someone — probably you — asked for the ScaleYourMark monthly briefing for <b>${esc(email)}</b>. The subscription starts only after you confirm.`}</p>
  <p style="margin:0 0 20px">
    <a href="${url}" style="display:inline-block;background:#0A1730;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:700">
      ${bg ? "Потвърждавам" : "Confirm"}</a></p>
  <p style="margin:0 0 6px;font-size:13px;color:#6A6155">${bg
    ? "Ако не сте Вие, просто не правете нищо — адресът няма да бъде добавен."
    : "If this was not you, simply do nothing — the address will not be added."}</p>
  <p style="margin:0;font-size:12px;color:#6A6155">${bg ? "Отписване по всяко време: " : "Unsubscribe at any time: "}<a href="${off}" style="color:#7A5520">${off}</a></p>
</div>`;
  return { subject, html };
}

async function sendMail(to: string, subject: string, html: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject, html }),
  });
  if (!res.ok) {
    const out = await res.text().catch(() => "");
    throw new Error(`${res.status} ${out.slice(0, 200)}`);
  }
}

Deno.serve(async (req) => {
  const H = cors(req.headers.get("origin"));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...H, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: H });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const action = String(b.action ?? "");

  /* ---------------------------------------------------------- записване */
  if (action === "subscribe") {
    if (String(b.company ?? "").trim()) return json({ ok: true });   // капан за роботи
    const email = String(b.email ?? "").trim().toLowerCase().slice(0, 160);
    const lang  = b.lang === "en" ? "en" : "bg";
    if (!EMAIL.test(email)) return json({ error: "email" }, 422);

    const found = await rows(`newsletter_subscribers?select=id,status,token,sent_at&email=eq.${encodeURIComponent(email)}&limit=1`);
    const cur = found[0];

    if (cur && cur.status === "confirmed") return json({ ok: true, already: true });

    /* Едно писмо на две минути за един адрес. */
    if (cur && cur.sent_at && Date.now() - Date.parse(cur.sent_at) < 2 * 60 * 1000) {
      return json({ ok: true });
    }

    const token = newToken();
    if (cur) {
      await db(`newsletter_subscribers?id=eq.${cur.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "pending", token, lang, sent_at: new Date().toISOString(), unsubscribed_at: null }),
      });
    } else {
      const r = await db("newsletter_subscribers", {
        method: "POST",
        body: JSON.stringify({ email, token, lang, sent_at: new Date().toISOString() }),
      });
      if (!r.ok) return json({ error: "store" }, 500);
    }

    try {
      const m = confirmMail(email, token, lang);
      await sendMail(email, m.subject, m.html);
    } catch (e) {
      return json({ error: "mail", detail: String((e as Error)?.message ?? e) }, 502);
    }
    return json({ ok: true });
  }

  /* -------------------------------------------------------- потвърждение */
  if (action === "confirm" || action === "unsubscribe") {
    const token = String(b.token ?? "").trim();
    if (!/^[0-9a-f]{48}$/.test(token)) return json({ error: "token" }, 422);

    const found = await rows(`newsletter_subscribers?select=id,email,status&token=eq.${encodeURIComponent(token)}&limit=1`);
    const cur = found[0];
    if (!cur) return json({ error: "token" }, 404);

    if (action === "confirm") {
      if (cur.status !== "confirmed") {
        await db(`newsletter_subscribers?id=eq.${cur.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "confirmed", confirmed_at: new Date().toISOString() }),
        });
      }
      return json({ ok: true, email: cur.email, already: cur.status === "confirmed" });
    }

    await db(`newsletter_subscribers?id=eq.${cur.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "unsubscribed", unsubscribed_at: new Date().toISOString() }),
    });
    return json({ ok: true, email: cur.email });
  }

  return json({ error: "action" }, 400);
});
