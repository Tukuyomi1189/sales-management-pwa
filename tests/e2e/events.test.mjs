// イベント単位(改善計画 項目5): 商品マスタで開始(開始時在庫を記録)・締める(終了時在庫)、
// 2台目の端末にも反映、開催中の売上にイベントを記録、レジの「開催中」表示、レポートでイベントを
// 選ぶと売上・精算・在庫の照合がそのイベントだけになる(イベントのない古い売上は開催日で含める)、
// 名前・日付の変更、過去のイベントの登録、削除、Firestore のルール未反映時は端末内で動く、スマホ表示。
import fs from 'node:fs';
import { runTest, startServer, launchBrowser, watchErrors, IPAD, PHONE, OUT_DIR } from '../lib/harness.mjs';

await runTest('events', async (t) => {
  const server = startServer();
  const browser = await launchBrowser();
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  const slash = today.replaceAll('-', '/');

  const ctx = await browser.newContext({ ...IPAD, acceptDownloads: true });
  const dialogs = [];
  const device = async (tag) => {
    const p = await ctx.newPage();
    watchErrors(t, p, tag);
    p.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
    await p.addInitScript(() => { window.__SERVER_DELAY = 100; });
    return p;
  };
  const exactTile = (p, name) => p.locator('.product-tile').filter({ has: p.locator('.product-tile__name', { hasText: new RegExp(`^${name.replace(/[()]/g, '\\$&')}$`) }) });
  const sell = async (p, names) => {
    for (const n of names) await exactTile(p, n).tap();
    await p.locator('#sale-submit-button').tap();
    await p.locator('[data-tender="exact"]').tap();
    await p.locator('#checkout-confirm').tap();
    await p.locator('[data-checkout="next"]').tap();
  };
  const fillForm = async (p, { name, start, end }) => {
    if (name != null) await p.fill('#event-name', name);
    if (start) await p.fill('#event-start-date', start);
    if (end) await p.fill('#event-end-date', end);
  };

  const A = await device('A');
  await A.goto(`${server.base}/#products`);
  await A.evaluate(async () => {
    await window.ProductDB.add({ code: 'P-001', name: '新刊', price: 1000, stock: 30, unit: '冊', payee: 'Aさん' });
    await window.ProductDB.add({ code: 'P-001F', name: '新刊(無償)', price: 0, stock: 0, unit: '冊', stockSourceCode: 'P-001' });
    await window.ProductDB.add({ code: 'P-002', name: '既刊', price: 500, stock: 10, unit: '冊' });
    // a sale from before the event started (same day, no eventId) → NOT part of the event
    const p = await window.ProductDB.findByCode('P-002');
    await window.SalesDB.add({ customerId: null, customerName: '', note: 'before events', items: [{ productId: p.id, productName: p.name, unit: '冊', unitPrice: 500, quantity: 1 }] });
  });
  await A.reload();
  await A.waitForSelector('#product-table tbody tr');
  t.eq('no event at first', [await A.textContent('#event-status'), await A.locator('#event-start-button').isVisible(), await A.locator('#event-close-button').isHidden()], ['開催中のイベントはありません', true, true]);

  // ----- start -----
  await A.click('#event-start-button');
  t.eq('start dialog: today by default', [await A.inputValue('#event-start-date'), await A.inputValue('#event-end-date')], [today, today]);
  await A.click('#event-form-submit');
  t.eq('start dialog: name required', await A.textContent('#event-form-message'), 'イベント名を入力してください。');
  await fillForm(A, { name: 'コミティア150' });
  await A.click('#event-form-submit');
  await A.waitForTimeout(300);
  t.eq('dialog closed', await A.locator('#event-dialog').evaluate((d) => d.open), false);
  t.match('status shows the open event', await A.textContent('#event-status'), new RegExp(`開催中 コミティア150\\(${slash}\\)・${slash} \\d{2}:\\d{2} に開始`));
  t.eq('close button replaces start', [await A.locator('#event-start-button').isHidden(), await A.locator('#event-close-button').isVisible()], [true, true]);
  t.eq('開始時在庫 column (shared product shows its source)', await A.$$eval('#product-table tbody tr', (trs) => trs.map((tr) => `${tr.querySelector('.p-code').textContent}:${tr.querySelector('.p-start').textContent.replace('開始時', '').trim()}`).sort()), ['P-001:30', 'P-001F:30', 'P-002:9']);

  const B = await device('B');
  await B.goto(`${server.base}/#sales`);
  await B.waitForSelector('.product-tile');
  t.eq('device B: register shows the open event', await B.locator('#register-event-pill').innerText(), `開催中: コミティア150(${slash})`);

  // ----- sales during the event -----
  await sell(B, ['新刊', '新刊', '新刊(無償)']);
  await A.evaluate(() => { location.hash = 'sales'; });
  await A.waitForSelector('.product-tile');
  await sell(A, ['既刊']);
  const eventId = await A.evaluate(() => window.EventDB.currentSync().id);
  t.eq('sales during the event carry its id (both devices)', await A.evaluate(async () => (await window.SalesDB.getAll()).map((s) => s.eventId ?? '-').sort()), ['-', eventId, eventId]);
  // someone fixes a count by hand during the event → shows as a difference
  await A.evaluate(async () => window.ProductDB.adjustStock((await window.ProductDB.findByCode('P-002')).id, -1));

  // ----- close -----
  await A.evaluate(() => { location.hash = 'products'; });
  await A.waitForTimeout(200);
  dialogs.length = 0;
  await A.click('#event-close-button');
  await A.waitForTimeout(300);
  t.match('close asks first and mentions unsynced sales', dialogs[0] || '', /^「コミティア150」を締めます。いまの在庫数を「終了時在庫」として記録します。[\s\S]*未同期[\s\S]*締めますか\?$/);
  const closed = await A.evaluate((id) => window.EventDB.get(id), eventId);
  t.eq('start / end stock recorded', [Object.values(closed.startStock).sort((a, b) => a - b), Object.values(closed.endStock).sort((a, b) => a - b)], [[9, 30], [7, 27]]);
  t.ok('closedAt recorded', closed.closedAt, closed.closedAt);
  await B.waitForTimeout(300);
  t.eq('device B: pill gone after closing', await B.locator('#register-event-pill').isHidden(), true);
  await sell(B, ['新刊']);
  t.eq('a sale after closing has no event', await B.evaluate(async () => (await window.SalesDB.getAll()).filter((s) => !s.eventId).length), 2);

  // ----- reports -----
  await A.evaluate(() => { location.hash = 'reports'; });
  await A.waitForTimeout(400);
  const option = await A.$eval('#report-preset', (s) => [...s.querySelectorAll('optgroup[label="イベント"] option')].map((o) => [o.value, o.textContent]));
  t.eq('event listed in the period select', option, [[`event:${eventId}`, `コミティア150(${slash})`]]);
  await A.selectOption('#report-preset', `event:${eventId}`);
  await A.waitForTimeout(400);
  t.match('event detail', await A.locator('#report-event-text').innerText(), new RegExp(`^コミティア150\\(${slash}\\)・${slash} \\d{2}:\\d{2} 開始 〜 ${slash} \\d{2}:\\d{2} 締め$`));
  t.eq('only sales between 開始 and 締め (not the ones before / after on the same day)', await A.locator('#report-stat-tiles .stat-tile__value').nth(1).innerText(), '2件');
  t.eq('settlement is labelled with the event', (await A.locator('#settlement-period').innerText()).startsWith(`イベント: コミティア150(${slash})`), true);
  const rows = await A.$$eval('#reconcile-body tbody tr', (trs) => trs.map((tr) => [...tr.cells].map((c) => c.innerText.replace(/\n/g, ' '))));
  t.eq('stock check (free copies count on their source; the hand fix shows as −1)', rows, [
    ['新刊 P-001', '30', '3', '27', '0'],
    ['既刊 P-002', '9', '1', '7', '-1'],
  ]);
  const [dl] = await Promise.all([A.waitForEvent('download'), A.click('#reconcile-csv-button')]);
  await dl.saveAs(`${OUT_DIR}/events-stock-check.csv`);
  t.eq('stock check CSV', fs.readFileSync(`${OUT_DIR}/events-stock-check.csv`, 'utf8').split('\r\n'), [
    `﻿イベント: コミティア150(${slash})`, '商品コード,商品名,開始時在庫,売れた数,終了時在庫,差', 'P-001,新刊,30,3,27,0', 'P-002,既刊,9,1,7,-1',
  ]);

  // ----- edit / past event / delete -----
  await A.click('#report-event-edit');
  t.eq('edit dialog prefilled', await A.inputValue('#event-name'), 'コミティア150');
  await fillForm(A, { name: 'コミティア150(東京)' });
  await A.click('#event-form-submit');
  await A.waitForTimeout(400);
  t.match('renamed', await A.locator('#report-event-text').innerText(), /^コミティア150\(東京\)/);

  await A.click('#report-event-add-past');
  await fillForm(A, { name: '夏の即売会', start: '2026-08-15', end: '2026-08-14' });
  await A.click('#event-form-submit');
  t.eq('end before start is refused', await A.textContent('#event-form-message'), '終了日は開始日以降にしてください。');
  await fillForm(A, { end: '2026-08-16' });
  await A.click('#event-form-submit');
  await A.waitForTimeout(400);
  t.match('past event is selected after registering', await A.locator('#report-event-text').innerText(), /^夏の即売会\(2026\/08\/15〜08\/16\)・過去のイベント\(在庫の記録なし\)$/);
  t.eq('past event: dates in the inputs', [await A.inputValue('#report-from'), await A.inputValue('#report-to')], ['2026-08-15', '2026-08-16']);
  t.match('past event: no stock check', await A.locator('#reconcile-note').innerText(), /開始時在庫の記録がないため、照合できません/);
  dialogs.length = 0;
  await A.click('#report-event-delete');
  await A.waitForTimeout(300);
  t.match('delete asks first', dialogs[0] || '', /^イベント「夏の即売会」を削除します。売上と在庫は変わりません/);
  t.eq('after deleting: back to 今月', await A.inputValue('#report-preset'), 'this-month');
  t.eq('only one event left', await A.evaluate(async () => (await window.EventDB.getAll()).length), 1);
  await A.click('#report-event-add-past');
  await fillForm(A, { name: '今日の過去イベント', start: today, end: today });
  await A.click('#event-form-submit');
  await A.waitForTimeout(400);
  t.eq('past event takes sales by date (only those without another event: before 開始 + after 締め)', await A.locator('#report-stat-tiles .stat-tile__value').nth(1).innerText(), '2件');
  await ctx.close();

  // ----- Firestore rules not published yet: events stay on this device -----
  {
    const page = await (await browser.newContext(IPAD)).newPage();
    watchErrors(t, page, 'deny', { ignore: /service-?worker|404|permission/i });
    page.on('dialog', (d) => d.accept());
    await page.addInitScript(() => { window.__SERVER_DELAY = 50; window.__DENY_COLLECTIONS = ['events']; });
    await page.goto(`${server.base}/#products`);
    await page.evaluate(() => window.ProductDB.add({ code: 'P-1', name: '本', price: 500, stock: 5, unit: '冊' }));
    await page.reload();
    await page.waitForTimeout(400);
    t.match('local-only note shown', await page.locator('#event-local-note').innerText(), /この端末だけに保存.*ルール未反映/);
    await page.click('#event-start-button');
    await fillForm(page, { name: '端末内イベント' });
    await page.click('#event-form-submit');
    await page.waitForTimeout(300);
    t.match('starting still works locally', await page.textContent('#event-status'), /端末内イベント/);
    await page.evaluate(() => { location.hash = 'sales'; });
    await page.waitForSelector('.product-tile');
    await page.locator('.product-tile').tap();
    await page.locator('#sale-submit-button').tap();
    await page.locator('[data-tender="exact"]').tap();
    await page.locator('#checkout-confirm').tap();
    await page.locator('[data-checkout="next"]').tap();
    t.eq('sales keep working and carry the local event', await page.evaluate(async () => (await window.SalesDB.getAll())[0].eventId === window.EventDB.currentSync().id), true);
  }

  // ----- phone -----
  {
    const page = await (await browser.newContext(PHONE)).newPage();
    watchErrors(t, page, 'phone');
    page.on('dialog', (d) => d.accept());
    await page.goto(`${server.base}/#products`);
    await page.evaluate(async () => {
      await window.ProductDB.add({ code: 'P-1', name: '本', price: 500, stock: 5, unit: '冊' });
      await window.EventDB.start({ name: 'スマホのイベント', startDate: '2026-11-11', endDate: '2026-11-12' });
    });
    await page.reload();
    await page.waitForTimeout(400);
    t.eq('phone products: no overflow', await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    t.eq('phone: close button is full width', await page.evaluate(() => { const b = document.getElementById('event-close-button'); return Math.round(b.getBoundingClientRect().width) === Math.round(b.parentElement.getBoundingClientRect().width); }), true);
    await page.evaluate(() => { location.hash = 'reports'; });
    await page.waitForTimeout(300);
    const v = await page.$eval('#report-preset', (s) => [...s.options].find((o) => o.value.startsWith('event:')).value);
    await page.selectOption('#report-preset', v);
    await page.waitForTimeout(300);
    t.eq('phone reports with an event: no overflow', await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    t.eq('open event in the select is marked', await page.$eval('#report-preset', (s) => s.selectedOptions[0].textContent), '[開催中] スマホのイベント(2026/11/11〜11/12)');
  }

  await browser.close();
  server.close();
});
