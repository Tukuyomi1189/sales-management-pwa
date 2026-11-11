// お会計画面の閉じ方。iPad: 入力中は外側をタップしても閉じない(入力が消えない)。完了画面は
// 外側のタップ/クリックで閉じ、注文画面に戻る。スマホ(全画面): 完了画面の余白タップで閉じ、
// お釣りや文字のタップでは閉じない。
import { runTest, startServer, launchBrowser, watchErrors, IPAD, PHONE } from '../lib/harness.mjs';

await runTest('checkout-close', async (t) => {
  const server = startServer();
  const browser = await launchBrowser();

  async function open(opts) {
    const page = await (await browser.newContext(opts)).newPage();
    watchErrors(t, page, `${opts.viewport.width}px`);
    await page.goto(`${server.base}/#products`);
    await page.evaluate(() => window.ProductDB.add({ code: 'P-1', name: 'コーヒー', price: 350, stock: 99 }));
    await page.goto(`${server.base}/#sales`);
    await page.waitForSelector('.product-tile');
    return page;
  }
  const isOpen = (page) => page.locator('#checkout-dialog').evaluate((d) => d.open);
  const sellToDone = async (page) => {
    await page.locator('.product-tile').tap();
    await page.locator('#sale-submit-button').tap();
    await page.locator('[data-tender="exact"]').tap();
    await page.locator('#checkout-confirm').tap();
    await page.locator('[data-step="done"]').waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
  };

  // ===== iPad =====
  {
    const page = await open(IPAD);
    await page.locator('.product-tile').tap();
    await page.locator('#sale-submit-button').tap();
    await page.locator('[data-tender="add"]').first().tap();
    await page.touchscreen.tap(40, 780);
    t.eq('iPad tender step: backdrop tap keeps it open', await isOpen(page), true);
    t.eq('iPad tender step: the amount is kept', await page.locator('#checkout-received').innerText(), '￥1,000');
    const box = await page.locator('#checkout-dialog').boundingBox();
    await page.touchscreen.tap(box.x + 20, box.y + box.height - 120);
    t.eq('iPad tender step: empty space inside keeps it open', await isOpen(page), true);
    await page.locator('[data-tender="exact"]').tap();
    await page.locator('#checkout-confirm').tap();
    await page.locator('[data-step="done"]').waitFor({ state: 'visible' });
    await page.locator('#checkout-done-change').tap();
    t.eq('iPad done: tapping the change keeps it open', await isOpen(page), true);
    await page.touchscreen.tap(40, 780);
    await page.waitForTimeout(150);
    t.eq('iPad done: backdrop tap closes', await isOpen(page), false);
    t.eq('iPad done: back to an empty order', await page.locator('.cart-row').count(), 0);

    await sellToDone(page);
    await page.mouse.click(1150, 60);
    await page.waitForTimeout(150);
    t.eq('iPad done: mouse click outside closes', await isOpen(page), false);
    t.eq('both sales saved', await page.evaluate(async () => (await window.SalesDB.getAll()).length), 2);
  }

  // ===== phone (full-screen dialog) =====
  {
    const page = await open(PHONE);
    await sellToDone(page);
    await page.locator('#checkout-done-change').tap();
    t.eq('phone done: tapping the change keeps it open', await isOpen(page), true);
    await page.locator('.checkout-done__title').tap();
    t.eq('phone done: tapping the title keeps it open', await isOpen(page), true);
    await page.touchscreen.tap(195, 120);
    await page.waitForTimeout(200);
    t.eq('phone done: tapping the empty top closes', await isOpen(page), false);
    await sellToDone(page);
    await page.touchscreen.tap(195, 800);
    await page.waitForTimeout(200);
    t.eq('phone done: tapping the empty bottom closes', await isOpen(page), false);
    await sellToDone(page);
    await page.locator('[data-checkout="next"]').tap();
    await page.waitForTimeout(200);
    t.eq('phone done: 次のお客様 still works', await isOpen(page), false);
    await page.locator('.product-tile').tap();
    await page.locator('#sale-submit-button').tap();
    await page.locator('[data-tender="add"]').first().tap();
    await page.touchscreen.tap(195, 120);
    t.eq('phone tender step: empty tap keeps it open', await isOpen(page), true);
  }

  await browser.close();
  server.close();
});
