/* 売上履歴 view: live list of sales (Firestore subscription), search, edit (hands the sale
 * to the register), delete / bulk delete, JSON import/export. Kept off the register screen
 * so destructive/admin actions aren't one tap away during sales. */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const searchInput = $('sale-search-input');
  const tableBody = $('sale-table-body');
  const emptyState = $('sale-empty-state');
  const summaryStats = $('sale-summary-stats');
  const selectAllCheckbox = $('sale-select-all');
  const bulkDeleteButton = $('sale-bulk-delete-button');
  const selectionCountEl = $('sale-selection-count');
  const exportButton = $('sale-export-button');
  const importInput = $('sale-import-input');

  const HIGHLIGHT_MS = 2400; // keep in sync with the .is-just-saved animation in style.css

  let allSales = [];
  let selectedIds = new Set();
  let unsubscribeSales = null;
  let highlightState = { id: null, startedAt: 0 };

  const fmt = (n) => window.App.formatCurrency(n);
  const esc = (s) => window.App.escapeHtml(s);

  function itemsSummaryText(sale) {
    return sale.items.map((i) => `${i.productName} × ${i.quantity}`).join(', ');
  }

  function itemsSummaryHtml(sale) {
    return sale.items.map((i) => `${i.ageRestricted ? '<span class="age-tag age-tag--sm">年齢確認</span>' : ''}${esc(i.productName)} × ${i.quantity}`).join(', ');
  }

  function paymentHtml(sale) {
    const p = sale.payment;
    if (!p || !p.method) return '<span class="muted">-</span>';
    const method = (window.PaymentMethods || []).find((m) => m.id === p.method);
    const label = esc(method ? method.label : p.method);
    if (p.received == null) return label;
    return `${label}<span class="payment-detail">預 ${fmt(p.received)} / 釣 ${fmt(p.change)}</span>`;
  }

  function filterSales(sales, query) {
    const q = query.trim().toLowerCase();
    if (!q) return sales;
    return sales.filter((s) => (
      (s.customerName || '').toLowerCase().includes(q) ||
      (s.note || '').toLowerCase().includes(q) ||
      s.items.some((i) => (i.productName || '').toLowerCase().includes(q))
    ));
  }

  function renderTable(sales) {
    tableBody.innerHTML = '';
    emptyState.hidden = sales.length !== 0;

    const fragment = document.createDocumentFragment();
    for (const s of sales) {
      const tr = document.createElement('tr');
      tr.dataset.id = s.id;
      applyHighlight(tr);
      tr.innerHTML = `
        <td class="checkbox-col h-check">
          <input type="checkbox" class="sale-row-checkbox" data-id="${s.id}" aria-label="この売上を選択" ${selectedIds.has(s.id) ? 'checked' : ''} />
        </td>
        <td class="h-date">${window.App.formatDateTime(s.createdAt)}${s.pending ? ' <span class="sync-pill" title="この端末には保存済み。オンライン時にクラウドへ自動同期されます">同期待ち</span>' : ''}</td>
        <td class="h-customer">${esc(s.customerName) || '一般客'}</td>
        <td class="name-cell h-items">${itemsSummaryHtml(s)}${s.note ? `<span class="payment-detail">メモ: ${esc(s.note)}</span>` : ''}</td>
        <td class="num h-total">${fmt(s.totalAmount)}</td>
        <td class="h-payment">${paymentHtml(s)}</td>
        <td class="h-updated">${window.App.formatDateTime(s.updatedAt)}</td>
        <td class="actions-col h-actions">
          <div class="row-actions">
            <button type="button" class="btn btn--ghost btn--sm" data-action="edit" data-id="${s.id}">編集</button>
            <button type="button" class="btn btn--danger btn--sm" data-action="delete" data-id="${s.id}">削除</button>
          </div>
        </td>
      `;
      fragment.appendChild(tr);
    }
    tableBody.appendChild(fragment);
    updateSelectionUI(sales);
  }

  /**
   * Briefly highlight the row of a just-saved sale. The list re-renders whenever the
   * live subscription fires (incl. pending→synced), so instead of a one-shot class we
   * resume the CSS animation at the elapsed offset on every render.
   */
  function applyHighlight(tr) {
    if (tr.dataset.id !== highlightState.id) return;
    const elapsed = Date.now() - highlightState.startedAt;
    if (elapsed >= HIGHLIGHT_MS) return;
    tr.classList.add('is-just-saved');
    tr.style.animationDelay = `-${elapsed}ms`;
  }

  function highlight(id) {
    if (!id) return;
    highlightState = { id: String(id), startedAt: Date.now() };
    const tr = tableBody.querySelector(`tr[data-id="${CSS.escape(String(id))}"]`);
    if (tr) {
      tr.classList.remove('is-just-saved');
      void tr.offsetWidth; // restart the animation if this row was already highlighted
      applyHighlight(tr);
    }
  }

  // ---------- Selection / delete ----------

  function updateSelectionUI(visibleSales) {
    const visibleIds = visibleSales.map((s) => s.id);
    const selectedVisibleCount = visibleIds.filter((id) => selectedIds.has(id)).length;

    selectionCountEl.textContent = selectedIds.size > 0 ? `${selectedIds.size}件選択中` : '';
    bulkDeleteButton.disabled = selectedIds.size === 0;

    if (visibleIds.length === 0) {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = false;
    } else {
      selectAllCheckbox.checked = selectedVisibleCount === visibleIds.length;
      selectAllCheckbox.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleIds.length;
    }
  }

  function currentVisibleSales() {
    return filterSales(allSales, searchInput.value);
  }

  tableBody.addEventListener('change', (event) => {
    if (!event.target.classList.contains('sale-row-checkbox')) return;
    const id = event.target.dataset.id;
    if (event.target.checked) selectedIds.add(id);
    else selectedIds.delete(id);
    updateSelectionUI(currentVisibleSales());
  });

  selectAllCheckbox.addEventListener('change', () => {
    const visible = currentVisibleSales();
    if (selectAllCheckbox.checked) visible.forEach((s) => selectedIds.add(s.id));
    else visible.forEach((s) => selectedIds.delete(s.id));
    renderTable(visible);
  });

  async function afterStockChange() {
    await window.RegisterView?.reloadProducts();
    window.ProductsView?.refreshList();
  }

  async function handleDelete(id, label) {
    const ok = window.confirm(`${label} の売上を削除します。明細分の在庫は元に戻ります。よろしいですか?`);
    if (!ok) return;
    try {
      await window.SalesDB.remove(id);
      window.App.showToast('売上を削除し、在庫を戻しました。');
      window.RegisterView?.cancelEditIf(id);
      selectedIds.delete(id);
      await afterStockChange();
    } catch (err) {
      console.error(err);
      window.App.showToast('削除に失敗しました: ' + err.message, true);
    }
  }

  async function handleBulkDelete() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const ok = window.confirm(`選択した${ids.length}件の売上を削除します。明細分の在庫はそれぞれ元に戻ります。よろしいですか?`);
    if (!ok) return;

    bulkDeleteButton.disabled = true;
    try {
      for (const id of ids) {
        await window.SalesDB.remove(id);
        window.RegisterView?.cancelEditIf(id);
      }
      window.App.showToast(`${ids.length}件の売上を削除し、在庫を戻しました。`);
      selectedIds.clear();
      await afterStockChange();
    } catch (err) {
      console.error(err);
      window.App.showToast('一括削除に失敗しました: ' + err.message, true);
      await refreshList();
    } finally {
      bulkDeleteButton.disabled = selectedIds.size === 0;
    }
  }

  bulkDeleteButton.addEventListener('click', handleBulkDelete);

  tableBody.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const sale = allSales.find((s) => s.id === id);
    if (!sale) return;
    if (btn.dataset.action === 'edit') {
      window.RegisterView?.startEdit(sale);
    } else if (btn.dataset.action === 'delete') {
      handleDelete(id, window.App.formatDateTime(sale.createdAt));
    }
  });

  // ---------- List ----------

  function updateSummary(visibleSales) {
    const totalCount = allSales.length;
    const totalAmount = allSales.reduce((sum, s) => sum + (Number(s.totalAmount) || 0), 0);
    const shown = visibleSales.length;
    let text = `件数: ${totalCount}件 / 合計金額: ${fmt(totalAmount)}`;
    if (shown !== totalCount) text = `表示中: ${shown}件 / ` + text;
    summaryStats.textContent = text;
  }

  /** Shared render step, driven by the live Firestore subscription (see activate()). */
  function applySales(sales) {
    allSales = sales;
    const existingIds = new Set(allSales.map((s) => s.id));
    selectedIds = new Set([...selectedIds].filter((id) => existingIds.has(id)));
    const visible = filterSales(allSales, searchInput.value);
    renderTable(visible);
    updateSummary(visible);
  }

  /** One-time manual resync fallback (the subscription is the primary update path). */
  async function refreshList() {
    try {
      applySales(await window.SalesDB.getAll());
    } catch (err) {
      console.error(err);
      window.App.showToast('データの読み込みに失敗しました。', true);
    }
  }

  searchInput.addEventListener('input', () => {
    const visible = filterSales(allSales, searchInput.value);
    renderTable(visible);
    updateSummary(visible);
  });

  // ---------- Import / Export ----------

  function exportJSON() {
    if (allSales.length === 0) {
      window.App.showToast('エクスポートするデータがありません。', true);
      return;
    }
    const exportable = allSales.map(({ pending, ...rest }) => rest); // `pending` is UI-only sync state
    const blob = new Blob([JSON.stringify(exportable, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = url;
    a.download = `sales-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    window.App.showToast('JSONファイルをエクスポートしました。');
  }

  function cleanPayment(p) {
    if (!p || typeof p !== 'object' || !p.method) return undefined;
    const out = { method: String(p.method) };
    if (p.received != null) out.received = Number(p.received) || 0;
    if (p.change != null) out.change = Number(p.change) || 0;
    return out;
  }

  async function importJSON(file) {
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data)) throw new Error('JSONの形式が不正です(配列である必要があります)。');

      const cleaned = data
        .filter((item) => item && typeof item === 'object' && Array.isArray(item.items) && item.items.length > 0)
        .map((item) => {
          const sale = {
            date: typeof item.date === 'string' ? item.date : '',
            customerId: item.customerId != null ? Number(item.customerId) : null,
            customerName: item.customerName || '',
            note: item.note || '',
            items: item.items
              .filter((i) => i && i.productName)
              .map((i) => ({
                productId: i.productId != null && i.productId !== '' ? String(i.productId) : null,
                productName: String(i.productName),
                unit: i.unit || '',
                payee: typeof i.payee === 'string' ? i.payee : '',
                ...(i.ageRestricted === true ? { ageRestricted: true } : {}),
                unitPrice: Number(i.unitPrice) || 0,
                quantity: Number(i.quantity) || 0,
              })),
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          };
          const payment = cleanPayment(item.payment);
          if (payment) sale.payment = payment; // Firestore rejects `undefined` fields
          return sale;
        })
        .filter((item) => item.items.length > 0);

      if (cleaned.length === 0) throw new Error('インポート可能な売上データが見つかりませんでした。');

      await window.SalesDB.bulkImport(cleaned);
      window.App.showToast(`${cleaned.length}件の売上をインポートしました(在庫数は変更されません)。`);
    } catch (err) {
      console.error(err);
      window.App.showToast('インポートに失敗しました: ' + err.message, true);
    }
  }

  exportButton.addEventListener('click', exportJSON);
  importInput.addEventListener('change', () => {
    const file = importInput.files && importInput.files[0];
    if (file) importJSON(file);
    importInput.value = '';
  });

  function activate() {
    if (!unsubscribeSales) unsubscribeSales = window.SalesDB.subscribe(applySales);
  }

  window.HistoryView = { refreshList, highlight };
  window.Router.onViewActivate('history', activate);
})();
