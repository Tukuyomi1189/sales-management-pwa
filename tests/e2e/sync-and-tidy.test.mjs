// 改善計画 プルリクエスト3:
// - 「未同期 ◯件」: クラウドに送れていない売上があるあいだ、どの画面でも右上に件数が出る。
//   送れたら消える。押すと売上履歴へ。
// - 在庫の増減(会計)では商品の更新日時が変わらない(商品マスタの並びが会計で入れ替わらない)。
// - 旧ローカル売上のアップロードは端末内の番号(1, 2, 3…)をIDに使わない(他の端末の売上を上書きしない)。
// - manifest.json: 画面の向きを固定しない、説明が今の機能に合っている。
import { runTest, startServer, launchBrowser, watchErrors, IPAD, PHONE } from '../lib/harness.mjs';

await runTest('sync-and-tidy', async (t) => {
  const server = startServer();
  const browser = await launchBrowser();
  const sellOne = async (page) => {
    await page.locator('.product-tile').first().tap();
    await page.locator('#sale-submit-button').tap();
    await page.locator('[data-tender="exact"]').tap();
    await page.locator('#checkout-confirm').tap();
    await page.locator('[data-checkout="next"]').tap();
  };
  async function open(opts, delay) {
    const page = await (await browser.newContext(opts)).newPage();
    watchErrors(t, page, `${opts.viewport.width}px`);
    page.on('dialog', (d) => d.accept());
    await page.addInitScript((d) => { window.__SERVER_DELAY = d; }, delay);
    await page.goto(`${server.base}/#products`);
    await page.evaluate(async () => {
      await window.ProductDB.add({ code: 'P-1', name: '新刊', price: 1000, stock: 30, unit: '冊' });
      await window.ProductDB.add({ code: 'P-2', name: '既刊', price: 500, stock: 30, unit: '冊' });
    });
    await page.goto(`${server.base}/#sales`);
    await page.waitForSelector('.product-tile');
    return page;
  }
  const pill = (page) => page.locator('#sync-status');

  // ===== offline: the server never acknowledges =====
  {
    const page = await open(IPAD, Infinity);
    t.eq('no pill while nothing is waiting', await pill(page).isHidden(), true);
    await sellOne(page);
    t.eq('pill after an offline sale', [await pill(page).isVisible(), await pill(page).innerText()], [true, '未同期 1件']);
    await sellOne(page);
    t.eq('count goes up', await pill(page).innerText(), '未同期 2件');
    await page.evaluate(() => { location.hash = 'products'; });
    await page.waitForTimeout(200);
    t.eq('pill visible on other screens too', await pill(page).isVisible(), true);
    await pill(page).click();
    await page.waitForTimeout(200);
    t.eq('tapping the pill opens the history', await page.evaluate(() => location.hash), '#history');
    t.eq('history marks the same sales', await page.locator('#sale-table-body .sync-pill').count(), 2);
    await page.reload();
    await page.waitForTimeout(400);
    t.eq('still counted after reopening the app', await pill(page).innerText(), '未同期 2件');
  }

  // ===== online: the pill disappears once the cloud has the sale =====
  {
    const page = await open(PHONE, 600);
    const before = await page.evaluate(async () => (await window.ProductDB.findByCode('P-1')).updatedAt);
    await sellOne(page);
    t.eq('phone: pill while sending', await pill(page).isVisible(), true);
    await page.waitForTimeout(1200);
    t.eq('phone: pill gone once sent', await pill(page).isHidden(), true);
    t.eq('phone: header does not overflow with the pill', await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const after = await page.evaluate(async () => {
      const p = await window.ProductDB.findByCode('P-1');
      return { stock: p.stock, updatedAt: p.updatedAt };
    });
    t.eq('a sale moves the stock but not the product\'s updatedAt', after, { stock: 29, updatedAt: before });
    await page.evaluate(() => { location.hash = 'products'; });
    await page.waitForTimeout(300);
    t.eq('product list (newest edit first) is not reshuffled by the sale', await page.locator('#product-table .p-code').allInnerTexts(), ['P-2', 'P-1']);
  }

  // ===== legacy local sales upload gets new ids =====
  {
    const page = await open(IPAD, 100);
    await page.evaluate(async () => {
      // another device already uploaded its own legacy sale "1"
      await window.SalesDB.bulkImport([{ id: '1', customerName: '', note: 'other device', items: [{ productId: null, productName: '他の端末', unitPrice: 100, quantity: 1 }], createdAt: '2026-01-01T00:00:00.000Z' }]);
      // this device's own legacy IndexedDB sale with the same number
      await withStore('sales', 'readwrite', (store) => requestToPromise(store.add({ customerName: '', note: 'this device', items: [{ productId: null, productName: 'この端末', unitPrice: 200, quantity: 1 }], createdAt: '2026-01-02T00:00:00.000Z', date: '2026-01-02' })));
    });
    t.eq('legacy sale has id 1 on this device', await page.evaluate(async () => (await window.LegacyLocalSalesDB.getAll()).map((s) => s.id)), [1]);
    await page.evaluate(() => { location.hash = 'settings'; });
    await page.waitForTimeout(200);
    await page.locator('#workspace-migrate-button').click();
    await page.waitForTimeout(500);
    t.eq('upload message', await page.locator('#workspace-message').innerText(), '1件のローカル売上データをアップロードしました。');
    t.eq('the other device\'s sale is not overwritten', await page.evaluate(async () => (await window.SalesDB.getAll()).map((s) => s.note).sort()), ['other device', 'this device']);
  }

  // ===== manifest =====
  {
    const page = await (await browser.newContext(IPAD)).newPage();
    const manifest = await (await page.request.get(`${server.base}/manifest.json`)).json();
    t.eq('manifest: no orientation lock', 'orientation' in manifest, false);
    t.match('manifest: description', manifest.description, /POSレジ/);
  }

  await browser.close();
  server.close();
});
