// 2回目のレビューの修正:
// - 細工したIDのバックアップを読み込んでもスクリプトは動かない(IDは付け直す)。共有データに
//   直接書かれた変な値(IDや数量)も画面ではただの文字として出る。
// - 顧客機能の削除: 顧客タブ・レジの顧客欄・顧客別ランキングがない。顧客が記録された古い売上を
//   編集しても、その顧客の記録は消えたり入れ替わったりしない。
// - 売上のインポートで上書きがあるときは確認が出て、キャンセルすれば何も変わらない。
import fs from 'node:fs';
import { runTest, startServer, launchBrowser, watchErrors, IPAD, OUT_DIR } from '../lib/harness.mjs';

await runTest('safety', async (t) => {
  const server = startServer();
  const browser = await launchBrowser();
  const ctx = await browser.newContext(IPAD);
  const dialogs = [];
  const A = await ctx.newPage();
  watchErrors(t, A, 'A');
  A.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await A.goto(`${server.base}/#products`);
  await A.evaluate(() => window.ProductDB.add({ code: 'P-1', name: '本', price: 500, stock: 10, unit: '冊' }));

  // ----- a crafted id in a backup file -----
  const evil = 'x"><img src=x onerror="window.__pwned=(window.__pwned||0)+1">';
  fs.writeFileSync(`${OUT_DIR}/safety-evil.json`, JSON.stringify([{ id: evil, items: [{ productName: '本', unitPrice: 500, quantity: 1 }], createdAt: new Date().toISOString() }]));
  await A.evaluate(() => { location.hash = 'history'; });
  await A.waitForTimeout(300);
  await A.setInputFiles('#sale-import-input', `${OUT_DIR}/safety-evil.json`);
  await A.waitForTimeout(600);
  const imported = await A.evaluate(async () => (await window.SalesDB.getAll()).map((s) => s.id));
  t.eq('crafted id replaced by a new one', imported.length === 1 && /^[A-Za-z0-9_-]+$/.test(imported[0]), true);
  // and something written straight into the shared database (bypassing the import checks)
  await A.evaluate(async (bad) => {
    const { fs: f, firestore } = await window.Cloud.ready;
    await f.setDoc(f.doc(f.collection(firestore, 'workspaces', window.Cloud.getWorkspaceId(), 'sales'), bad), {
      date: '2026-11-11', note: 'direct', totalAmount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      items: [{ productId: null, productName: '<b>x</b>', unitPrice: '<img src=x onerror="window.__pwned=1">', quantity: '<img src=x onerror="window.__pwned=1">' }],
    });
  }, evil);
  const B = await ctx.newPage();
  watchErrors(t, B, 'B');
  await B.goto(`${server.base}/#history`);
  await B.waitForSelector('#sale-table-body tr');
  await B.waitForTimeout(500);
  await B.locator('#sale-table-body tr', { hasText: 'direct' }).locator('[data-action="edit"]').click();
  await B.waitForSelector('#sale-edit-banner:not([hidden])');
  await B.waitForTimeout(300);
  t.eq('no script ran (importing device / another device / editing the bad sale)', [await A.evaluate(() => window.__pwned || 0), await B.evaluate(() => window.__pwned || 0)], [0, 0]);
  t.eq('the bad sale opens with numbers coerced', await B.locator('.cart-row .cart-row__formula').innerText(), '￥0 × 0');
  await B.locator('#sale-cancel-edit-button').click();

  // ----- customers removed -----
  await A.evaluate(() => { location.hash = 'sales'; });
  await A.waitForTimeout(300);
  t.eq('no 顧客 tab', await A.locator('.tab-nav__btn[data-view="customers"]').count(), 0);
  t.eq('no customer field on the register', await A.locator('#sale-field-customer').count(), 0);
  t.eq('memo section is just メモ', await A.locator('#sale-extra summary').innerText(), 'メモ');
  t.eq('#customers falls back to the register', await A.evaluate(async () => { location.hash = 'customers'; await new Promise((r) => setTimeout(r, 200)); return document.querySelector('[data-view-panel="sales"]').hidden; }), false);
  await A.evaluate(async () => {
    const p = await window.ProductDB.findByCode('P-1');
    await window.SalesDB.add({ customerId: 7, customerName: '以前の顧客', note: '', items: [{ productId: p.id, productName: '本', unitPrice: 500, quantity: 1 }] });
  });
  await A.evaluate(() => { location.hash = 'reports'; });
  await A.waitForTimeout(300);
  t.eq('no customer ranking', await A.locator('#report-customer-ranking').count(), 0);
  await A.evaluate(() => { location.hash = 'history'; });
  await A.waitForSelector('#sale-table-body tr');
  t.eq('no 顧客 column', await A.locator('[data-view-panel="history"] thead th').allInnerTexts(), ['', '売上日時', '明細', '合計金額', '支払い', '更新日時', '操作']);
  const saleId = await A.evaluate(async () => (await window.SalesDB.getAll()).find((s) => s.customerName === '以前の顧客').id);
  await A.locator(`#sale-table-body tr[data-id="${saleId}"] [data-action="edit"]`).click();
  await A.waitForSelector('#sale-edit-banner:not([hidden])');
  await A.locator('.product-tile').first().click();
  await A.locator('#sale-submit-button').click();
  await A.waitForTimeout(400);
  t.eq('editing an old sale keeps its recorded customer', await A.evaluate(async (id) => { const s = (await window.SalesDB.getAll()).find((x) => x.id === id); return [s.customerId, s.customerName, s.totalAmount]; }, saleId), [7, '以前の顧客', 1000]);
  t.eq('new sales carry no customer fields', await A.evaluate(async () => (await window.SalesDB.getAll()).filter((s) => 'customerId' in s || 'customerName' in s).length), 1);

  // ----- cancelling the sales overwrite confirm -----
  const backup = await A.evaluate(async () => (await window.SalesDB.getAll()).filter((s) => s.note !== 'direct').map(({ pending, ...x }) => x));
  fs.writeFileSync(`${OUT_DIR}/safety-sales.json`, JSON.stringify(backup.map((s) => ({ ...s, note: '古いバックアップ' }))));
  A.removeAllListeners('dialog');
  A.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  dialogs.length = 0;
  await A.setInputFiles('#sale-import-input', `${OUT_DIR}/safety-sales.json`);
  await A.waitForTimeout(500);
  t.match('overwrite asks first', dialogs[0] || '', /^売上をインポートします: 追加 0件 \/ 上書き \d+件/);
  t.eq('cancel leaves the sales as they were', await A.evaluate(async () => (await window.SalesDB.getAll()).some((s) => s.note === '古いバックアップ')), false);

  await browser.close();
  server.close();
});
