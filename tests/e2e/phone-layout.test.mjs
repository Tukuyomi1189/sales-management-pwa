// スマホ(幅390px)の画面: 下のタブバー、商品マスタ(一覧が先・追加/編集でフォームが開く・保存/
// 閉じるで閉じる・並び順の記憶)、レジの明細シート(開く・背景で閉じる・お会計/タブ移動で閉じる)、
// 全画面のお会計で確定ボタンが画面内、売上履歴の「…その他」、どの画面も横にはみ出さない。
import { runTest, startServer, launchBrowser, watchErrors, PHONE, IPAD } from '../lib/harness.mjs';

await runTest('phone-layout', async (t) => {
  const server = startServer();
  const browser = await launchBrowser();
  const page = await (await browser.newContext(PHONE)).newPage();
  watchErrors(t, page);
  page.on('dialog', (d) => d.accept());
  const overflowX = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  const sheetOpen = () => page.evaluate(() => document.querySelector('.register__cart').classList.contains('is-sheet-open'));

  await page.goto(`${server.base}/#products`);
  t.eq('tab bar at the bottom', await page.evaluate(() => {
    const nav = document.querySelector('.tab-nav');
    return getComputedStyle(nav).position === 'fixed' && Math.round(nav.getBoundingClientRect().bottom) === innerHeight;
  }), true);
  t.eq('form hidden at first (list first)', await page.locator('#product-form-panel').isHidden(), true);
  await page.locator('#product-add-button').tap();
  t.eq('＋ 商品を追加 opens the form', await page.locator('#product-form-panel').isVisible(), true);
  t.eq('add button hidden while the form is open', await page.locator('#product-add-button').isHidden(), true);
  await page.fill('#field-name', 'テスト本');
  await page.fill('#field-price', '700');
  await page.fill('#field-stock', '5');
  await page.locator('#submit-button').tap();
  await page.waitForTimeout(400);
  t.eq('form closes after saving', await page.locator('#product-form-panel').isHidden(), true);
  t.eq('product added', await page.locator('#product-table tbody tr').count(), 1);
  await page.locator('#product-table tbody tr button', { hasText: '編集' }).first().tap();
  await page.waitForTimeout(200);
  t.eq('編集 opens the form with the product', [await page.locator('#product-form-panel').isVisible(), await page.inputValue('#field-name')], [true, 'テスト本']);
  await page.locator('#product-form-close').tap();
  t.eq('閉じる closes the form', await page.locator('#product-form-panel').isHidden(), true);
  await page.selectOption('#product-sort-select', 'price:desc');
  t.eq('sort select is remembered', await page.evaluate(() => localStorage.getItem('sales-management-product-sort')), JSON.stringify({ key: 'price', dir: 'desc' }));
  t.eq('products: no horizontal overflow', await overflowX(), false);

  await page.evaluate(() => { location.hash = 'sales'; });
  await page.waitForSelector('.product-tile');
  await page.locator('.product-tile').first().tap();
  t.eq('checkout bar shows the total', await page.locator('#sale-total-display').innerText(), '￥700');
  await page.locator('#cart-toggle-button').tap();
  await page.waitForTimeout(150);
  t.eq('明細 opens the sheet', [await sheetOpen(), await page.evaluate(() => document.body.classList.contains('is-cart-sheet-open'))], [true, true]);
  t.eq('the button reads 閉じる', await page.locator('#cart-toggle-button').innerText(), '閉じる');
  await page.locator('#cart-sheet-backdrop').tap({ position: { x: 20, y: 120 } });
  await page.waitForTimeout(150);
  t.eq('backdrop closes the sheet', [await sheetOpen(), await page.locator('#cart-sheet-backdrop').isHidden()], [false, true]);
  await page.locator('#cart-toggle-button').tap();
  await page.waitForTimeout(100);
  await page.locator('#sale-submit-button').tap();
  await page.waitForTimeout(200);
  t.eq('お会計 closes the sheet', await sheetOpen(), false);
  const box = await page.locator('#checkout-confirm').boundingBox();
  t.ok('会計を確定 is on screen (full-screen checkout)', box && box.y + box.height <= PHONE.viewport.height, box);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.locator('#cart-toggle-button').tap();
  await page.evaluate(() => { location.hash = 'history'; });
  await page.waitForTimeout(200);
  t.eq('changing tabs closes the sheet', await page.evaluate(() => document.body.classList.contains('is-cart-sheet-open')), false);

  const more = page.locator('[data-view-panel="history"] .toolbar__more');
  t.eq('history: secondary actions hidden behind …その他', await page.locator('#sale-export-button').isHidden(), true);
  await more.tap();
  t.eq('…その他 shows them', await page.locator('#sale-export-button').isVisible(), true);
  t.eq('history: no horizontal overflow', await overflowX(), false);
  for (const view of ['reports', 'settings']) {
    await page.evaluate((v) => { location.hash = v; }, view);
    await page.waitForTimeout(300);
    t.eq(`${view}: no horizontal overflow`, await overflowX(), false);
  }

  // the phone-only controls must not appear on the iPad
  const ipad = await (await browser.newContext(IPAD)).newPage();
  watchErrors(t, ipad, 'ipad');
  await ipad.goto(`${server.base}/#sales`);
  await ipad.waitForTimeout(300);
  t.eq('iPad: phone-only controls hidden', await ipad.evaluate(() => ['#cart-toggle-button', '#product-add-button', '.toolbar__more', '.tab-nav__icon'].map((s) => getComputedStyle(document.querySelector(s)).display)), ['none', 'none', 'none', 'none']);
  t.eq('iPad: tab bar at the top', await ipad.evaluate(() => getComputedStyle(document.querySelector('.tab-nav')).position !== 'fixed'), true);

  await browser.close();
  server.close();
});
