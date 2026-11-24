/* Плащане с карта през виртуалния ПОС на „Банка ДСК“ АД.

   Интеграция „Redirect by API“: сървърът регистрира поръчката в банката
   (register.do), клиентът въвежда картата на страницата на банката, после
   се връща на сайта. Картови данни НЕ минават през този сървър (SAQ-A).

   Действия (POST, с жетона на влезлия клиент):
     {action:"start",  matter_id, lang}  → {formUrl} | {paid:true}
     {action:"status", matter_id}        → {paid, status, message, ...}

   Обратно известие от банката (GET или POST, без жетон):
     ?callback=1&mdOrder=…&orderNumber=…&operation=…&status=…&checksum=…
   Известието само ПОДСКАЗВА, че нещо се е случило. Истината винаги се взема
   с getOrderStatusExtended.do — затова подправено известие не може да
   отбележи преписка като платена (риск P4 в спецификацията).

   Сумата се смята ТУК, от записаната чернова, а не се приема от браузъра.

   Тайни (Supabase → Edge Functions → Secrets):
     DSK_ENV            test | prod           (по подразбиране test)
     DSK_USER           API потребител, завършва на „-api“
     DSK_PASS           паролата му
     DSK_CALLBACK_KEY   общ ключ за checksum (по желание; иска се от банката)
     DSK_GATEWAY        друг адрес на API-то (по желание)
     SITE_URL           https://scaleyourmark.com (по подразбиране)        */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const ENV          = (Deno.env.get("DSK_ENV") ?? "test").trim() === "prod" ? "prod" : "test";
const DSK_USER     = (Deno.env.get("DSK_USER") ?? "").trim();
const DSK_PASS     = Deno.env.get("DSK_PASS") ?? "";
const CB_KEY       = (Deno.env.get("DSK_CALLBACK_KEY") ?? "").trim();
const SITE         = (Deno.env.get("SITE_URL") ?? "https://scaleyourmark.com").replace(/\/+$/, "");

