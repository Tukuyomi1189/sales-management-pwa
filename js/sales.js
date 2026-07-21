/* Sales entry view: line-item form (auto stock deduction via SalesDB), list, search. */

(() => {
  'use strict';

  const form = document.getElementById('sale-form');
  const idField = document.getElementById('sale-id');
  const dateField = document.getElementById('sale-field-date');
  const customerField = document.getElementById('sale-field-customer');
  const noteField = document.getElementById('sale-field-note');

  const formModeLabel = document.getElementById('sale-form-mode-label');
  const submitButton = document.getElementById('sale-submit-button');
  const cancelEditButton = document.getElementById('sale-cancel-edit-button');
  const formMessage = document.getElementById('sale-form-message');

  const addLineItemButton = document.getElementById('add-line-item-button');
  const lineItemsBody = document.getElementById('line-items-body');
  const lineItemsEmpty = document.getElementById('line-items-empty');
  const totalDisplay = document.getElementById('sale-total-display');

  const searchInput = document.getElementById('sale-search-input');
  const tableBody = document.getElementById('sale-table-body');
  const emptyState = document.getElementById('sale-empty-state');
  const summaryStats = document.getElementById('sale-summary-stats');

  let allSales = [];
  let productsCache = [];
  let customersCache = [];
  let items = [];
  let editingId = null;

  function todayISO() {
    const d = new Date();
    const tzOffsetMs = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 10);
  }

  // ---------- Form: header fields ----------

  function resetForm() {
    form.reset();
    idField.value = '';
    editingId = null;
    dateField.value = todayISO();
    items = [];
    formModeLabel.textContent = '売上を登録';
    submitButton.textContent = '登録する';
    cancelEditButton.hidden = true;
    formMessage.textContent = '';
    formMessage.classList.remove('is-error');
    renderLineItems();
  }

  function showFormError(message) {
    formMessage.textContent = message;
    formMessage.classList.add('is-error');
  }

  function clearFormError() {
    formMessage.textContent = '';
    formMessage.classList.remove('is-error');
  }

  async function refreshCustomerOptions() {
    customersCache = await window.CustomerDB.getAll();
    const currentValue = customerField.value;
    customerField.innerHTML = '<option value="">選択なし(一般客)</option>' +
      customersCache.map((c) => `<option value="${c.id}">${window.App.escapeHtml(c.name)}</option>`).join('');
    if (currentValue && customersCache.some((c) => String(c.id) === currentValue)) {
      customerField.value = currentValue;
    }
  }

  async function refreshProductsCache() {
    productsCache = await window.ProductDB.getAll();
  }

  // ---------- Line items ----------

  function productOptionsHtml(selectedId) {
    const options = productsCache.map((p) => {
      const selected = String(p.id) === String(selectedId) ? 'selected' : '';
      return `<option value="${p.id}" ${selected}>${window.App.escapeHtml(p.name)} (${window.App.formatCurrency(p.price)})</option>`;
    });
    return '<option value="">商品を選択</option>' + options.join('');
  }

  function stockHintFor(productId) {
    const product = productsCache.find((p) => p.id === Number(productId));
    if (!product) return '';
    const low = Number(product.stock) <= 5;
    return `<div class="stock-hint ${low ? 'stock-hint--low' : ''}">現在庫: ${window.App.escapeHtml(product.stock)}${window.App.escapeHtml(product.unit) || ''}</div>`;
  }

  function rowSubtotal(item) {
    return (Number(item.unitPrice) || 0) * (Number(item.quantity) || 0);
  }

  function renderLineItems() {
    lineItemsBody.innerHTML = '';
    lineItemsEmpty.hidden = items.length !== 0;

    const fragment = document.createDocumentFragment();
    items.forEach((item, idx) => {
      const tr = document.createElement('tr');
      tr.dataset.rowIndex = String(idx);
      tr.innerHTML = `
        <td>
          <select class="line-item-product" data-index="${idx}">
            ${productOptionsHtml(item.productId)}
          </select>
          ${stockHintFor(item.productId)}
        </td>
        <td class="num"><input type="number" class="line-input line-item-price" data-index="${idx}" min="0" step="1" value="${item.unitPrice}" /></td>
        <td class="num"><input type="number" class="line-input line-item-qty" data-index="${idx}" min="1" step="1" value="${item.quantity}" /></td>
        <td class="num line-item-subtotal">${window.App.formatCurrency(rowSubtotal(item))}</td>
        <td class="actions-col">
          <button type="button" class="btn btn--danger btn--sm" data-action="remove-line" data-index="${idx}">削除</button>
        </td>
      `;
      fragment.appendChild(tr);
    });
    lineItemsBody.appendChild(fragment);
    updateTotalDisplay();
  }

  function updateRowSubtotal(idx) {
    const row = lineItemsBody.querySelector(`tr[data-row-index="${idx}"]`);
    if (!row) return;
    row.querySelector('.line-item-subtotal').textContent = window.App.formatCurrency(rowSubtotal(items[idx]));
  }

  function updateTotalDisplay() {
    const total = items.reduce((sum, item) => sum + rowSubtotal(item), 0);
    totalDisplay.textContent = window.App.formatCurrency(total);
  }

  addLineItemButton.addEventListener('click', () => {
    items.push({ productId: '', unitPrice: 0, quantity: 1 });
    renderLineItems();
  });

  lineItemsBody.addEventListener('input', (event) => {
    const idx = Number(event.target.dataset.index);
    if (Number.isNaN(idx)) return;
    if (event.target.classList.contains('line-item-price')) {
      items[idx].unitPrice = Number(event.target.value) || 0;
      updateRowSubtotal(idx);
      updateTotalDisplay();
    } else if (event.target.classList.contains('line-item-qty')) {
      items[idx].quantity = Number(event.target.value) || 0;
      updateRowSubtotal(idx);
      updateTotalDisplay();
    }
  });

  lineItemsBody.addEventListener('change', (event) => {
    if (!event.target.classList.contains('line-item-product')) return;
    const idx = Number(event.target.dataset.index);
    const productId = event.target.value ? Number(event.target.value) : '';
    items[idx].productId = productId;
    const product = productsCache.find((p) => p.id === productId);
    if (product) items[idx].unitPrice = Number(product.price) || 0;
    renderLineItems();
  });

  lineItemsBody.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-action="remove-line"]');
    if (!btn) return;
    const idx = Number(btn.dataset.index);
    items.splice(idx, 1);
    renderLineItems();
  });

  // ---------- Submit / edit / delete ----------

  function startEdit(sale) {
    editingId = sale.id;
    idField.value = String(sale.id);
    dateField.value = sale.date || todayISO();
    customerField.value = sale.customerId ? String(sale.customerId) : '';
    noteField.value = sale.note || '';
    items = sale.items.map((i) => ({ productId: i.productId || '', unitPrice: i.unitPrice, quantity: i.quantity }));

    formModeLabel.textContent = `売上を編集中: ${window.App.formatDateTime(sale.date)}`;
    submitButton.textContent = '更新する';
    cancelEditButton.hidden = false;
    clearFormError();
    renderLineItems();

    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function hasStockShortage() {
    return items.some((item) => {
      const product = productsCache.find((p) => p.id === Number(item.productId));
      return product && Number(item.quantity) > Number(product.stock);
    });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    clearFormError();

    if (!dateField.value) {
      showFormError('日付を入力してください。');
      return;
    }
    const validItems = items.filter((i) => i.productId && Number(i.quantity) > 0);
    if (validItems.length === 0) {
      showFormError('明細を1件以上、商品と数量を指定して追加してください。');
      return;
    }

    if (hasStockShortage()) {
      const proceed = window.confirm('在庫数を超える数量が含まれています。このまま登録しますか?');
      if (!proceed) return;
    }

    const customerId = customerField.value ? Number(customerField.value) : null;
    const customer = customerId ? customersCache.find((c) => c.id === customerId) : null;

    const preparedItems = validItems.map((i) => {
      const product = productsCache.find((p) => p.id === Number(i.productId));
      return {
        productId: Number(i.productId),
        productName: product ? product.name : '(削除された商品)',
        unit: product ? product.unit : '',
        unitPrice: Number(i.unitPrice) || 0,
        quantity: Number(i.quantity) || 0,
      };
    });

    const payload = {
      date: dateField.value,
      customerId,
      customerName: customer ? customer.name : '',
      note: noteField.value.trim(),
      items: preparedItems,
    };

    try {
      if (editingId) {
        await window.SalesDB.update(editingId, payload);
        window.App.showToast('売上を更新しました。');
      } else {
        await window.SalesDB.add(payload);
        window.App.showToast('売上を登録しました。在庫を更新しました。');
      }
      resetForm();
      await refreshProductsCache();
      await refreshList();
      window.ProductsView?.refreshList();
    } catch (err) {
      console.error(err);
      showFormError('保存に失敗しました: ' + err.message);
    }
  }

  async function handleDelete(id, dateLabel) {
    const ok = window.confirm(`${dateLabel} の売上を削除します。明細分の在庫は元に戻ります。よろしいですか?`);
    if (!ok) return;
    try {
      await window.SalesDB.remove(id);
      window.App.showToast('売上を削除し、在庫を戻しました。');
      if (editingId === id) resetForm();
      await refreshProductsCache();
      await refreshList();
      window.ProductsView?.refreshList();
    } catch (err) {
      console.error(err);
      window.App.showToast('削除に失敗しました: ' + err.message, true);
    }
  }

  // ---------- List ----------

  function itemsSummaryText(sale) {
    return sale.items.map((i) => `${i.productName} × ${i.quantity}`).join(', ');
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
      tr.innerHTML = `
        <td>${window.App.escapeHtml(s.date)}</td>
        <td>${window.App.escapeHtml(s.customerName) || '一般客'}</td>
        <td class="name-cell">${window.App.escapeHtml(itemsSummaryText(s))}</td>
        <td class="num">${window.App.formatCurrency(s.totalAmount)}</td>
        <td>${window.App.formatDateTime(s.updatedAt)}</td>
        <td class="actions-col">
          <div class="row-actions">
            <button type="button" class="btn btn--ghost btn--sm" data-action="edit" data-id="${s.id}">編集</button>
            <button type="button" class="btn btn--danger btn--sm" data-action="delete" data-id="${s.id}">削除</button>
          </div>
        </td>
      `;
      fragment.appendChild(tr);
    }
    tableBody.appendChild(fragment);
  }

  function updateSummary(visibleSales) {
    const totalCount = allSales.length;
    const totalAmount = allSales.reduce((sum, s) => sum + (Number(s.totalAmount) || 0), 0);
    const shown = visibleSales.length;
    let text = `件数: ${totalCount}件 / 合計金額: ${window.App.formatCurrency(totalAmount)}`;
    if (shown !== totalCount) text = `表示中: ${shown}件 / ` + text;
    summaryStats.textContent = text;
  }

  async function refreshList() {
    try {
      allSales = await window.SalesDB.getAll();
    } catch (err) {
      console.error(err);
      window.App.showToast('データの読み込みに失敗しました。', true);
      allSales = [];
    }
    const visible = filterSales(allSales, searchInput.value);
    renderTable(visible);
    updateSummary(visible);
  }

  tableBody.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const sale = allSales.find((s) => s.id === id);
    if (!sale) return;

    if (btn.dataset.action === 'edit') {
      startEdit(sale);
    } else if (btn.dataset.action === 'delete') {
      handleDelete(id, sale.date);
    }
  });

  searchInput.addEventListener('input', () => {
    const visible = filterSales(allSales, searchInput.value);
    renderTable(visible);
    updateSummary(visible);
  });

  form.addEventListener('submit', handleSubmit);
  cancelEditButton.addEventListener('click', resetForm);

  async function activate() {
    dateField.value = dateField.value || todayISO();
    await Promise.all([refreshProductsCache(), refreshCustomerOptions()]);
    renderLineItems();
    await refreshList();
  }

  window.SalesView = { refreshList, refreshCustomerOptions, refreshProductsCache };
  window.Router.onViewActivate('sales', activate);

  // Initialize default date immediately so the field isn't blank before first activation.
  dateField.value = todayISO();
})();
