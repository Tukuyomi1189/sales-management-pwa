/* イベント: 「イベントを開始 / 締める」(商品マスタ画面)、レジの「開催中」表示、イベントの
 * 入力ダイアログ(開始・過去のイベント・名前と日付の変更)、レポートの「在庫の照合」。
 * データは EventDB (js/db.js)。
 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => window.App.escapeHtml(s);

  // ---------- Dates ----------

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  const datesText = (e) => window.EventDB.datesText(e);

  const timeText = (iso) => window.App.formatDateTime(iso);

  // ---------- The event dialog (start / past event / edit) ----------

  const dialog = $('event-dialog');
  const form = $('event-form');
  const titleEl = $('event-dialog-title');
  const nameInput = $('event-name');
  const startInput = $('event-start-date');
  const endInput = $('event-end-date');
  const hintEl = $('event-form-hint');
  const messageEl = $('event-form-message');
  const submitButton = $('event-form-submit');
  let onSubmit = null;

  function openForm({ title, submitLabel, hint, initial, submit }) {
    titleEl.textContent = title;
    submitButton.textContent = submitLabel;
    hintEl.textContent = hint || '';
    hintEl.hidden = !hint;
    messageEl.textContent = '';
    messageEl.classList.remove('is-error');
    nameInput.value = initial?.name || '';
    startInput.value = initial?.startDate || today();
    endInput.value = initial?.endDate || startInput.value;
    onSubmit = submit;
    dialog.showModal();
    nameInput.focus();
  }

  // Moving the start date past the end date drags the end along (1-day events stay 1 day).
  startInput.addEventListener('change', () => {
    if (!endInput.value || endInput.value < startInput.value) endInput.value = startInput.value;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!onSubmit || submitButton.disabled) return;
    submitButton.disabled = true;
    try {
      await onSubmit({ name: nameInput.value, startDate: startInput.value, endDate: endInput.value });
      dialog.close();
    } catch (err) {
      messageEl.textContent = err.message;
      messageEl.classList.add('is-error');
    } finally {
      submitButton.disabled = false;
    }
  });

  $('event-form-cancel').addEventListener('click', () => dialog.close());

  // ---------- 商品マスタ: start / close ----------

  const statusEl = $('event-status');
  const startButton = $('event-start-button');
  const closeButton = $('event-close-button');
  const localNote = $('event-local-note');
  const registerPill = $('register-event-pill');

  function renderPanel() {
    const current = window.EventDB.currentSync();
    if (current) {
      statusEl.innerHTML = `<span class="event-pill event-pill--inline">開催中</span> <strong>${esc(current.name)}</strong>(${esc(datesText(current))})・${esc(timeText(current.startedAt))} に開始`;
    } else {
      statusEl.textContent = '開催中のイベントはありません';
    }
    startButton.hidden = !!current;
    closeButton.hidden = !current;
    const local = !window.EventDB.isCloud();
    localNote.hidden = !local;
    localNote.textContent = local
      ? `イベントはこの端末だけに保存しています(${window.EventDB.fallbackReason()})。Firestoreのルールを公開すると、他の端末とも共有されます。`
      : '';

    registerPill.hidden = !current;
    registerPill.textContent = current ? `開催中: ${current.name}(${datesText(current)})` : '';
  }

  startButton.addEventListener('click', () => {
    openForm({
      title: 'イベントを開始',
      submitLabel: '開始する',
      hint: '開始すると、いまの在庫数が「開始時在庫」として記録されます。2日開催なら終了日を2日目にしてください。',
      initial: { startDate: today() },
      submit: async (values) => {
        await window.EventDB.start(values);
        window.App.showToast(`「${values.name.trim()}」を開始しました。いまの在庫数を開始時在庫として記録しました。`);
      },
    });
  });

  closeButton.addEventListener('click', async () => {
    const current = window.EventDB.currentSync();
    if (!current) return;
    const pending = window.App.pendingSalesCount?.() || 0;
    const message = `「${current.name}」を締めます。いまの在庫数を「終了時在庫」として記録します。\n\n`
      + (pending
        ? `この端末には、まだクラウドへ送れていない売上が${pending}件あります。電波のある場所で送り終えてから締めることをおすすめします。`
        : '他の端末の画面右上に「未同期 ◯件」が出ていないことを確認してから締めてください。')
      + '\n\n締めますか?';
    if (!window.confirm(message)) return;
    closeButton.disabled = true;
    try {
      await window.EventDB.close(current.id);
      window.App.showToast(`「${current.name}」を締めました。レポートで在庫の照合を確認できます。`);
    } catch (err) {
      console.error(err);
      window.App.showToast('締められませんでした: ' + err.message, true);
    } finally {
      closeButton.disabled = false;
    }
  });

  /** 商品マスタの「開始時在庫」列: the open event's record for the product that owns the stock. */
  function startStockOf(ownerId) {
    const current = window.EventDB.currentSync();
    if (!current || !current.startStock) return null;
    const v = current.startStock[String(ownerId)];
    return v == null ? null : v;
  }

  // ---------- レポート: 在庫の照合 ----------

  const reconcilePanel = $('reconcile-panel');
  const reconcileNote = $('reconcile-note');
  const reconcileBody = $('reconcile-body');
  const reconcileCsvButton = $('reconcile-csv-button');
  let lastReconcile = null; // { event, rows }

  /**
   * One row per product that owns stock: 開始時在庫, 売れた数 (incl. shared-stock products such
   * as 無償, counted on their source), 終了時在庫 (締めた時点; open → いまの在庫), and
   * 差 = 終了 − (開始 − 売れた数): manual stock edits and counting mistakes show up here.
   */
  async function reconcile(event, sales) {
    const products = await window.ProductDB.getAll();
    const byId = new Map(products.map((p) => [String(p.id), p]));
    const rows = new Map();
    const rowFor = (key, product, fallbackName) => {
      if (!rows.has(key)) {
        rows.set(key, { key, code: product?.code || '', name: product?.name || fallbackName || '(削除された商品)', start: null, sold: 0, end: null });
      }
      return rows.get(key);
    };
    for (const [id, n] of Object.entries(event.startStock || {})) rowFor(id, byId.get(id)).start = Number(n) || 0;
    for (const sale of sales) {
      for (const item of sale.items || []) {
        if (item.productId == null || item.productId === '') continue;
        const owner = window.ProductDB.stockOwnerSync(item.productId);
        const key = owner ? String(owner.id) : String(item.productId);
        rowFor(key, owner, item.productName).sold += Number(item.quantity) || 0;
      }
    }
    for (const row of rows.values()) {
      if (event.closedAt) {
        const v = event.endStock ? event.endStock[row.key] : undefined;
        row.end = v == null ? null : Number(v);
      } else {
        const p = byId.get(row.key);
        row.end = p ? Number(p.stock) || 0 : null;
      }
      row.diff = row.start != null && row.end != null ? row.end - (row.start - row.sold) : null;
    }
    return [...rows.values()].sort((a, b) => (!a.code !== !b.code ? (a.code ? -1 : 1) : 0)
      || a.code.localeCompare(b.code, 'ja', { numeric: true }) || a.name.localeCompare(b.name, 'ja'));
  }

  const num = (v) => (v == null ? '<span class="muted">-</span>' : esc(v));
  const diffCell = (v) => (v == null ? '<span class="muted">-</span>'
    : `<span class="${v === 0 ? 'reconcile-ok' : 'reconcile-diff'}">${v > 0 ? '+' : ''}${esc(v)}</span>`);

  async function renderReconcile(event, sales) {
    if (!event) {
      reconcilePanel.hidden = true;
      lastReconcile = null;
      return;
    }
    reconcilePanel.hidden = false;
    if (!event.startStock) {
      reconcileNote.textContent = 'このイベントには開始時在庫の記録がないため、照合できません(「イベントを開始」から始めたイベントで使えます)。';
      reconcileBody.innerHTML = '';
      reconcileCsvButton.hidden = true;
      lastReconcile = null;
      return;
    }
    const rows = await reconcile(event, sales);
    lastReconcile = { event, rows };
    reconcileCsvButton.hidden = false;
    const endLabel = event.closedAt ? '終了時在庫' : 'いまの在庫';
    const diffs = rows.filter((r) => r.diff != null && r.diff !== 0).length;
    reconcileNote.textContent = (event.closedAt
      ? `${timeText(event.startedAt)} 開始 〜 ${timeText(event.closedAt)} 締め。`
      : `${timeText(event.startedAt)} 開始(開催中のため、終了時在庫の代わりにいまの在庫を表示)。`)
      + ` 差 = ${endLabel} −(開始時在庫 − 売れた数)。`
      + (diffs ? `差がある商品が${diffs}件あります(会期中の在庫数の手直しや数え間違いなど)。` : '差はありません。');
    reconcileBody.innerHTML = `
      <table class="product-table reconcile-table">
        <thead><tr><th scope="col">商品</th><th scope="col" class="num">開始時在庫</th><th scope="col" class="num">売れた数</th><th scope="col" class="num">${endLabel}</th><th scope="col" class="num">差</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr data-key="${esc(r.key)}">
            <td class="name-cell">${esc(r.name)}${r.code ? `<span class="payment-detail">${esc(r.code)}</span>` : ''}</td>
            <td class="num">${num(r.start)}</td>
            <td class="num">${esc(r.sold)}</td>
            <td class="num">${num(r.end)}</td>
            <td class="num">${diffCell(r.diff)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  }

  function csvField(v) {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  reconcileCsvButton.addEventListener('click', () => {
    if (!lastReconcile) return;
    const { event, rows } = lastReconcile;
    const lines = [
      `イベント: ${event.name}(${datesText(event)})`,
      ['商品コード', '商品名', '開始時在庫', '売れた数', event.closedAt ? '終了時在庫' : 'いまの在庫', '差'].join(','),
      ...rows.map((r) => [r.code, r.name, r.start, r.sold, r.end, r.diff].map(csvField).join(',')),
    ];
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stock-check-${event.startDate}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  // ---------- wiring ----------

  // Subscribe only after every script has run: the browser can fire the first update between
  // two <script> files, before app.js has defined the shared helpers (window.App).
  function whenLoaded(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  whenLoaded(() => {
    window.EventDB.subscribe(() => {
      renderPanel();
      window.ProductsView?.refreshList?.();
    });
  });

  window.EventsView = { openForm, startStockOf, renderReconcile };
})();