/* Адресът може да се подмени с тайна DSK_GATEWAY, ако банката даде друг. */
const GW_OVERRIDE = (Deno.env.get("DSK_GATEWAY") ?? "").trim();
const GATEWAY = GW_OVERRIDE
  ? GW_OVERRIDE.replace(/\/*$/, "/")
  : ENV === "prod" ? "https://epg.dskbank.bg/payment/rest/" : "https://uat.dskbank.bg/payment/rest/";
const SELF_URL = `${SUPABASE_URL}/functions/v1/dsk-pay`;

const EUR = "978";                // ISO 4217, цифров код
const MAX_EUR = 4000;             // т. 8.5.5 от Общите условия

/* ——— Цени: огледало на index.html (ROUTES, SERVICE, SEARCH_FEE, MONITOR).
   При промяна на цените се сменят и на двете места.                     */
const ROUTES = {
  bg_nat: { base: 265.87, extra: 15.34, cert: 25.56 },
  eutm:   { base: 850, second: 50, third: 150 },
  madrid: { base: 653, colour: 903, party: 100, overclass: 100 },
} as const;
const SERVICE: Record<string, number> = { bg_nat: 295, eutm: 395, madrid: 395 };
const SEARCH_FEE = 120;
const MONITOR: Record<string, number> = { m6: 600, y1: 1000 };
const VAT = 0.2;

type Breakdown = {
  route: string; classes: number; service: number; search: number; monitor: number;
  net: number; vat: number; official: number; official_currency: string;
  total_eur: number;
};

function price(st: Record<string, any>): Breakdown | null {
  const route = String(st.route ?? "");
  if (!(route in SERVICE)) return null;
  const terms = Array.isArray(st.terms) ? st.terms : [];
  const n = Math.max(1, new Set(terms.map((t: any) => t && t.c)).size);
  const r: any = (ROUTES as any)[route];
  let official = 0, cur = "EUR";
  if (route === "bg_nat") official = r.base + Math.max(0, n - 3) * r.extra + r.cert;
  else if (route === "eutm") official = r.base + (n >= 2 ? r.second : 0) + Math.max(0, n - 2) * r.third;
  else { official = (st.colour ? r.colour : r.base) + r.party + Math.max(0, n - 3) * r.overclass; cur = "CHF"; }
  const service = SERVICE[route];
  const search  = st.search === "full" ? SEARCH_FEE : 0;
  const monitor = st.monitor && MONITOR[st.monitor] ? MONITOR[st.monitor] : 0;
  const net = service + search + monitor;
  const vat = net * VAT;
  /* При Мадрид таксата на СОИС не се плаща сега — само възнаграждението. */
  const total = (route === "madrid" ? 0 : official) + net + vat;
  const c = (x: number) => Math.round(x * 100) / 100;
  return { route, classes: n, service, search, monitor, net: c(net), vat: c(vat),
           official: c(official), official_currency: cur, total_eur: c(total) };
}

/* ——— Общи помощни ———————————————————————————————————————————— */
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
async function rows(path: string): Promise<any[]> {
  const r = await db(path);
  if (!r.ok) throw new Error(`db ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return await r.json();
}
async function insert(table: string, body: unknown) {
  const r = await db(table, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`db ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return (await r.json())[0];
}
async function patch(table: string, filter: string, body: unknown) {
  const r = await db(`${table}?${filter}`, { method: "PATCH", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`db ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
}

async function caller(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!/^Bearer\s+\S+/i.test(auth)) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: ANON_KEY || SERVICE_KEY },
  });
  if (!r.ok) return null;
  try { const u = await r.json(); return u && u.id ? { id: String(u.id) } : null; } catch { return null; }
}

/* ——— Банката ————————————————————————————————————————————————— */
async function gw(method: string, params: Record<string, string>) {
  const body = new URLSearchParams({ userName: DSK_USER, password: DSK_PASS, ...params });
  const r = await fetch(GATEWAY + method, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`gateway ${method} HTTP ${r.status}`);
  try { return JSON.parse(text); } catch { throw new Error(`gateway ${method}: bad JSON`); }
}
const gwOk = (j: any) => j && (j.success === true || String(j.errorCode ?? "0") === "0");

/* orderStatus: 0 регистрирана, 1 задържана (двуфазно), 2 платена,
   3 сторнирана, 4 върната, 5 в 3-D Secure, 6 отказана.                   */
function mapStatus(j: any): string {
  const s = Number(j.orderStatus);
  const ps = j.paymentAmountInfo && j.paymentAmountInfo.paymentState;
  if (s === 2 || ps === "DEPOSITED") return "paid";
  if (s === 1 || ps === "APPROVED")  return "approved";
  if (s === 3 || ps === "REVERSED")  return "reversed";
  if (s === 4 || ps === "REFUNDED")  return "refunded";
  if (s === 6 || ps === "DECLINED")  return "declined";
  return "registered";
}

/* Пита банката за поръчката и записва резултата. Връща новия ред. */
async function refresh(order: any) {
  if (!order.gateway_order_id) return order;
  const j = await gw("getOrderStatusExtended.do", { orderId: order.gateway_order_id, language: "bg" });
  if (!gwOk(j) && j.orderStatus === undefined) {
    await patch("vpos_orders", `id=eq.${order.id}`, { error: String(j.errorMessage ?? "").slice(0, 300), updated_at: new Date().toISOString() });
    return order;
  }
  let status = mapStatus(j);
  /* Платено, но не за сумата, която сме поискали — не се приема. */
  if (status === "paid" && Number(j.amount) !== Number(order.amount_minor)) status = "error";
  const card = j.cardAuthInfo || {};
  const upd: Record<string, unknown> = {
    status,
    order_status: j.orderStatus ?? null,
    action_code: j.actionCode ?? null,
    action_code_description: String(j.actionCodeDescription ?? "").slice(0, 300) || null,
    pan_masked: card.maskedPan ?? card.pan ?? null,
    approval_code: card.approvalCode ?? null,
    rrn: j.authRefNum ?? null,
    error: status === "error" ? "amount mismatch" : null,
    updated_at: new Date().toISOString(),
  };
  if (status === "paid" && !order.paid_at) upd.paid_at = new Date().toISOString();
  await patch("vpos_orders", `id=eq.${order.id}`, upd);
  return { ...order, ...upd };
}

/* ——— Проверка на checksum по документацията на ДСК:
   без checksum и sign_alias, имената по азбучен ред, „име;стойност;“,
   HMAC-SHA256 с общия ключ, главни шестнайсетични.                     */
async function checksumOk(p: URLSearchParams) {
  if (!CB_KEY) return true;                    // ключ не е издаден — разчитаме на повторната проверка
  const got = (p.get("checksum") ?? "").toUpperCase();
  if (!got) return false;
  const names = [...new Set([...p.keys()])].filter((k) => k !== "checksum" && k !== "sign_alias" && k !== "callback").sort();
  const s = names.map((k) => `${k};${p.get(k) ?? ""};`).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(CB_KEY),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(s)));
  const hex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  if (hex.length !== got.length) return false;
  let d = 0; for (let i = 0; i < hex.length; i++) d |= hex.charCodeAt(i) ^ got.charCodeAt(i);
  return d === 0;
}

async function handleCallback(req: Request) {
  let p = new URL(req.url).searchParams;
  if (req.method === "POST") {
    const t = await req.text().catch(() => "");
    const b = new URLSearchParams(t);
    if ([...b.keys()].length) { b.set("callback", "1"); p = b; }
  }
  const md = p.get("mdOrder") ?? "";
  if (!/^[0-9a-f-]{20,40}$/i.test(md)) return new Response("bad", { status: 400 });
  if (!(await checksumOk(p))) return new Response("checksum", { status: 403 });
  const found = await rows(`vpos_orders?gateway_order_id=eq.${md}&select=*`);
  if (!found.length) return new Response("OK", { status: 200 });   // чужда или стара поръчка
  const o = found[0];
  await patch("vpos_orders", `id=eq.${o.id}`, {
    last_callback: Object.fromEntries([...p.entries()].filter(([k]) => k !== "checksum")),
  });
  await refresh(o);
  return new Response("OK", { status: 200 });
}

/* ——— Вход ——————————————————————————————————————————————————— */
Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("callback") === "1") {
    try { return await handleCallback(req); }
    catch (e) { console.error("callback", e); return new Response("retry", { status: 500 }); }
  }

  const H = cors(req.headers.get("origin"));
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...H, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: H });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!DSK_USER || !DSK_PASS) return json({ error: "not_configured" }, 503);

  const me = await caller(req);
  if (!me) return json({ error: "auth" }, 401);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  /* Проверка на връзката и данните за достъп: несъществуваща поръчка.
     „Достъпът е отказан“ = грешен потребител/парола; „няма такава поръчка“ = всичко е наред. */
  if (b.action === "probe") {
    try {
      const j = await gw("getOrderStatusExtended.do", { orderNumber: "PROBE-" + Date.now(), language: "en" });
      return json({ env: ENV, gateway: GATEWAY, user: DSK_USER, errorCode: j.errorCode ?? null, errorMessage: j.errorMessage ?? null });
    } catch (e) { return json({ env: ENV, gateway: GATEWAY, error: String(e) }, 502); }
  }
  const matterId = String(b.matter_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(matterId)) return json({ error: "matter" }, 422);

  try {
    const m = (await rows(`matters?id=eq.${matterId}&select=id,ref,user_id,status,step_state`))[0];
    if (!m || m.user_id !== me.id) return json({ error: "matter" }, 404);

    const orders = await rows(`vpos_orders?matter_id=eq.${matterId}&env=eq.${ENV}&select=*&order=created_at.desc&limit=5`);
    const paidRow = orders.find((o) => o.status === "paid");

    if (b.action === "status") {
      let o = paidRow ?? orders[0];
      if (!o) return json({ paid: false, status: "none" });
      if (o.status !== "paid") o = await refresh(o);
      return json({
        paid: o.status === "paid", status: o.status, env: ENV,
        amount: o.amount_minor / 100, paid_at: o.paid_at ?? null,
        pan: o.pan_masked ?? null, order_number: o.order_number,
        message: o.action_code_description ?? null,
      });
    }

    if (b.action === "start") {
      if (paidRow) return json({ paid: true });
      if (m.status !== "draft") return json({ error: "locked" }, 409);
      /* Последната поръчка може да е платена, а известието да не е дошло. */
      if (orders[0] && ["registered", "approved"].includes(orders[0].status)) {
        const o = await refresh(orders[0]);
        if (o.status === "paid") return json({ paid: true });
      }
      const recent = orders.filter((o) => Date.now() - Date.parse(o.created_at) < 3600_000).length;
      if (recent >= 5) return json({ error: "too_many" }, 429);

      const br = price(m.step_state || {});
      if (!br) return json({ error: "price" }, 422);
      if (br.total_eur <= 0) return json({ error: "price" }, 422);
      if (br.total_eur > MAX_EUR) return json({ error: "over_limit", total: br.total_eur }, 422);
      const amountMinor = Math.round(br.total_eur * 100);

      const n = (await rows(`vpos_orders?matter_id=eq.${matterId}&select=id`)).length + 1;
      const orderNumber = `${m.ref || "SYM"}-${ENV === "prod" ? "" : "T"}${n}`.slice(0, 36);
      const lang = b.lang === "en" ? "en" : "bg";

      const row = await insert("vpos_orders", {
        matter_id: matterId, user_id: me.id, order_number: orderNumber, env: ENV,
        amount_minor: amountMinor, currency: EUR, breakdown: br, status: "created",
      });

      const back = `${SITE}/?dsk=${matterId}`;
      const j = await gw("register.do", {
        orderNumber,
        amount: String(amountMinor),
        currency: EUR,
        returnUrl: back,
        failUrl: back,
        dynamicCallbackUrl: `${SELF_URL}?callback=1`,
        description: `ScaleYourMark ${m.ref || ""}`.trim(),   // без лични данни
        language: lang,
        sessionTimeoutSecs: "1200",
        jsonParams: JSON.stringify({ backToShopUrl: back, backToShopName: "ScaleYourMark" }),
      });
      if (!gwOk(j) || !j.formUrl || !j.orderId) {
        await patch("vpos_orders", `id=eq.${row.id}`, {
          status: "error", error: `${j.errorCode ?? "?"} ${String(j.errorMessage ?? "").slice(0, 250)}`,
          updated_at: new Date().toISOString(),
        });
        return json({ error: "gateway", code: j.errorCode ?? null }, 502);
      }
      await patch("vpos_orders", `id=eq.${row.id}`, {
        status: "registered", gateway_order_id: j.orderId, updated_at: new Date().toISOString(),
      });
      return json({ formUrl: j.formUrl, amount: br.total_eur, env: ENV });
    }

    return json({ error: "action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "server" }, 500);
  }
});
