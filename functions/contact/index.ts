/* Формата „Контакти“ на scaleyourmark.com.

   Приема запитване от страницата, записва го в app.contact_messages и го
   праща на пощата на кантората през Resend. Ключът на Resend стои в
   средата на функцията — браузърът на посетителя не го вижда никога.

   Получателят се чете от app.notification_settings.practice_email, за да
   има само едно място, където се сменя адресът.                            */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY   = Deno.env.get("RESEND_API_KEY")!;
const FALLBACK_TO  = "office@scaleyourmark.com";
const FROM         = "ScaleYourMark <office@scaleyourmark.com>";

const ALLOWED = [
  "https://scaleyourmark.com",
  "https://www.scaleyourmark.com",
];

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
const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

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

Deno.serve(async (req) => {
  const H = cors(req.headers.get("origin"));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...H, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: H });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  /* Скрито поле в страницата. Човек го оставя празно; робот го попълва.
     Отговаряме „прието“, за да не си личи, че е уловен.                  */
  if (clean(b.company, 80)) return json({ ok: true });

  const name    = clean(b.name, 120);
  const email   = clean(b.email, 160).toLowerCase();
  const topic   = clean(b.topic, 120);
  const message = String(b.message ?? "").trim().slice(0, 5000);

  if (name.length < 2)    return json({ error: "name" }, 422);
  if (!EMAIL.test(email)) return json({ error: "email" }, 422);
  if (message.length < 5) return json({ error: "message" }, 422);

  /* До три запитвания от един адрес за десет минути. */
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  try {
    const r = await db(
      `contact_messages?select=id&email=eq.${encodeURIComponent(email)}&created_at=gte.${encodeURIComponent(since)}`,
    );
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length >= 3) return json({ error: "too_many" }, 429);
    }
  } catch { /* ограничението не бива да спира истинско запитване */ }

  let to = FALLBACK_TO;
  try {
    const r = await db("notification_settings?select=practice_email&limit=1");
    if (r.ok) {
      const rows = await r.json();
      const v = Array.isArray(rows) && rows[0] && rows[0].practice_email;
      if (typeof v === "string" && EMAIL.test(v)) to = v;
    }
  } catch { /* остава адресът по подразбиране */ }

  const ins = await db("contact_messages", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ name, email, topic, message }),
  });
  let row: { id?: number } | null = null;
  try { row = ins.ok ? (await ins.json())[0] : null; } catch { row = null; }

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#0A1730;line-height:1.5">
  <h2 style="font-size:17px;margin:0 0 14px">Запитване от сайта</h2>
  <p style="margin:0 0 4px"><b>Име:</b> ${esc(name)}</p>
  <p style="margin:0 0 4px"><b>Имейл:</b> <a href="mailto:${esc(email)}" style="color:#7A5520">${esc(email)}</a></p>
  <p style="margin:0 0 14px"><b>Тема:</b> ${esc(topic || "—")}</p>
  <div style="white-space:pre-wrap;border-left:3px solid #BE9666;padding-left:14px;color:#2C3C59">${esc(message)}</div>
  <p style="margin-top:20px;font-size:12px;color:#6A6155">scaleyourmark.com · форма „Контакти“. Отговорът до подателя тръгва с обикновено „Отговори“.</p>
</div>`;

  let sent = false;
  let providerId: string | null = null;
  let error: string | null = null;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        reply_to: email,
        subject: `Запитване от сайта — ${topic || "без тема"}`,
        html,
      }),
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok) { sent = true; providerId = (out as { id?: string }).id ?? null; }
    else error = `${res.status} ${JSON.stringify(out).slice(0, 300)}`;
  } catch (e) {
    error = String((e as Error)?.message ?? e);
  }

  if (row && row.id) {
    try {
      await db(`contact_messages?id=eq.${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: sent ? "sent" : "failed", provider_id: providerId, error }),
      });
    } catch { /* редът е записан; статусът е второстепенен */ }
  }

  return sent ? json({ ok: true }) : json({ error: "mail", detail: error }, 502);
});
