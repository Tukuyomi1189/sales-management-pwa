// レジ: カテゴリ・バーコード・在庫不足表示・単価変更・全取消/元に戻す・お会計(不足/お釣り/
// キーボード入力)・取り消し・売上履歴・編集。iPad など各サイズでのレイアウト(画面に収まる・
// 横にはみ出さない・タップで画面が動かない)とオフラインでの会計も確認する。
import { runTest, startServer, launchBrowser, watchErrors, IPAD, PHONE, OUT_DIR } from '../lib/harness.mjs';

await runTest('register', async (t) => {
  const server = startServer();
  const browser = await launchBrowser();

  async function setup(opts, delay = 1500) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    watchErrors(t, page, `${opts.viewport.width}px`);
    page.on('dialog', (d) => { t.errors.push('unexpected dialog: ' + d.message()); d.accept(); });
    await page.addInitScript((d) => { window.__SERVER_DELAY = d; }, delay);
    await page.goto(`${server.base}/#products`);
    await page.evaluate(async () => {
      const P = [['ブレンドコーヒー', 'ドリンク', 300], ['カフェラテ', 'ドリンク', 350], ['アイスティー', 'ドリンク', 400], ['オレンジジュース', 'ドリンク', 350],
        ['チーズケーキ', 'フード', 450], ['ガトーショコラ', 'フード', 500], ['クッキー', 'フード', 200], ['サンドイッチ', 'フード', 600], ['マフィン', 'フード', 350], ['スコーン', 'フード', 300],
        ['新刊 A5本', '頒布物', 1000], ['既刊セット', '頒布物', 2500], ['アクリルスタンド', 'グッズ', 1500], ['ステッカー', 'グッズ', 300], ['おまけ袋', '', 0]];
      for (let i = 0; i < P.length; i++) {
        await window.ProductDB.add({ code: `P-${String(i + 1).padStart(3, '0')}`, name: P[i][0], category: P[i][1], price: P[i][2], stock: i === 4 ? 1 : i === 13 ? 0 : 30, unit: '個' });
      }
    });
    await page.goto(`${server.base}/#sales`);
    await page.waitForSelector('.product-tile');
    return { ctx, page };
  }
  const tile = (page, name) => page.locator('.product-tile', { hasText: name });
  const stockOf = (page, name) => page.evaluate(async (n) => (await window.ProductDB.getAll()).find((p) => p.name === n).stock, name);

  // ===== iPad Pro 11" landscape =====
  {
    const { ctx, page } = await setup(IPAD);
    t.eq('touch device is detected (pointer: coarse)', await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
    t.eq('register fits the screen (no page scroll)', await page.evaluate(() => document.documentElement.scrollHeight - innerHeight), 0);
    t.eq('category tabs', await page.locator('.category-tab').allInnerTexts(), ['すべて', 'グッズ', 'ドリンク', 'フード', '頒布物', 'その他']);

    await tile(page, 'ブレンドコーヒー').tap(); await tile(page, 'ブレンドコーヒー').tap();
    await tile(page, '新刊').tap(); await tile(page, 'チーズケーキ').tap(); await tile(page, 'チーズケーキ').tap(); // stock 1 → shortage
    await page.locator('.category-tab', { hasText: 'グッズ' }).tap();
    t.eq('category filter', await page.locator('.product-tile:visible .product-tile__name').allInnerTexts(), ['アクリルスタンド', 'ステッカー']);
    await page.locator('.category-tab', { hasText: 'すべて' }).tap();

    await page.fill('#sale-product-search', 'p-012');
    await page.press('#sale-product-search', 'Enter');
    t.eq('barcode (code + Enter) clears the search box', await page.inputValue('#sale-product-search'), '');
    t.eq('cart rows', await page.locator('.cart-row .cart-row__name').allInnerTexts(), ['ブレンドコーヒー', '新刊 A5本', 'チーズケーキ', '既刊セット']);
    t.eq('cart total', await page.locator('#sale-total-display').innerText(), '￥5,000');
    t.eq('shortage warning', await page.locator('.cart-row__warn').allInnerTexts(), ['在庫不足(残り1)']);
    t.eq('sold-out tile', await tile(page, 'ステッカー').innerText(), 'ステッカー\n￥300\n在庫切れ');

    await page.locator('.cart-row', { hasText: '既刊セット' }).locator('.cart-row__main').tap();
    await page.locator('.cart-row', { hasText: '既刊セット' }).locator('.line-item-price').fill('2000');
    t.eq('unit price change updates the total', await page.locator('#sale-total-display').innerText(), '￥4,500');

    await page.locator('#cart-clear-button').tap();
    t.eq('全取消 empties the cart', await page.locator('.cart-row').count(), 0);
    await page.locator('.toast__action').tap();
    t.eq('元に戻す restores the cart', await page.locator('.cart-row').count(), 4);

    await page.locator('#sale-submit-button').tap();
    t.eq('checkout dialog opens', await page.locator('#checkout-dialog').evaluate((d) => d.open), true);
    t.eq('payment method row hidden (cash only)', await page.locator('#checkout-methods').isHidden(), true);
    t.eq('確定 disabled before tender', await page.locator('#checkout-confirm').isDisabled(), true);
    t.eq('checkout shortage notice', await page.locator('#checkout-warning').innerText(), '在庫数を超えています: チーズケーキ(このまま会計できます)');
    for (let i = 0; i < 3; i++) await page.locator('[data-tender="add"][data-amount="1000"]').tap();
    t.eq('不足 while short', [await page.locator('#checkout-change-label').innerText(), await page.locator('#checkout-change').innerText()], ['不足', '￥1,500']);
    await page.locator('[data-tender="add"][data-amount="5000"]').tap();
    t.eq('お釣り when enough', [await page.locator('#checkout-change-label').innerText(), await page.locator('#checkout-change').innerText()], ['お釣り', '￥3,500']);
    const t0 = Date.now();
    await page.locator('#checkout-confirm').tap();
    await page.locator('[data-step="done"]').waitFor({ state: 'visible' });
    const ms = Date.now() - t0;
    t.ok('確定 → done without waiting for the server (< 1s)', ms < 1000, `${ms}ms`);
    t.eq('done: change', await page.locator('#checkout-done-change').innerText(), '￥3,500');
    t.eq('done: detail', await page.locator('#checkout-done-detail').innerText(), '合計 ￥4,500(6点) / お預かり ￥8,000');

    await page.locator('[data-checkout="void"]').tap();
    await page.waitForTimeout(200);
    t.eq('取り消し puts the items back', await page.locator('.cart-row').count(), 4);
    t.eq('取り消し restores the stock', await stockOf(page, 'ブレンドコーヒー'), 30);

    await page.locator('#sale-submit-button').tap();
    await page.keyboard.type('10000');
    t.eq('hardware keyboard enters the tender', await page.locator('#checkout-received').innerText(), '￥10,000');
    await page.keyboard.press('Backspace');
    await page.locator('[data-tender="exact"]').tap();
    await page.keyboard.press('Enter');
    await page.locator('[data-step="done"]').waitFor({ state: 'visible' });
    t.eq('ちょうど → change 0', await page.locator('#checkout-done-change').innerText(), '￥0');
    await page.keyboard.press('Enter'); // 次のお客様
    t.eq('Enter on done closes the dialog', await page.locator('#checkout-dialog').evaluate((d) => d.open), false);
    t.eq('cart empty after sale', await page.locator('.cart-row').count(), 0);
    t.eq('stock reduced by the sale', await stockOf(page, 'ブレンドコーヒー'), 28);

    for (const n of ['カフェラテ', 'アイスティー', 'オレンジ', 'チーズ', 'ガトー', 'クッキー', 'サンド', 'マフィン', 'スコーン', '新刊', '既刊']) await tile(page, n).tap();
    const list = await page.evaluate(() => {
      const l = document.getElementById('line-items-body');
      const last = l.lastElementChild.getBoundingClientRect();
      const box = l.getBoundingClientRect();
      return { scrolled: l.scrollTop > 0, lastVisible: last.bottom <= box.bottom + 1, pageY: scrollY };
    });
    t.eq('long cart scrolls inside the list, newest row visible', list, { scrolled: true, lastVisible: true, pageY: 0 });
    await page.locator('#cart-clear-button').tap();
    t.eq('tile order stays (code order) after sales', await page.locator('.product-tile__name').first().innerText(), 'ブレンドコーヒー');
    await page.screenshot({ path: `${OUT_DIR}/register-ipad.png` });

    await page.locator('.tab-nav__btn[data-view="history"]').tap();
    await page.waitForSelector('#sale-table-body tr');
    const row = await page.locator('#sale-table-body tr').first().innerText();
    t.match('history row', row, /\tブレンドコーヒー × 2, 新刊 A5本 × 1, チーズケーキ × 2, 既刊セット × 1\t￥4,500\t現金\n預 ￥4,500 \/ 釣 ￥0/);
    t.eq('just-saved sale is highlighted', await page.locator('#sale-table-body tr.is-just-saved').count(), 1);

    await page.locator('#sale-table-body button[data-action="edit"]').first().tap();
    await page.waitForSelector('#sale-edit-banner:not([hidden])');
    t.eq('edit loads the sale into the register', await page.locator('.cart-row').count(), 4);
    t.eq('button says 更新する while editing', await page.locator('#sale-submit-button').innerText(), '更新する');
    await tile(page, 'クッキー').tap();
    await page.locator('#sale-submit-button').tap();
    await page.waitForFunction(() => location.hash === '#history');
    await page.waitForTimeout(300);
    t.eq('edited total in history', await page.locator('#sale-table-body tr').first().locator('td.num').innerText(), '￥4,700');
    await page.locator('.tab-nav__btn[data-view="settings"]').tap();
    t.eq('settings shows the workspace code', await page.locator('#workspace-code-display').innerText(), 'TESTCODE');
    await ctx.close();
  }

  // ===== other sizes, offline (the server never acknowledges) =====
  for (const [name, opts, cols, fitsScreen] of [
    ['iPad 11" portrait', { ...IPAD, viewport: { width: 834, height: 1194 } }, 3, true],
    ['iPad 13" landscape', { ...IPAD, viewport: { width: 1366, height: 1024 } }, 5, true],
    ['iPad 11" dark', { ...IPAD, colorScheme: 'dark' }, 4, true],
    ['phone', PHONE, 2, false],
  ]) {
    const { ctx, page } = await setup(opts, Infinity);
    const y0 = await page.evaluate(() => scrollY);
    for (const n of ['カフェラテ', 'ガトーショコラ', '新刊', 'アクリル']) await tile(page, n).tap();
    const y1 = await page.evaluate(() => scrollY);
    t.eq(`${name}: no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    t.eq(`${name}: product columns`, await page.evaluate(() => getComputedStyle(document.getElementById('sale-product-grid')).gridTemplateColumns.split(' ').length), cols);
    if (fitsScreen) {
      t.eq(`${name}: fits the screen`, await page.evaluate(() => document.documentElement.scrollHeight - innerHeight), 0);
      t.eq(`${name}: tapping does not move the page`, y1 - y0, 0);
    }
    await page.locator('#sale-submit-button').tap();
    await page.locator('[data-tender="add"][data-amount="10000"]').tap();
    const t1 = Date.now();
    await page.locator('#checkout-confirm').tap();
    await page.locator('[data-step="done"]').waitFor({ state: 'visible', timeout: 3000 });
    const ms = Date.now() - t1;
    t.ok(`${name}: offline checkout completes immediately`, ms < 1500, `${ms}ms`);
    await ctx.close();
  }

  await browser.close();
  server.close();
});
