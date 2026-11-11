// 共有コードによる商品・在庫の共有(2台の端末を同じブラウザの2ページで模す):
// 旧ローカル商品のアップロード(IDを引き継ぐ・2台目は重複しない)、もう1台に即反映、
// 2台で売っても在庫が合う(無償の共有在庫を含む)、取り消しも反映、数値IDの古い売上が
// 履歴・レポート・精算で解決できる、Firestoreのルール未反映ならローカルの商品で動き続ける。
import { runTest, startServer, launchBrowser, watchErrors, IPAD } from '../lib/harness.mjs';

await runTest('cloud-sync', async (t) => {
  const server = startServer();
  const browser = await launchBrowser();
  const ignore = /service-?worker|404|permission|falling back/i;
  const stockOf = (page, code) => page.evaluate(async (c) => (await window.ProductDB.findByCode(c))?.stock, code);
  const tileStock = (page, name) => page.locator('.product-tile', { hasText: name }).first().locator('.product-tile__stock').innerText();
  const sell = async (page, name, n, extraFree = 0) => {
    for (let i = 0; i < n; i++) await page.locator('.product-tile:not(.is-free)', { hasText: name }).first().tap();
    for (let i = 0; i < extraFree; i++) await page.locator('.product-tile.is-free', { hasText: name }).first().tap();
    await page.locator('#sale-submit-button').tap();
    await page.locator('[data-tender="exact"]').tap();
    await page.locator('#checkout-confirm').tap();
    await page.locator('[data-checkout="next"]').tap();
  };
  async function device(ctx, tag, init) {
    const page = await ctx.newPage();
    watchErrors(t, page, tag, { ignore });
    page.on('dialog', (d) => d.accept());
    await page.addInitScript(init);
    return page;
  }

  // ===== Device A (PC): the old local-only master + an old sale with a numeric productId =====
  const ctx = await browser.newContext(IPAD);
  const A = await device(ctx, 'A', () => { window.__SERVER_DELAY = 300; });
  await A.goto(`${server.base}/#settings`);
  const oldBookId = await A.evaluate(async () => {
    const P = [['P-001', '新刊 A5本', 1000, '頒布物', 30, 'Aさん', ''], ['P-001F', '新刊 A5本(無償)', 0, '頒布物', 0, 'Aさん', 'P-001'], ['P-002', '既刊セット', 2500, '頒布物', 10, 'Aさん', ''], ['P-003', 'ステッカー', 300, 'グッズ', 50, 'Bさん', '']];
    for (const [code, name, price, category, stock, payee, src] of P) await window.LocalProductDB.add({ code, name, price, category, stock, unit: '個', payee, stockSourceCode: src });
    const book = (await window.LocalProductDB.getAll()).find((p) => p.code === 'P-001');
    await window.SalesDB.add({ customerId: null, customerName: '', note: 'old', items: [{ productId: book.id, productName: book.name, unit: '個', unitPrice: 1000, quantity: 2 }] });
    return book.id;
  });
  await A.goto(`${server.base}/#sales`);
  await A.waitForSelector('#sale-product-grid .empty-state');
  t.match('register shows the upload hint', await A.locator('#sale-product-grid').innerText(), /まだクラウドに上げていない商品が4件/);
  await A.locator('.tab-nav__btn[data-view="products"]').tap();
  await A.waitForTimeout(300);
  t.eq('products view shows the upload banner', await A.locator('#product-cloud-banner').isVisible(), true);
  await A.locator('#product-cloud-banner-button').tap();
  await A.waitForTimeout(500);
  t.eq('upload toast', await A.locator('#toast').innerText(), '4件の商品をクラウドへアップロードしました。');
  t.eq('old ids kept as document ids', await A.evaluate(async () => (await window.ProductDB.getAll()).map((p) => `${p.code}=${p.id}`).sort()), [`P-001=${oldBookId}`, 'P-001F=2', 'P-002=3', 'P-003=4']);
  t.eq('banner gone after upload', await A.locator('#product-cloud-banner').isHidden(), true);

  // ===== Device B (iPad), same code: products appear without importing anything =====
  const B = await device(ctx, 'B', () => { window.__SERVER_DELAY = 300; });
  await B.goto(`${server.base}/#sales`);
  await B.waitForSelector('.product-tile');
  t.eq('B sees the products', await B.locator('.product-tile .product-tile__name').allInnerTexts(), ['新刊 A5本', '新刊 A5本(無償)', '既刊セット', 'ステッカー']);
  t.eq('B sees the shared stock', await tileStock(B, '無償'), '残り 30個共通');

  await A.locator('#product-table-body tr', { hasText: 'ステッカー' }).locator('[data-action="edit"]').tap();
  await A.fill('#field-price', '350');
  await A.click('#submit-button');
  const live = await B.waitForFunction(() => [...document.querySelectorAll('.product-tile')].some((el) => el.textContent.includes('ステッカー') && el.textContent.includes('350')), null, { timeout: 5000 }).then(() => true, () => false);
  t.eq('price edited on A appears on B without reload', live, true);

  // ===== both devices sell from the same stock (P-001 = 30) =====
  await A.locator('.tab-nav__btn[data-view="sales"]').tap();
  await A.waitForSelector('.product-tile');
  await sell(A, '新刊 A5本', 2);
  await sell(B, '新刊 A5本', 3, 1);
  await A.waitForTimeout(600);
  t.eq('stock on A after both sold (30 - 2 - 3 - 1 free)', await stockOf(A, 'P-001'), 24);
  t.eq('stock on B is the same', await stockOf(B, 'P-001'), 24);
  await B.waitForTimeout(400);
  t.eq('tiles on both devices', [await tileStock(A, '新刊 A5本'), await tileStock(B, '新刊 A5本')], ['残り 24個', '残り 24個']);

  await B.locator('.product-tile:not(.is-free)', { hasText: '既刊' }).tap();
  await B.locator('#sale-submit-button').tap();
  await B.locator('[data-tender="exact"]').tap();
  await B.locator('#checkout-confirm').tap();
  await B.locator('[data-step="done"]').waitFor({ state: 'visible' });
  t.eq('sale on B reduces stock seen on A', await stockOf(A, 'P-002'), 9);
  await B.locator('[data-checkout="void"]').tap();
  await B.waitForTimeout(500);
  t.eq('void on B restores stock seen on A', await stockOf(A, 'P-002'), 10);
  await B.locator('#cart-clear-button').tap();

  // ===== the old sale (numeric productId) still resolves =====
  await A.locator('.tab-nav__btn[data-view="reports"]').tap();
  await A.waitForSelector('.settlement-group');
  t.eq('ranking includes the old sale', await A.locator('#report-product-ranking').innerText(), '新刊 A5本\n￥7,000 ・7点\n新刊 A5本(無償)\n￥0 ・1点');
  t.eq('settlement includes the old sale', await A.locator('.settlement-group', { hasText: 'Aさん' }).locator('.settlement-group__head').innerText(), 'Aさん\n8点\n￥7,000');
  await A.locator('.tab-nav__btn[data-view="history"]').tap();
  await A.waitForSelector('#sale-table-body tr');
  await A.locator('#sale-table-body tr', { hasText: 'old' }).locator('[data-action="edit"]').tap();
  await A.waitForSelector('#sale-edit-banner:not([hidden])');
  t.eq('old sale opens for editing', await A.locator('.cart-row__name').first().innerText(), '新刊 A5本');
  await A.locator('#sale-cancel-edit-button').tap();

  t.eq('a second upload adds nothing', await A.evaluate(() => window.ProductDB.uploadLocalProducts()), { added: 0, skipped: 4, total: 4 });
  t.eq('still 4 products', await A.evaluate(async () => (await window.ProductDB.getAll()).length), 4);
  await ctx.close();

  // ===== Firestore rules not deployed: falls back to the local master and keeps working =====
  const ctx2 = await browser.newContext(IPAD);
  const D = await device(ctx2, 'D', () => { window.__SERVER_DELAY = 300; window.__DENY_COLLECTIONS = ['products']; });
  await D.goto(`${server.base}/#settings`);
  await D.evaluate(() => window.LocalProductDB.add({ code: 'L-1', name: 'ローカル商品', price: 500, stock: 5, unit: '個' }));
  await D.goto(`${server.base}/#sales`);
  await D.reload();
  await D.waitForSelector('.product-tile');
  t.eq('fallback shows local products', await D.locator('.product-tile .product-tile__name').allInnerTexts(), ['ローカル商品']);
  await sell(D, 'ローカル商品', 2);
  t.eq('fallback moves the local stock', await D.evaluate(async () => (await window.LocalProductDB.getAll())[0].stock), 3);
  await D.locator('.tab-nav__btn[data-view="products"]').tap();
  await D.waitForTimeout(300);
  t.match('fallback banner explains why', await D.locator('#product-cloud-banner').innerText(), /ルール未反映/);
  await ctx2.close();

  await browser.close();
  server.close();
});
