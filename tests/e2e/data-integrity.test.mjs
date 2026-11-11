// 数字が狂う不具合の再発防止(改善計画 プルリクエスト1):
// 1. 商品の編集で、他の端末で売れた分の在庫が戻らない(在庫数は差分で反映)
// 2. 自分のバックアップ(JSON)を何度インポートしても二重にならない(売上はID、商品はコードで上書き)
// 3. 売上を編集して合計が変わったら、お預かり・お釣りの記録を消して支払い方法だけ残す
import fs from 'node:fs';
import { runTest, startServer, launchBrowser, watchErrors, IPAD_DESKTOP, OUT_DIR } from '../lib/harness.mjs';

await runTest('data-integrity', async (t) => {
  const server = startServer();
  const browser = await launchBrowser();
  const ctx = await browser.newContext({ ...IPAD_DESKTOP, acceptDownloads: true });
  const dialogs = [];
  const mk = async (tag) => {
    const p = await ctx.newPage();
    watchErrors(t, p, tag);
    p.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
    return p;
  };
  const stockOf = (pg, code) => pg.evaluate(async (c) => (await window.ProductDB.findByCode(c)).stock, code);
  const sell = async (pg, k, name = '新刊') => {
    for (let i = 0; i < k; i++) await pg.locator('.product-tile', { hasText: name }).first().click();
    await pg.locator('#sale-submit-button').click();
    await pg.locator('[data-tender="exact"]').click();
    await pg.locator('#checkout-confirm').click();
    await pg.locator('[data-checkout="next"]').click();
  };
  const editRow = (pg, name) => pg.locator('#product-table tbody tr')
    .filter({ has: pg.locator('.p-name', { hasText: new RegExp(`^${name.replace(/[()]/g, '\\$&')}(?!\\()`) }) })
    .first().locator('[data-action="edit"]');

  const A = await mk('A');
  await A.goto(`${server.base}/#products`);
  await A.evaluate(async () => {
    await window.ProductDB.add({ code: 'P-001', name: '新刊', price: 1000, category: '頒布物', stock: 30, unit: '冊' });
    await window.ProductDB.add({ code: 'P-001F', name: '新刊(無償)', price: 0, category: '頒布物', stock: 0, unit: '冊', stockSourceCode: 'P-001' });
  });
  await A.reload();
  await A.waitForSelector('#product-table tbody tr');
  const B = await mk('B');
  await B.goto(`${server.base}/#sales`);
  await B.waitForSelector('.product-tile');

  // ---- 1. product edit vs. sales on another device ----
  await editRow(A, '新刊').click();
  await sell(B, 3);
  await A.waitForTimeout(400);
  t.eq('1a: B sold 3', await stockOf(A, 'P-001'), 27);
  await A.fill('#field-price', '1200');
  await A.click('#submit-button');
  await A.waitForTimeout(400);
  t.eq('1b: editing only the price keeps 27', await stockOf(B, 'P-001'), 27);
  t.eq('1b: the price is saved', await B.evaluate(async () => (await window.ProductDB.findByCode('P-001')).price), 1200);
  await editRow(A, '新刊').click(); // the form shows 27
  await sell(B, 2); // now 25
  await A.waitForTimeout(400);
  await A.fill('#field-stock', '32'); // +5 from what the form showed
  await A.click('#submit-button');
  await A.waitForTimeout(400);
  t.eq('1c: 27→32 typed while B sold 2 → 30', await stockOf(B, 'P-001'), 30);
  await editRow(A, '新刊(無償)').click();
  await A.fill('#field-price', '0');
  await A.click('#submit-button');
  await A.waitForTimeout(400);
  t.eq('1d: editing a shared product leaves the source stock alone', await stockOf(B, 'P-001'), 30);

  // ---- 3. sale edit: お預かり / お釣り ----
  await B.evaluate(() => { location.hash = 'history'; });
  await B.waitForSelector('#sale-table-body tr');
  const saleId = await B.evaluate(async () => (await window.SalesDB.getAll()).find((x) => x.items[0].quantity === 2).id);
  const sale = () => B.evaluate(async (id) => { const s = (await window.SalesDB.getAll()).find((x) => x.id === id); return { total: s.totalAmount, payment: s.payment }; }, saleId);
  t.eq('3a: payment before editing', (await sale()).payment, { method: 'cash', received: 2400, change: 0 });
  await B.locator(`#sale-table-body tr[data-id="${saleId}"] [data-action="edit"]`).click();
  await B.waitForSelector('.product-tile');
  await B.evaluate(() => {
    const el = document.getElementById('sale-field-note');
    el.closest('details')?.setAttribute('open', '');
    el.value = 'メモだけ';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await B.locator('#sale-submit-button').click();
  await B.waitForTimeout(500);
  t.eq('3b: a memo-only edit keeps 預/釣', (await sale()).payment, { method: 'cash', received: 2400, change: 0 });
  await B.locator(`#sale-table-body tr[data-id="${saleId}"] [data-action="edit"]`).click();
  await B.waitForSelector('.product-tile');
  await B.locator('.product-tile', { hasText: '新刊' }).first().click();
  await B.locator('#sale-submit-button').click();
  await B.waitForTimeout(500);
  t.eq('3c: total changed → payment method only', await sale(), { total: 3600, payment: { method: 'cash' } });
  t.eq('3c: history shows only 現金', await B.locator(`#sale-table-body tr[data-id="${saleId}"] .h-payment`).innerText(), '現金');

  // ---- 2. importing your own backups ----
  const salesBackup = await B.evaluate(async () => (await window.SalesDB.getAll()).map(({ pending, ...x }) => x));
  const salesSum = () => B.evaluate(async () => { const all = await window.SalesDB.getAll(); return [all.length, all.reduce((s, x) => s + x.totalAmount, 0)]; });
  const salesBefore = await salesSum();
  fs.writeFileSync(`${OUT_DIR}/integrity-sales.json`, JSON.stringify(salesBackup));
  dialogs.length = 0;
  for (let i = 0; i < 2; i++) { await B.setInputFiles('#sale-import-input', `${OUT_DIR}/integrity-sales.json`); await B.waitForTimeout(600); }
  t.eq('2a: sales count / total unchanged after importing twice', await salesSum(), salesBefore);
  t.match('2a: confirm before overwriting sales', dialogs[0] || '', new RegExp(`^売上をインポートします: 追加 0件 / 上書き ${salesBackup.length}件\\n同じ売上は、ファイルの内容で上書きされます`));
  t.eq('2a: toast reports overwritten', await B.textContent('#toast'), `売上をインポートしました: 追加 0件 / 上書き ${salesBackup.length}件(在庫数は変更されません)。`);
  fs.writeFileSync(`${OUT_DIR}/integrity-sales-noid.json`, JSON.stringify(salesBackup.map(({ id, ...x }) => x).slice(0, 1)));
  await B.setInputFiles('#sale-import-input', `${OUT_DIR}/integrity-sales-noid.json`);
  await B.waitForTimeout(600);
  t.eq('2b: a sale without an id is added', (await salesSum())[0], salesBefore[0] + 1);

  await B.evaluate(() => { location.hash = 'products'; });
  await B.waitForSelector('#product-table tbody tr');
  const prodState = () => B.evaluate(async () => (await window.ProductDB.getAll()).map((p) => `${p.code}:${p.stock}:${p.price}`).sort());
  const prodBefore = await prodState();
  fs.writeFileSync(`${OUT_DIR}/integrity-products.json`, JSON.stringify(await B.evaluate(() => window.ProductDB.getAll())));
  dialogs.length = 0;
  for (let i = 0; i < 2; i++) { await B.setInputFiles('#import-input', `${OUT_DIR}/integrity-products.json`); await B.waitForTimeout(600); }
  t.eq('2c: products unchanged after importing twice', await prodState(), prodBefore);
  t.eq('2c: confirm before overwriting', dialogs[0], '商品をインポートします: 追加 0件 / 上書き 2件\n同じ商品コードの商品は、在庫数も含めてファイルの内容で上書きされます。よろしいですか?');
  await B.evaluate(async () => window.ProductDB.adjustStock((await window.ProductDB.findByCode('P-001')).id, -10));
  await B.setInputFiles('#import-input', `${OUT_DIR}/integrity-products.json`);
  await B.waitForTimeout(600);
  t.eq('2d: importing the backup restores it', await prodState(), prodBefore);
  B.removeAllListeners('dialog');
  B.on('dialog', (d) => d.dismiss());
  await B.evaluate(async () => window.ProductDB.adjustStock((await window.ProductDB.findByCode('P-001')).id, -1));
  const beforeCancel = await prodState();
  await B.setInputFiles('#import-input', `${OUT_DIR}/integrity-products.json`);
  await B.waitForTimeout(600);
  t.eq('2e: cancelling the confirm changes nothing', await prodState(), beforeCancel);
  B.removeAllListeners('dialog');
  B.on('dialog', (d) => { dialogs.push(`UNEXPECTED ${d.message()}`); d.accept(); });
  fs.writeFileSync(`${OUT_DIR}/integrity-products-new.json`, JSON.stringify([{ code: 'P-009', name: '新グッズ', price: 500, stock: 4 }]));
  await B.setInputFiles('#import-input', `${OUT_DIR}/integrity-products-new.json`);
  await B.waitForTimeout(600);
  t.eq('2f: a new code is added', (await prodState()).includes('P-009:4:500'), true);
  t.eq('2f: no confirm when only adding', dialogs.some((d) => d.startsWith('UNEXPECTED')), false);

  await browser.close();
  server.close();
});
