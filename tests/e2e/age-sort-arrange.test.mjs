// 年齢確認の表示(商品マスタ・レジ・カート・会計・履歴、会計は止めない)、商品マスタの並べ替え
// (見出しタップ・逆順・記憶)、レジのボタンの並び替え(マウス/指でドラッグ・記憶・カテゴリでも
// 維持・コード順に戻す)。
import { runTest, startServer, launchBrowser, watchErrors, IPAD } from '../lib/harness.mjs';

await runTest('age-sort-arrange', async (t) => {
  const server = startServer();
  const browser = await launchBrowser();
  const ctx = await browser.newContext(IPAD);
  const page = await ctx.newPage();
  watchErrors(t, page);
  page.on('dialog', (d) => { t.errors.push('unexpected dialog: ' + d.message()); d.accept(); });
  await page.goto(`${server.base}/#products`);
  await page.evaluate(async () => {
    const P = [['P-10', '新刊 A5本', 1000, '頒布物'], ['P-2', '既刊セット', 2500, '頒布物'], ['P-3', 'アクリルスタンド', 1500, 'グッズ'], ['P-1', 'ステッカー', 300, 'グッズ'], ['', 'おまけ袋', 0, '']];
    for (const [code, name, price, category] of P) await window.ProductDB.add({ code, name, price, category, stock: 20, unit: '個' });
  });
  await page.reload();
  await page.waitForSelector('#product-table-body tr');
  const names = () => page.locator('#product-table-body tr td.name-cell').evaluateAll((tds) => tds.map((td) => td.childNodes[td.querySelector('.age-tag') ? 1 : 0].textContent.trim()));
  const tileNames = () => page.locator('.product-tile .product-tile__name').allInnerTexts();
  const CODE_ORDER = ['ステッカー', '既刊セット', 'アクリルスタンド', '成人向け新刊', '新刊 A5本', 'おまけ袋'];

  // --- age-restricted product through the form ---
  await page.fill('#field-code', 'P-4');
  await page.fill('#field-name', '成人向け新刊');
  await page.fill('#field-category', '頒布物');
  await page.fill('#field-price', '800');
  await page.fill('#field-stock', '10');
  await page.check('#field-age-restricted');
  await page.click('#submit-button');
  await page.waitForTimeout(300);
  t.eq('ageRestricted saved', await page.evaluate(async () => (await window.ProductDB.findByCode('P-4')).ageRestricted), true);
  t.eq('age tag in the product list', await page.locator('#product-table-body tr', { hasText: '成人向け' }).locator('.age-tag').count(), 1);

  // --- sorting ---
  t.eq('default order: newest first', (await names())[0], '成人向け新刊');
  await page.click('.sort-btn[data-sort="price"]');
  t.eq('price ascending', await names(), ['おまけ袋', 'ステッカー', '成人向け新刊', '新刊 A5本', 'アクリルスタンド', '既刊セット']);
  await page.click('.sort-btn[data-sort="price"]');
  t.eq('price descending (tap again)', await names(), ['既刊セット', 'アクリルスタンド', '新刊 A5本', '成人向け新刊', 'ステッカー', 'おまけ袋']);
  await page.click('.sort-btn[data-sort="code"]');
  t.eq('code ascending (natural: P-2 before P-10, no code last)', await names(), CODE_ORDER);
  t.eq('aria-sort', await page.locator('th[data-sort-key="code"]').getAttribute('aria-sort'), 'ascending');
  await page.reload();
  await page.waitForSelector('#product-table-body tr');
  t.eq('sort kept after reload', await names(), CODE_ORDER);

  // --- register: age marks (display only) ---
  await page.locator('.tab-nav__btn[data-view="sales"]').tap();
  await page.waitForSelector('.product-tile');
  t.eq('register tiles in code order', await tileNames(), CODE_ORDER);
  t.eq('age tag on the tile', await page.locator('.product-tile.is-age-restricted .age-tag').innerText(), '年齢確認');
  t.eq('no age banner with an empty cart', await page.locator('#cart-age-banner').isHidden(), true);
  await page.locator('.product-tile', { hasText: '成人向け' }).tap();
  await page.locator('.product-tile', { hasText: 'ステッカー' }).tap();
  t.eq('age banner shown', await page.locator('#cart-age-banner').isVisible(), true);
  t.eq('age tag on the cart row', await page.locator('.cart-row', { hasText: '成人向け' }).locator('.age-tag').count(), 1);
  await page.locator('#sale-submit-button').tap();
  t.eq('age notice in checkout', await page.locator('#checkout-age-notice').innerText(), '年齢確認\n年齢確認が必要な商品: 成人向け新刊');
  await page.locator('[data-tender="exact"]').tap();
  t.eq('age never blocks checkout', await page.locator('#checkout-confirm').isEnabled(), true);
  await page.locator('#checkout-confirm').tap();
  await page.locator('[data-checkout="next"]').tap();
  t.eq('banner gone after the sale', await page.locator('#cart-age-banner').isHidden(), true);
  t.eq('flag saved on the sale line', await page.evaluate(async () => (await window.SalesDB.getAll())[0].items.map((i) => `${i.productName}:${i.ageRestricted ?? '-'}`)), ['成人向け新刊:true', 'ステッカー:-']);
  await page.locator('.tab-nav__btn[data-view="history"]').tap();
  await page.waitForSelector('#sale-table-body tr');
  t.eq('age tag in history', await page.locator('#sale-table-body .age-tag').count(), 1);

  // --- arrange: mouse drag the 4th button onto the 1st ---
  await page.locator('.tab-nav__btn[data-view="sales"]').tap();
  await page.waitForSelector('.product-tile');
  await page.locator('#tile-arrange-button').click();
  t.eq('arrange bar shown', await page.locator('#arrange-bar').isVisible(), true);
  t.eq('category tabs disabled while arranging', await page.locator('.category-tab').first().isDisabled(), true);
  const tiles = page.locator('.product-tile');
  const src = await tiles.nth(3).boundingBox();
  const dst = await tiles.nth(0).boundingBox();
  const srcName = await tiles.nth(3).locator('.product-tile__name').innerText();
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(dst.x + 10, dst.y + dst.height / 2, { steps: 12 });
  await page.mouse.up();
  t.eq('mouse drag moves the button to the front', (await tileNames())[0], srcName);
  t.eq('no cart add while arranging', await page.locator('.cart-row').count(), 0);

  // --- arrange: finger drag (CDP touch events) the last button to 2nd place ---
  const cdp = await ctx.newCDPSession(page);
  const last = await tiles.last().boundingBox();
  const second = await tiles.nth(1).boundingBox();
  const lastName = await tiles.last().locator('.product-tile__name').innerText();
  const tp = (x, y) => [{ x, y, id: 1 }];
  const from = { x: last.x + last.width / 2, y: last.y + last.height / 2 };
  const to = { x: second.x + 10, y: second.y + second.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(from.x, from.y) });
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(from.x + (to.x - from.x) * i / 12, from.y + (to.y - from.y) * i / 12) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  t.eq('finger drag moves the button', (await tileNames())[1], lastName);
  t.eq('the page did not scroll during the drag', await page.evaluate(() => scrollY), 0);
  await page.locator('#arrange-done-button').click();
  t.eq('arrange ends', await page.locator('#arrange-bar').isHidden(), true);
  const arranged = await tileNames();
  await page.reload();
  await page.waitForSelector('.product-tile');
  t.eq('order kept after reload', await tileNames(), arranged);
  await page.locator('.category-tab', { hasText: 'グッズ' }).tap();
  t.eq('category filter keeps the custom order', await page.locator('.product-tile:visible .product-tile__name').allInnerTexts(), arranged.filter((n) => ['ステッカー', 'アクリルスタンド'].includes(n)));
  await page.locator('.category-tab', { hasText: 'すべて' }).tap();
  await tiles.first().tap();
  t.eq('tapping adds to the cart again after arranging', await page.locator('.cart-row').count(), 1);
  await page.locator('#tile-arrange-button').click();
  await page.locator('#arrange-reset-button').click();
  await page.locator('#arrange-done-button').click();
  t.eq('コード順に戻す', await tileNames(), CODE_ORDER);

  await browser.close();
  server.close();
});
