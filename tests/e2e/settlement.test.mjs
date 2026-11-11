// 精算(精算先ごと): 売上明細に精算先を記録(後から変えても過去分は元の精算先)、精算先が
// ない古い売上は商品マスタで補う、グループ合計・総計・選んだ商品の合計・CSV・データなし期間。
import fs from 'node:fs';
import { runTest, startServer, launchBrowser, watchErrors, IPAD, OUT_DIR } from '../lib/harness.mjs';

await runTest('settlement', async (t) => {
  const server = startServer();
  const browser = await launchBrowser();
  const ctx = await browser.newContext({ ...IPAD, acceptDownloads: true });
  const page = await ctx.newPage();
  watchErrors(t, page);
  page.on('dialog', (d) => { t.errors.push('unexpected dialog: ' + d.message()); d.accept(); });
  await page.addInitScript(() => { window.__SERVER_DELAY = 100; });
  await page.goto(`${server.base}/#products`);
  const addOldSale = () => page.evaluate(async () => {
    // a sale recorded BEFORE payees existed: items carry no payee → falls back to the master
    const a = await window.ProductDB.findByCode('P-002');
    await window.SalesDB.add({ customerId: null, customerName: '', note: 'old', items: [{ productId: a.id, productName: a.name, unit: '個', unitPrice: 500, quantity: 2 }] });
  });
  await page.evaluate(async () => {
    const P = [['P-001', 'Aの新刊', 1000, 'Aさん'], ['P-002', 'Aの既刊', 500, 'Aさん'], ['P-003', 'Bの新刊', 800, 'Bさん'], ['P-004', 'Bのグッズ', 300, 'Bさん'], ['P-005', 'ステッカー', 200, '']];
    for (const [code, name, price, payee] of P) await window.ProductDB.add({ code, name, category: '', price, stock: 50, unit: '個', payee });
    await window.ProductDB.add({ code: 'P-001F', name: 'Aの新刊(無償)', price: 0, stock: 0, unit: '個', payee: 'Aさん', stockSourceCode: 'P-001' });
  });
  await addOldSale();
  await page.reload();
  await page.waitForSelector('#product-table-body tr');
  t.eq('payee suggestions', await page.locator('#payee-options option').evaluateAll((o) => o.map((x) => x.value)), ['Aさん', 'Bさん']);
  t.eq('payee shown under the name', await page.locator('#product-table-body tr', { hasText: 'Bの新刊' }).locator('.name-cell').innerText(), 'Bの新刊\n精算先: Bさん');

  const tap = async (locator, k = 1) => { for (let i = 0; i < k; i++) await locator.first().tap(); };
  const sellCart = async () => {
    await page.locator('#sale-submit-button').tap();
    await page.locator('[data-tender="exact"]').tap();
    await page.locator('#checkout-confirm').tap();
    await page.locator('[data-checkout="next"]').tap();
  };
  await page.locator('.tab-nav__btn[data-view="sales"]').tap();
  await page.waitForSelector('.product-tile');
  const t_ = (n) => page.locator('.product-tile', { hasText: n });
  await tap(page.locator('.product-tile:not(.is-free)', { hasText: 'Aの新刊' }), 2);
  await tap(t_('無償'));
  await tap(t_('Bの新刊'));
  await tap(t_('Bのグッズ'), 3);
  await tap(t_('ステッカー'), 2);
  await sellCart();
  t.eq('payee snapshot on each line', await page.evaluate(async () => (await window.SalesDB.getAll()).flatMap((s) => s.items.map((i) => `${i.productName}:${i.payee ?? '(none)'}`)).sort()),
    ['Aの既刊:(none)', 'Aの新刊(無償):Aさん', 'Aの新刊:Aさん', 'Bのグッズ:Bさん', 'Bの新刊:Bさん', 'ステッカー:'].sort());

  // change Bの新刊's payee to Cさん after it sold, then sell one more
  await page.locator('.tab-nav__btn[data-view="products"]').tap();
  await page.waitForTimeout(200);
  await page.locator('#product-table-body tr', { hasText: 'Bの新刊' }).locator('[data-action="edit"]').tap();
  await page.fill('#field-payee', 'Cさん');
  await page.click('#submit-button');
  await page.waitForTimeout(300);
  await page.locator('.tab-nav__btn[data-view="sales"]').tap();
  await page.waitForSelector('.product-tile');
  await tap(t_('Bの新刊'));
  await sellCart();
  await addOldSale();

  await page.locator('.tab-nav__btn[data-view="reports"]').tap();
  await page.waitForSelector('.settlement-group');
  t.eq('groups (past sales keep their payee; old sales use the master)', await page.locator('.settlement-group__head').allInnerTexts(), ['Aさん\n7点\n￥4,000', 'Bさん\n4点\n￥1,700', 'Cさん\n1点\n￥800', '未設定\n2点\n￥400']);
  t.eq('grand total', await page.locator('.settlement-grand').innerText(), '総計\n14点\n￥6,900');
  t.eq('Aさん rows', await page.locator('.settlement-group', { hasText: 'Aさん' }).locator('tbody tr').allInnerTexts(),
    ['\tAの新刊\nP-001\n\t￥1,000\t2\t￥2,000', '\tAの新刊(無償)\nP-001F\n\t￥0\t1\t￥0', '\tAの既刊\nP-002\n\t￥500\t4\t￥2,000']);
  await page.locator('.settlement-group', { hasText: 'Aさん' }).locator('input[data-group]').check();
  await page.locator('.settlement-group', { hasText: '未設定' }).locator('tbody input').first().check();
  t.eq('selected total', await page.locator('#settlement-selection').innerText(), '選択した商品\n4商品 ・ 9点\n￥4,400\n選択を解除');
  await page.locator('.settlement-group', { hasText: 'Aさん' }).locator('tbody input').first().uncheck();
  t.eq('group checkbox becomes indeterminate', await page.locator('.settlement-group', { hasText: 'Aさん' }).locator('input[data-group]').evaluate((e) => e.indeterminate), true);

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#settlement-csv-button')]);
  const csvPath = `${OUT_DIR}/settlement.csv`;
  await dl.saveAs(csvPath);
  const csv = fs.readFileSync(csvPath, 'utf8');
  t.match('CSV starts with a BOM and the period', csv, /^﻿集計期間: \d{4}-\d{2}-\d{2} 〜 \d{4}-\d{2}-\d{2}\r\n/);
  t.eq('CSV body', csv.split('\r\n').slice(1), [
    '精算先,商品コード,商品名,単価,数量,金額',
    'Aさん,P-001,Aの新刊,1000,2,2000', 'Aさん,P-001F,Aの新刊(無償),0,1,0', 'Aさん,P-002,Aの既刊,500,4,2000', 'Aさん 小計,,,,7,4000',
    'Bさん,P-003,Bの新刊,800,1,800', 'Bさん,P-004,Bのグッズ,300,3,900', 'Bさん 小計,,,,4,1700',
    'Cさん,P-003,Bの新刊,800,1,800', 'Cさん 小計,,,,1,800',
    '未設定,P-005,ステッカー,200,2,400', '未設定 小計,,,,2,400',
    '総計,,,,14,6900',
  ]);

  await page.selectOption('#report-preset', 'last-month');
  await page.waitForTimeout(300);
  t.eq('no sales in the period', await page.locator('#settlement-body').innerText(), '対象期間の売上がありません。');
  t.eq('selection bar hidden then', await page.locator('#settlement-selection').isHidden(), true);

  await browser.close();
  server.close();
});
