// レジの在庫数を隠す設定(端末ごと・再読み込み後も残る・在庫切れと共通は出る・カートの在庫不足は数を出さない)。
// 開始時在庫はイベント機能に移った(e2e/events.test.mjs)。
import { runTest, startServer, launchBrowser, watchErrors, IPAD_DESKTOP } from '../lib/harness.mjs';

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

  await browser.close();
  server.close();
});
