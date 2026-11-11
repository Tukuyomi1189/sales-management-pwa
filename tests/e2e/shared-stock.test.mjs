// 在庫の共有(無償配布など): フォームで共有商品を作る・レジでの在庫不足判定・会計/取り消し/
// 履歴の編集で共有元の在庫が動く・レポートの数量・共有元の削除/コード空欄の禁止・
// コード変更の追従・JSONの書き出し→読み込みで共有関係が保たれる。
import fs from 'node:fs';
import { runTest, startServer, launchBrowser, watchErrors, IPAD, OUT_DIR } from '../lib/harness.mjs';

await runTest('shared-stock', async (t) => {
  const server = startServer();
  const browser = await launchBrowser();
  const ctx = await browser.newContext({ ...IPAD, acceptDownloads: true });
  const page = await ctx.newPage();
  watchErrors(t, page);
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await page.addInitScript(() => { window.__SERVER_DELAY = 200; });
  await page.goto(`${server.base}/#products`);
  await page.evaluate(async () => {
    await window.ProductDB.add({ code: 'P-011', name: '新刊 A5本', category: '頒布物', price: 1000, stock: 5, unit: '冊' });
    await window.ProductDB.add({ code: 'P-020', name: 'ステッカー', category: 'グッズ', price: 300, stock: 10, unit: '枚' });
  });
  await page.reload();
  await page.waitForSelector('#product-table-body tr');
  const stocks = () => page.evaluate(async () => Object.fromEntries((await window.ProductDB.getAll()).map((p) => [p.code, p.stock])));

  // --- create the free variant through the form ---
  await page.fill('#field-code', 'P-011F');
  await page.fill('#field-name', '新刊 A5本(無償)');
  await page.fill('#field-category', '頒布物');
  await page.fill('#field-price', '0');
  t.eq('source options', await page.locator('#field-stock-source option').allInnerTexts(), ['共有しない', 'P-011 新刊 A5本(在庫 5)', 'P-020 ステッカー(在庫 10)']);
  await page.selectOption('#field-stock-source', 'P-011');
  t.eq('stock field disabled when linked', await page.locator('#field-stock').isDisabled(), true);
  await page.click('#submit-button');
  await page.waitForTimeout(300);
  const saved = await page.evaluate(async () => (await window.ProductDB.findByCode('P-011F')));
  t.eq('saved link', [saved.stockSourceCode, saved.price, saved.stock], ['P-011', 0, 0]);
  t.eq('list shows the source stock', await page.locator('#product-table-body tr', { hasText: '無償' }).locator('td.num').nth(1).innerText(), '5\nP-011 と共有');
  t.eq('summary counts shared stock once', await page.locator('#summary-stats').innerText(), '登録件数: 3件 / 在庫合計: 15 / 在庫評価額: ￥8,000');

  // --- register ---
  await page.locator('.tab-nav__btn[data-view="sales"]').tap();
  await page.waitForSelector('.product-tile');
  t.eq('tiles', await page.locator('.product-tile').allInnerTexts(), ['新刊 A5本\n￥1,000\n残り 5冊', '新刊 A5本(無償)\n無償\n残り 5冊共通', 'ステッカー\n￥300\n残り 10枚']);
  const paid = page.locator('.product-tile:not(.is-free)', { hasText: '新刊' });
  const free = page.locator('.product-tile.is-free', { hasText: '新刊' });
  for (let i = 0; i < 4; i++) await paid.tap();
  await free.tap(); await free.tap();
  t.eq('shortage judged on the shared stock', await page.locator('.cart-row__warn').allInnerTexts(), ['在庫不足(残り5)', '在庫不足(残り5・共通)']);
  t.eq('total', await page.locator('#sale-total-display').innerText(), '￥4,000');
  await page.locator('#sale-submit-button').tap();
  t.eq('checkout shortage notice', await page.locator('#checkout-warning').innerText(), '在庫数を超えています: 新刊 A5本(このまま会計できます)');
  await page.locator('[data-tender="exact"]').tap();
  await page.locator('#checkout-confirm').tap();
  await page.locator('[data-step="done"]').waitFor({ state: 'visible' });
  await page.waitForTimeout(200);
  t.eq('sale moves the source stock only', await stocks(), { 'P-011': -1, 'P-011F': 0, 'P-020': 10 });
  await page.locator('[data-checkout="void"]').tap();
  await page.waitForTimeout(300);
  t.eq('void restores it', await stocks(), { 'P-011': 5, 'P-011F': 0, 'P-020': 10 });

  await page.locator('#cart-clear-button').tap();
  for (let i = 0; i < 3; i++) await paid.tap();
  await free.tap();
  await page.locator('#sale-submit-button').tap();
  await page.locator('[data-tender="add"][data-amount="5000"]').tap();
  await page.locator('#checkout-confirm').tap();
  await page.locator('[data-checkout="next"]').tap();
  await page.waitForTimeout(300);
  t.eq('tiles after 3 paid + 1 free', await page.locator('.product-tile .product-tile__stock').allInnerTexts(), ['残り 1冊', '残り 1冊共通', '残り 10枚']);

  // --- history edit keeps the shared stock consistent: remove the free one ---
  await page.locator('.tab-nav__btn[data-view="history"]').tap();
  await page.waitForSelector('#sale-table-body tr');
  await page.locator('#sale-table-body button[data-action="edit"]').first().tap();
  await page.waitForSelector('#sale-edit-banner:not([hidden])');
  await page.locator('.cart-row', { hasText: '無償' }).locator('[data-action="dec"]').tap();
  await page.locator('#sale-submit-button').tap();
  await page.waitForFunction(() => location.hash === '#history');
  await page.waitForTimeout(300);
  t.eq('edit returns the free one to the source', (await stocks())['P-011'], 2);

  await page.locator('.tab-nav__btn[data-view="reports"]').tap();
  await page.waitForTimeout(400);
  t.eq('report ranking', await page.locator('#report-product-ranking').innerText(), '新刊 A5本\n￥3,000 ・3点');

  // --- product master protections ---
  await page.locator('.tab-nav__btn[data-view="products"]').tap();
  await page.waitForTimeout(300);
  const sourceRow = () => page.locator('#product-table-body tr', { hasText: '新刊 A5本' }).filter({ hasNotText: '無償' });
  await sourceRow().locator('[data-action="delete"]').tap();
  t.eq('deleting a shared source is refused', await page.locator('#toast').innerText(), '「新刊 A5本(無償)」がこの商品の在庫を共有しているため削除できません。先にそちらの共有を解除するか削除してください。');
  t.eq('no confirm dialog for a refused delete', dialogs.length, 0);
  await sourceRow().locator('[data-action="edit"]').tap();
  t.eq('a source cannot itself share', await page.locator('#field-stock-source').isDisabled(), true);
  await page.fill('#field-code', 'BOOK-1');
  await page.click('#submit-button');
  await page.waitForTimeout(300);
  t.eq('renaming the source code updates its dependents', await page.evaluate(async () => (await window.ProductDB.findByCode('P-011F')).stockSourceCode), 'BOOK-1');
  await sourceRow().locator('[data-action="edit"]').tap();
  await page.fill('#field-code', '');
  await page.click('#submit-button');
  t.eq('clearing the source code is refused', await page.locator('#form-message').innerText(), '「新刊 A5本(無償)」がこの商品の在庫を共有しているため、商品コードを空にできません。');
  await page.click('#cancel-edit-button');

  // --- JSON round trip (ids change, the link by code survives) ---
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-button')]);
  const file = `${OUT_DIR}/shared-products-export.json`;
  await dl.saveAs(file);
  t.eq('export has 3 products', JSON.parse(fs.readFileSync(file, 'utf8')).length, 3);
  await page.evaluate(() => window.ProductDB.clear());
  await page.setInputFiles('#import-input', file);
  await page.waitForTimeout(500);
  const after = await page.evaluate(async () => {
    const f = await window.ProductDB.findByCode('P-011F');
    const owner = await window.ProductDB.getStockOwner(f.id);
    return { freeSource: f.stockSourceCode, ownerCode: owner.code, ownerStock: owner.stock };
  });
  t.eq('link survives export → import', after, { freeSource: 'BOOK-1', ownerCode: 'BOOK-1', ownerStock: 2 });

  await browser.close();
  server.close();
});
