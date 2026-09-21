// hdb-suggest — предложения за стоки и услуги от Хармонизираната база на EUIPO,
// показани в нашия интерфейс. Ключът никога не напуска сървъра.
//
// Извиква се от сайта с жетона на влезлия клиент:
//   POST /functions/v1/hdb-suggest   { q, lang, niceClass, limit }
// Диагностика (пак само за влязъл клиент):
//   POST /functions/v1/hdb-suggest   { probe: true }
//
// Всяка заявка носи Authorization: Bearer <жетона на сесията>. Функцията
// го проверява срещу Supabase Auth — без валиден потребител няма отговор.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const ENV = (Deno.env.get('EUIPO_ENV') || 'sandbox').trim().toLowerCase();
const CLIENT_ID = (Deno.env.get('EUIPO_CLIENT_ID') || '').trim();
const CLIENT_SECRET = (Deno.env.get('EUIPO_CLIENT_SECRET') || '').trim();
const SANDBOX = ENV !== 'production';

// Адресът за жетона е различен в двете среди не само по поддомейн, а и по път.
// Взето от самата OpenAPI спецификация на портала (tokenUrl), 21 септември 2026:
//   sandbox     https://auth-sandbox.euipo.europa.eu/oidc/accessToken
//   production  https://euipo.europa.eu/cas-server-webapp/oidc/accessToken
// Предположението, че production е auth.euipo.europa.eu/oidc/accessToken, дава 502.
const AUTH_URL = (Deno.env.get('EUIPO_AUTH_URL') || '').trim() || (SANDBOX
  ? 'https://auth-sandbox.euipo.europa.eu/oidc/accessToken'
  : 'https://euipo.europa.eu/cas-server-webapp/oidc/accessToken');
const PORTAL = SANDBOX
  ? 'https://dev-sandbox.euipo.europa.eu'
  : 'https://dev.euipo.europa.eu';

// ---------- жетонът, кеширан докато е валиден ----------
let tok: { value: string; exp: number } | null = null;

async function token(): Promise<string> {
  const now = Date.now();
  if (tok && tok.exp > now + 60_000) return tok.value;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'uid',
  });

  const r = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`token ${r.status}: ${text.slice(0, 300)}`);

  let d: any;
  try { d = JSON.parse(text); } catch { throw new Error('token: отговорът не е JSON: ' + text.slice(0, 200)); }
  if (!d.access_token) throw new Error('token: няма access_token: ' + text.slice(0, 200));

  tok = { value: d.access_token, exp: now + ((d.expires_in || 3600) * 1000) };
  return tok.value;
}

function apiHeaders(t: string) {
  return {
    'Authorization': 'Bearer ' + t,
    'X-IBM-Client-Id': CLIENT_ID,
    'Accept': 'application/json',
  };
}

// ---------- диагностика: намираме истинския адрес на API-то ----------
async function probe() {
  const out: any = { env: ENV, authUrl: AUTH_URL, base: BASE, hasId: !!CLIENT_ID, hasSecret: !!CLIENT_SECRET };

  // 1. жетон
  try {
    const t = await token();
    out.token = { ok: true, length: t.length, expiresInMs: tok ? tok.exp - Date.now() : null };
  } catch (e) {
    out.token = { ok: false, error: String(e) };
    return out;   // без жетон няма смисъл да пробваме нататък
  }

  // 2. адресите, изписани в самата документация на портала
  out.hostsFromDocs = [];
  try {
    const html = await fetch(PORTAL + '/product/goods-and-services_120/api/goods-and-services')
      .then((r) => r.text());
    const found = new Set<string>();
    for (const m of html.matchAll(/https:\/\/[a-z0-9.-]*euipo\.europa\.eu[a-zA-Z0-9/_.-]*/g)) {
      const u = m[0];
      if (/api|gateway|gs|goods/i.test(u) && !/dev-sandbox\.euipo\.europa\.eu\/(sites|themes|core|modules)/.test(u)) {
        found.add(u);
      }
    }
    out.hostsFromDocs = [...found].slice(0, 40);
  } catch (e) {
    out.hostsFromDocs = ['scrape error: ' + String(e)];
  }

  // 3. проверяваме самото API
  const t = await token();
  const bases = [BASE];
  out.tried = [];
  for (const b of bases) {
    const url = b + '/terms?termText=coffee&language=en&size=10';
    try {
      const r = await fetch(url, { headers: apiHeaders(t) });
      const body = (await r.text()).slice(0, 220);
      out.tried.push({ base: b, status: r.status, body });
      if (r.ok) { out.working = b; break; }
    } catch (e) {
      out.tried.push({ base: b, error: String(e) });
    }
  }
  return out;
}

