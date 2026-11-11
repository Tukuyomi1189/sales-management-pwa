// お預かりボタンの金額設定(設定画面): 全角数字・￥・読点・重複・並び順の正規化、空はエラー、
// 会計画面への反映、再読み込み後も残る、初期値に戻す、最大8個。
import { runTest, startServer, launchBrowser, watchErrors, IPAD } from '../lib/harness.mjs';

await runTest('tender-settings', async (t) => {
  const server = startServer();
  const browser = await launchBrowser();
  const page = await (await browser.newContext(IPAD)).newPage();
  watchErrors(t, page);
  await page.goto(`${server.base}/#products`);
  await page.evaluate(() => window.ProductDB.add({ code: 'P-1', name: 'コーヒー', price: 350, stock: 99 }));
  await page.goto(`${server.base}/#sales`);
  await page.waitForSelector('.product-tile');
  const quick = () => page.locator('#tender-quick .tender-btn').allInnerTexts();
  const change = async () => [await page.locator('#checkout-change-label').innerText(), await page.locator('#checkout-change').innerText()];

  await page.locator('.product-tile').tap();
  await page.locator('#sale-submit-button').tap();
  t.eq('default buttons', await quick(), ['ちょうど', '+￥1,000', '+￥5,000', '+￥10,000']);
  await page.locator('[data-checkout="back"]').tap();

  // Typing right after tapping the tab must survive the hashchange that arrives a moment later
  // (it used to re-run the screen's setup and put the saved amounts back).
  const kept = await page.evaluate(async () => {
    document.querySelector('.tab-nav__btn[data-view="settings"]').click();
    const input = document.getElementById('tender-amounts-input');
    input.value = '777';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100)); // let the hashchange event fire
    return input.value;
  });
  t.eq('typing right after switching tabs is not wiped', kept, '777');
  await page.locator('.tab-nav__btn[data-view="sales"]').tap();
  await page.locator('.tab-nav__btn[data-view="settings"]').tap();
  t.eq('settings shows the defaults', await page.inputValue('#tender-amounts-input'), '1000, 5000, 10000');
  await page.fill('#tender-amounts-input', '１０００、300 ￥500, 300');
  t.eq('live preview (normalized, sorted, de-duplicated)', await page.locator('#tender-amounts-preview').innerText(), 'ちょうど\n+￥300\n+￥500\n+￥1,000');
  await page.locator('#tender-settings-form button[type="submit"]').tap();
  t.eq('saved value', await page.inputValue('#tender-amounts-input'), '300, 500, 1000');
  t.eq('saved message', await page.locator('#tender-settings-message').innerText(), '保存しました。次の会計から反映されます。');
  await page.fill('#tender-amounts-input', 'abc');
  await page.locator('#tender-settings-form button[type="submit"]').tap();
  t.eq('no amounts → error', await page.locator('#tender-settings-message').innerText(), '金額を1つ以上入力してください(例: 300, 500, 1000)。');

  await page.locator('.tab-nav__btn[data-view="sales"]').tap();
  await page.locator('#sale-submit-button').tap();
  t.eq('checkout uses the new buttons', await quick(), ['ちょうど', '+￥300', '+￥500', '+￥1,000']);
  await page.locator('[data-tender="add"][data-amount="300"]').tap();
  t.eq('300 for 350 → 不足 50', await change(), ['不足', '￥50']);
  await page.locator('[data-tender="add"][data-amount="500"]').tap();
  t.eq('+500 → お釣り 450', await change(), ['お釣り', '￥450']);
  await page.locator('[data-checkout="back"]').tap();

  await page.reload();
  await page.waitForSelector('.product-tile');
  await page.locator('.product-tile').tap();
  await page.locator('#sale-submit-button').tap();
  t.eq('kept after reload', await quick(), ['ちょうど', '+￥300', '+￥500', '+￥1,000']);
  await page.locator('[data-checkout="back"]').tap();

  await page.locator('.tab-nav__btn[data-view="settings"]').tap();
  await page.locator('#tender-amounts-reset').tap();
  t.eq('reset to defaults', await page.inputValue('#tender-amounts-input'), '1000, 5000, 10000');
  await page.fill('#tender-amounts-input', '10 20 30 40 50 60 70 80 90 100');
  t.eq('at most 8 amounts (+ ちょうど)', await page.locator('#tender-amounts-preview .tender-chip').count(), 9);

  await browser.close();
  server.close();
});
