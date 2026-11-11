// 在庫まわりの表示: レジの在庫数を隠す設定(端末ごと・再読み込み後も残る・在庫切れは出る)と、
// 開始時の在庫の記録(2台目にも反映・会計や編集では変わらない・上書き確認・キャンセル・
// 共有商品は共有元の値・エクスポートに含まれる・スマホでもはみ出さない)。
import { runTest, startServer, launchBrowser, watchErrors, IPAD_DESKTOP, PHONE } from '../lib/harness.mjs';

await runTest('stock-display', async (t) => {
  const server = startServer();
  const browser = await launchBrowser();

  // ===== hide the stock count on the register =====
  {
    const page = await (await browser.newContext(IPAD_DESKTOP)).newPage();
    watchErrors(t, page, 'hide');
    page.on('dialog', (d) => d.accept());
    await page.goto(`${server.base}/#products`);
    await page.evaluate(async () => {
      await window.ProductDB.add({ code: 'P-001', name: '新刊', price: 1000, category: '頒布物', stock: 30, unit: '個' });
      await window.ProductDB.add({ code: 'P-002', name: '既刊', price: 500, category: '頒布物', stock: 2, unit: '個' });
      await window.ProductDB.add({ code: 'P-003', name: '完売本', price: 700, category: '頒布物', stock: 0, unit: '個' });
      await window.ProductDB.add({ code: 'P-001F', name: '新刊(無償)', price: 0, category: '頒布物', stock: 0, unit: '個', stockSourceCode: 'P-001' });
    });
    await page.goto(`${server.base}/#sales`);
    await page.reload();
    await page.waitForSelector('.product-tile');
    const tiles = () => page.$$eval('.product-tile', (els) => els.map((e) => `${e.querySelector('.product-tile__name').textContent}:${e.querySelector('.product-tile__stock')?.textContent ?? '(none)'}`));
    const SHOWN = ['新刊:残り 30個', '新刊(無償):残り 30個共通', '既刊:残り 2個', '完売本:在庫切れ']; // code order
    t.eq('stock shown by default', await tiles(), SHOWN);
    for (let i = 0; i < 3; i++) await page.locator('.product-tile', { hasText: '既刊' }).click();
    t.eq('cart warning with the count', await page.locator('.cart-row__warn').allTextContents(), ['在庫不足(残り2)']);

    await page.evaluate(() => { location.hash = 'settings'; });
    await page.waitForTimeout(300);
    t.eq('setting is on by default', await page.isChecked('#show-stock-input'), true);
    await page.uncheck('#show-stock-input');
    t.eq('message when turned off', await page.textContent('#show-stock-message'), '在庫数を隠しました(「在庫切れ」は表示されます)。');
    await page.evaluate(() => { location.hash = 'sales'; });
    await page.waitForTimeout(400);
    const HIDDEN = ['新刊:(none)', '新刊(無償):共通', '既刊:(none)', '完売本:在庫切れ'];
    t.eq('count hidden, 在庫切れ and 共通 still shown', await tiles(), HIDDEN);
    t.eq('cart warning without the count', await page.locator('.cart-row__warn').allTextContents(), ['在庫不足']);
    await page.reload();
    await page.waitForSelector('.product-tile');
    t.eq('still hidden after reload', await tiles(), HIDDEN);
    await page.evaluate(() => { location.hash = 'settings'; });
    await page.waitForTimeout(300);
    t.eq('checkbox reflects the saved setting', await page.isChecked('#show-stock-input'), false);
    await page.check('#show-stock-input');
    await page.evaluate(() => { location.hash = 'sales'; });
    await page.waitForTimeout(400);
    t.eq('shown again', await tiles(), SHOWN);
  }

  // ===== opening stock (開始時の在庫) =====
  {
    const ctx = await browser.newContext(IPAD_DESKTOP);
    const dialogs = [];
    const open = async (tag) => {
      const p = await ctx.newPage();
      watchErrors(t, p, tag);
      p.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
      return p;
    };
    const A = await open('A');
    await A.goto(`${server.base}/#products`);
    await A.evaluate(async () => {
      await window.ProductDB.add({ code: 'P-001', name: '新刊', price: 1000, category: '頒布物', stock: 30, unit: '冊' });
      await window.ProductDB.add({ code: 'P-002', name: '既刊', price: 500, category: '頒布物', stock: 12, unit: '冊' });
      await window.ProductDB.add({ code: 'P-001F', name: '新刊(無償)', price: 0, category: '頒布物', stock: 0, unit: '冊', stockSourceCode: 'P-001' });
    });
    await A.reload();
    await A.waitForSelector('#product-table tbody tr');
    const rows = (pg) => pg.$$eval('#product-table tbody tr', (trs) => trs.map((tr) => `${tr.querySelector('.p-name').childNodes[0].textContent.trim()} 在庫${tr.querySelector('.p-stock .stock-badge').textContent} 開始${tr.querySelector('.p-start').textContent.replace('開始時', '').trim()}`).sort());
    t.eq('before recording', await rows(A), ['新刊 在庫30 開始-', '新刊(無償) 在庫30 開始-', '既刊 在庫12 開始-']);
    t.eq('status before recording', await A.textContent('#start-stock-status'), '未記録');
    await A.click('#start-stock-button');
    await A.waitForTimeout(400);
    t.eq('confirm before the first record', dialogs[0], '今の在庫数を「開始時の在庫」として記録します。よろしいですか?');
    t.eq('recorded', await rows(A), ['新刊 在庫30 開始30', '新刊(無償) 在庫30 開始30', '既刊 在庫12 開始12']);
    t.match('status shows when', await A.textContent('#start-stock-status'), /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2} に記録$/);

    await A.evaluate(() => { location.hash = 'sales'; });
    await A.waitForSelector('.product-tile');
    const exact = (n) => A.locator('.product-tile').filter({ has: A.locator('.product-tile__name', { hasText: new RegExp(`^${n.replace(/[()]/g, '\\$&')}$`) }) });
    for (const [n, k] of [['新刊', 3], ['新刊(無償)', 2], ['既刊', 1]]) for (let i = 0; i < k; i++) await exact(n).click();
    await A.locator('#sale-submit-button').click();
    await A.locator('[data-tender="exact"]').click();
    await A.locator('#checkout-confirm').click();
    await A.locator('[data-checkout="next"]').click();
    await A.evaluate(() => { location.hash = 'products'; });
    await A.waitForTimeout(400);
    await A.locator('#product-table tbody tr', { hasText: '既刊' }).locator('[data-action="edit"]').click();
    await A.fill('#field-price', '600');
    await A.click('#submit-button');
    await A.waitForTimeout(400);
    t.eq('sales and edits do not change the record', await rows(A), ['新刊 在庫25 開始30', '新刊(無償) 在庫25 開始30', '既刊 在庫11 開始12']);

    const B = await open('B');
    await B.goto(`${server.base}/#products`);
    await B.waitForSelector('#product-table tbody tr');
    await B.waitForTimeout(400);
    t.eq('device B sees the record', await rows(B), ['新刊 在庫25 開始30', '新刊(無償) 在庫25 開始30', '既刊 在庫11 開始12']);
    const status = await A.textContent('#start-stock-status');
    t.eq('device B sees the same time', await B.textContent('#start-stock-status'), status);
    await B.click('#start-stock-button');
    await B.waitForTimeout(600);
    t.eq('overwrite confirm names the previous record', dialogs[dialogs.length - 1], `今の在庫数を「開始時の在庫」として記録します。\n前回の記録(${status.replace(' に記録', '')})は上書きされます。よろしいですか?`);
    await A.waitForTimeout(600);
    t.eq('overwrite on B reaches A', await rows(A), ['新刊 在庫25 開始25', '新刊(無償) 在庫25 開始25', '既刊 在庫11 開始11']);

    A.removeAllListeners('dialog');
    A.on('dialog', (d) => d.dismiss());
    const before = await A.textContent('#start-stock-status');
    await A.click('#start-stock-button');
    await A.waitForTimeout(300);
    t.eq('cancel keeps the record', await A.textContent('#start-stock-status'), before);
    t.eq('export includes the record (shared products skipped)', await A.evaluate(async () => (await window.ProductDB.getAll()).filter((p) => 'startStock' in p).map((p) => `${p.code}:${p.startStock}`).sort()), ['P-001:25', 'P-002:11']);
    await ctx.close();
  }

  // ===== phone: opening stock in the cards =====
  {
    const page = await (await browser.newContext(PHONE)).newPage();
    watchErrors(t, page, 'phone');
    await page.goto(`${server.base}/#products`);
    await page.evaluate(async () => {
      await window.ProductDB.add({ code: 'P-001', name: '新刊', price: 1000, stock: 30, unit: '冊' });
      await window.ProductDB.recordStartStock();
      await window.ProductDB.adjustStock((await window.ProductDB.findByCode('P-001')).id, -4);
    });
    await page.reload();
    await page.waitForTimeout(500);
    t.eq('phone card shows 開始時', await page.locator('#product-table .p-start').innerText(), '開始時 30');
    t.eq('phone: no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }

  await browser.close();
  server.close();
});