// ---------- истинското търсене ----------
// Адресът е установен с диагностика на 15 септември 2026: шлюзът разпознава
// /goods-and-services и отговаря на /terms. Версията не е част от пътя.
const BASE = SANDBOX
  ? (Deno.env.get('EUIPO_GS_BASE') || 'https://api-sandbox.euipo.europa.eu/goods-and-services')
  : (Deno.env.get('EUIPO_GS_BASE') || 'https://api.euipo.europa.eu/goods-and-services');

// Имената на параметрите и формата на отговора са установени с проби срещу
// самото API на 15 септември 2026 — не са преписани от документация:
//   termText   — думата за търсене (не text, не term, не query)
//   classNumber— класът по Ница (не niceClass)
//   language   — bg | en
//   size       — минимум 10, иначе 400
// Отговор: { terms: [{ text, classNumber, conceptId, taxonomyParentId }],
//            totalElements, totalPages, size, page }
const cache = new Map<string, { at: number; out: unknown }>();

async function suggest(q: string, lang: string, niceClass: string, limit: number) {
  const key = [q, lang, niceClass, limit].join('|');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.out;

  const t = await token();
  const p = new URLSearchParams({
    termText: q,
    language: lang,
    size: String(Math.max(10, limit)),
    page: '0',
  });
  if (niceClass) p.set('classNumber', niceClass);

  const r = await fetch(BASE + '/terms?' + p.toString(), { headers: apiHeaders(t) });
  const text = await r.text();
  if (!r.ok) throw new Error(`terms ${r.status}: ${text.slice(0, 300)}`);

  let d: any;
  try { d = JSON.parse(text); } catch { throw new Error('terms: отговорът не е JSON'); }

  const rows = (d.terms || []).map((x: any) => ({
    id: String(x.conceptId || ''),
    c: Number(x.classNumber || 0),
    t: String(x.text || ''),
  })).filter((x: any) => x.id && x.t && x.c >= 1 && x.c <= 45);

  const out = { rows, total: Number(d.totalElements || rows.length) };
  if (cache.size > 300) cache.clear();
  cache.set(key, { at: Date.now(), out });
  return out;
}

// ---------- кой пита ----------
// Жетонът на сесията се проверява срещу Supabase Auth. Анонимна заявка не
// минава — квотата към EUIPO е на кантората и не бива да е отворена за всеки.
async function requireUser(req: Request): Promise<string | null> {
  const authz = req.headers.get('Authorization') || '';
  if (!/^Bearer\s+.+/i.test(authz)) return null;

  const url = Deno.env.get('SUPABASE_URL');
  if (!url) return null;

  let apikey = '';
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}');
    apikey = keys.default || Object.values(keys)[0] as string || '';
  } catch { /* по-долу пада на празно */ }
  if (!apikey) apikey = Deno.env.get('SUPABASE_ANON_KEY') || '';

  try {
    const r = await fetch(url + '/auth/v1/user', {
      headers: { Authorization: authz, apikey },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? String(u.id) : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const userId = await requireUser(req);
  if (!userId) return json({ error: 'unauthorized' }, 401);

  let b: any = {};
  try { b = await req.json(); } catch { /* празно тяло */ }

  if (b.probe) {
    try { return json(await probe()); }
    catch (e) { return json({ error: String(e) }, 500); }
  }


  const q = String(b.q || '').trim();
  if (q.length < 2) return json({ rows: [], total: 0 });
  const lang = ['bg', 'en'].includes(String(b.lang)) ? String(b.lang) : 'bg';
  const niceClass = /^([1-9]|[1-3][0-9]|4[0-5])$/.test(String(b.niceClass || '')) ? String(b.niceClass) : '';
  const limit = Math.min(Math.max(Number(b.limit) || 25, 10), 50);

  try {
    return json(await suggest(q, lang, niceClass, limit));
  } catch (e) {
    return json({ error: String(e) }, 502);
  }
});
