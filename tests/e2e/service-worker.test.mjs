// 本物の service worker での確認: インストールされて画面を管理する、オフラインでもアプリが
// 開いて会計できる、docs/ (操作マニュアルのPDF) はキャッシュせずPDFとして開く。
// Firebase SDK (gstatic) はスタブを返す(テストをネットワークに依存させない)。
import { runTest, startServer, launchBrowser, watchErrors, IPAD } from '../lib/harness.mjs';

await runTest('service-worker', async (t) => {
  const server = startServer({ serviceWorker: true });
  const browser = await launchBrowser();
  const ctx = await browser.newContext(IPAD);
  await ctx.route('https://www.gstatic.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  const page = await ctx.newPage();
  watchErrors(t, page, 'app', { ignore: /404|Failed to load resource/i });
  page.setDefaultTimeout(15000);

  await page.goto(`${server.base}/#products`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  t.eq('service worker controls the page', await page.evaluate(() => !!navigator.serviceWorker.controller), true);
  await page.evaluate(() => window.ProductDB.add({ code: 'P-1', name: 'コーヒー', price: 350, stock: 10, unit: '個' }));

  // offline: the whole app comes from the cache
  await ctx.setOffline(true);
  const nav = await page.goto(`${server.base}/?offline#sales`); // a real navigation (not just a hash change)
  t.eq('offline navigation answered by the service worker', nav?.fromServiceWorker(), true);
  await page.waitForSelector('.product-tile');
  await page.locator('.product-tile').tap();
  await page.locator('#sale-submit-button').tap();
  await page.locator('[data-tender="exact"]').tap();
  await page.locator('#checkout-confirm').tap();
  await page.locator('[data-step="done"]').waitFor({ state: 'visible', timeout: 3000 });
  t.eq('offline checkout works', await page.locator('#checkout-done-change').innerText(), '￥0');
  await ctx.setOffline(false);

  // docs/: never cached, opens as a PDF (not the app shell)
  const pdfPath = '/docs/%E6%93%8D%E4%BD%9C%E3%83%9E%E3%83%8B%E3%83%A5%E3%82%A2%E3%83%AB.pdf';
  const fetched = await page.evaluate(async (p) => { const r = await fetch(p); return { status: r.status, type: r.headers.get('content-type') }; }, pdfPath);
  t.eq('manual PDF fetch returns the PDF', fetched, { status: 200, type: 'application/pdf' });
  const tab = await ctx.newPage();
  const seen = [];
  tab.on('response', (r) => { if (r.url().includes('/docs/')) seen.push({ type: r.headers()['content-type'], fromSW: r.fromServiceWorker() }); });
  await tab.goto(`${server.base}${pdfPath}`, { waitUntil: 'commit' }).catch(() => {}); // headless may treat a PDF as a download
  await tab.waitForTimeout(1000);
  t.eq('opening the manual link shows the PDF, not the app', seen[0], { type: 'application/pdf', fromSW: false });
  const cachedDocs = await page.evaluate(async () => {
    let n = 0;
    for (const key of await caches.keys()) for (const req of await (await caches.open(key)).keys()) if (req.url.includes('/docs/')) n++;
    return n;
  });
  t.eq('docs/ is never cached', cachedDocs, 0);

  await browser.close();
  server.close();
});
