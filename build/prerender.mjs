/* Сглобяване на scaleyourmark.com за търсачките.
 *
 * Сайтът е един файл (index.html), който рисува страниците с JavaScript.
 * Търсачките и визитките в социалните мрежи четат обаче готовия HTML, затова
 * тук всяка страница се „отваря“ веднъж в jsdom — точно както в браузъра — и
 * резултатът се записва като отделен файл:
 *
 *   dist/index.html                      ← „Защо ScaleYourMark“ (BG)
 *   dist/targovska-marka/index.html      ← „За търговската марка“ (BG)
 *   dist/en/about-trademarks/index.html  ← същата страница на английски
 *   dist/novini/<статия>/index.html      ← всяка статия от POSTS
 *   dist/rakovodstva/<стъпка>/index.html ← всяко ръководство
 *   dist/404.html, dist/sitemap.xml, robots.txt, .htaccess, изображенията
 *
 * Във всеки файл скриптът на сайта е същият. В браузъра той се зарежда и
 * поема страницата, тоест посетителят не вижда разлика — само търсачката
 * получава текста веднага.
 *
 * Адресите, заглавията и описанията НЕ се пишат тук. Те идват от самия
 * index.html (SLUG, SEO, seoRoutes), за да има едно място за промени.
 *
 * Пускане:  cd build && npm ci && node prerender.mjs
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = join(ROOT, 'dist');
const SITE = 'https://scaleyourmark.com';
const SRC  = readFileSync(join(ROOT, 'index.html'), 'utf8');

/* Неща, които браузърът има, а jsdom — не. Нужни са само колкото кодът на
   страницата да не спре; нищо от тях не влиза в готовия HTML. */
function stubs(win) {
  win.scrollTo = () => {};
  win.Element.prototype.scrollIntoView = function () {};
  win.matchMedia = win.matchMedia || (q => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  for (const k of ['IntersectionObserver', 'ResizeObserver']) {
    win[k] = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } };
  }
  win.HTMLCanvasElement.prototype.getContext = () => null;
  win.fetch = () => Promise.reject(new Error('offline prerender'));
  win.alert = win.confirm = () => {};
}

function render(path) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/Not implemented/.test(e.message)) errors.push(e.message) });
  vc.on('error', (...a) => errors.push(a.join(' ')));
  const dom = new JSDOM(SRC, {
    url: SITE + path,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse: stubs,
  });
  const { window } = dom;
  const doc = window.document;
  const app = doc.getElementById('app');
  if (!app || !app.innerHTML.trim()) {
    throw new Error(`${path}: страницата е празна след рисуване${errors.length ? ' — ' + errors.join(' | ') : ''}`);
  }
  // Състоянието на сайта не бива да остава „замразено“ в готовия файл.
  doc.getElementById('drawer').innerHTML = '';
  doc.getElementById('drawer').classList.remove('open');
  doc.getElementById('scrim').classList.remove('on');
  const html = '<!doctype html>\n' + doc.documentElement.outerHTML + '\n';
  const info = {
    title: doc.title,
    lang: doc.documentElement.lang,
    canonical: doc.querySelector('link[rel="canonical"]')?.href,
    robots: doc.querySelector('meta[name="robots"]')?.content,
    h1: doc.querySelectorAll('#app h1').length,
    words: app.textContent.trim().split(/\s+/).length,
    errors,
  };
  window.close();
  return { html, info };
}

function write(rel, content) {
  const f = join(OUT, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, content);
}

/* ---- 1. списъкът с адреси — от самия сайт ---- */
const probe = new JSDOM(SRC, { url: SITE + '/', runScripts: 'dangerously', pretendToBeVisual: true,
  virtualConsole: new VirtualConsole(), beforeParse: stubs });
const routes = probe.window.seoRoutes();
probe.window.close();

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/* ---- 2. страниците ---- */
const report = [];
let failed = 0;
for (const r of routes) {
  const { html, info } = render(r.path);
  const want = SITE + r.path;
  const problems = [...info.errors];
  if (info.canonical !== want) problems.push(`canonical ${info.canonical} ≠ ${want}`);
  if (info.lang !== r.lang) problems.push(`lang ${info.lang} ≠ ${r.lang}`);
  if (r.index && info.h1 !== 1) problems.push(`${info.h1} заглавия h1`);
  if (problems.length) failed++;
  write(join(r.path, 'index.html'), html);
  report.push({ path: r.path, title: info.title, words: info.words, kb: Math.round(Buffer.byteLength(html) / 1024), problems });
}

/* ---- 3. страница за несъществуващ адрес ---- */
write('404.html', render('/404/').html);

/* ---- 4. sitemap.xml с двете езикови версии на всяка страница ---- */
const pair = p => {             // BG ↔ EN адрес на същата страница
  const i = routes.findIndex(x => x.path === p);
  const n = routes.length / 2;
  return i < n ? [routes[i], routes[i + n]] : [routes[i - n], routes[i]];
};
const today = new Date().toISOString().slice(0, 10);
const urls = routes.filter(r => r.index).map(r => {
  const [bg, en] = pair(r.path);
  return `  <url>
    <loc>${SITE}${r.path}</loc>
    <lastmod>${r.lastmod || today}</lastmod>
    <xhtml:link rel="alternate" hreflang="bg" href="${SITE}${bg.path}"/>
    <xhtml:link rel="alternate" hreflang="en" href="${SITE}${en.path}"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}${bg.path}"/>
  </url>`;
});
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join('\n')}
</urlset>
`);

/* ---- 5. файловете, които се качват както са ---- */
for (const f of ['robots.txt', '.htaccess']) copyFileSync(join(ROOT, f), join(OUT, f));
const st = join(ROOT, 'static');
if (existsSync(st)) for (const f of readdirSync(st)) copyFileSync(join(st, f), join(OUT, f));

/* ---- 6. отчет ---- */
for (const r of report) {
  console.log(`${r.problems.length ? '✗' : '✓'} ${r.path.padEnd(52)} ${String(r.words).padStart(5)} думи  ${r.kb} KB  ${r.title}`);
  for (const p of r.problems) console.log(`    ! ${p}`);
}
console.log(`\n${report.length} страници, ${urls.length} в sitemap.xml${failed ? `, ${failed} с забележки` : ''}.`);
if (failed && process.argv.includes('--strict')) process.exit(1);
