/* Sales entry view: tap-to-add product grid + qty stepper (auto stock deduction via SalesDB), list, search. */

(() => {
  'use strict';

  const form = document.getElementById('sale-form');
  const idField = document.getElementById('sale-id');
  const customerField = document.getElementById('sale-field-customer');
  const noteField = document.getElementById('sale-field-note');

  const formModeLabel = document.getElementById('sale-form-mode-label');
  const submitButton = document.getElementById('sale-submit-button');
  const cancelEditButton = document.getElementById('sale-cancel-edit-button');
  const formMessage = document.getElementById('sale-form-message');

  const productSearchInput = document.getElementById('sale-product-search');
  const productGrid = document.getElementById('sale-product-grid');

  const lineItemsBody = document.getElementById('line-items-body');
  const lineItemsEmpty = document.getElementById('line-items-empty');
  const totalDisplay = document.getElementById('sale-total-display');

  const searchInput = document.getElementById('sale-search-input');
  const tableBody = document.getElementById('sale-table-body');
  const emptyState = document.getElementById('sale-empty-state');
  const summaryStats = document.getElementById('sale-summary-stats');
  const selectAllCheckbox = document.getElementById('sale-select-all');
  const bulkDeleteButton = document.getElementById('sale-bulk-delete-button');
  const selectionCountEl = document.getElementById('sale-selection-count');
  const exportButton = document.getElementById('sale-export-button');
  const importInput = document.getElementById('sale-import-input');

  const workspaceCodeDisplay = document.getElementById('workspace-code-display');
  const workspaceCodeCopyButton = document.getElementById('workspace-code-copy');
  const workspaceCodeJoinButton = document.getElementById('workspace-code-join');
  const workspaceMigrateButton = document.getElementById('workspace-migrate-button');
  const workspaceMessage = document.getElementById('workspace-message');

  let allSales = [];
  let productsCache = [];
  let customersCache = [];
  let items = [];
  let editingId = null;
  let selectedIds = new Set();
  let unsubscribeSales = null;

  // ---------- Form: header fields ----------

  function resetForm() {
    form.reset();
    idField.value = '';
    editingId = null;
    items = [];
    formModeLabel.textContent = '売上を登録';
    submitButton.textContent = '登録する';
    cancelEditButton.hidden = true;
    formMessage.textContent = '';
    formMessage.classList.remove('is-error');
    renderLineItems();
    renderProductGrid();
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

  // ---------- Product picker (tap-to-add grid) ----------

  function filterProductsForPicker(query) {
    const q = query.trim().toLowerCase();
    if (!q) return productsCache;
    return productsCache.filter((p) => (
      (p.name || '').toLowerCase().includes(q) ||
      (p.code || '').toLowerCase().includes(q) ||
      (p.category || '').toLowerCase().includes(q)
    ));
  }

  function renderProductGrid() {
    const filtered = filterProductsForPicker(productSearchInput.value);

    if (productsCache.length === 0) {
      productGrid.innerHTML = '<p class="empty-state">商品マスタに商品が登録されていません。先に商品マスタで登録してください。</p>';
      return;
    }
    if (filtered.length === 0) {
      productGrid.innerHTML = '<p class="empty-state">該当する商品がありません。</p>';
      return;
    }

    productGrid.innerHTML = filtered.map((p) => {
      const cartItem = items.find((i) => i.productId === p.id);
      const low = Number(p.stock) <= 5;
      return `
        <button type="button" class="product-tile ${cartItem ? 'is-in-cart' : ''}" data-product-id="${p.id}">
          ${cartItem ? `<span class="product-tile__cart-badge">${cartItem.quantity}</span>` : ''}
          <span class="product-tile__name">${window.App.escapeHtml(p.name)}</span>
          <span class="product-tile__price">${window.App.formatCurrency(p.price)}</span>
          <span class="product-tile__stock ${low ? 'stock-hint--low' : ''}">在庫: ${window.App.escapeHtml(p.stock)}${window.App.escapeHtml(p.unit) || ''}</span>
        </button>
      `;
    }).join('');
  }

  function addProductToCart(productId) {
    const product = productsCache.find((p) => p.id === productId);
    if (!product) return;
    const existing = items.find((i) => i.productId === productId);
    if (existing) {
      existing.quantity = Number(existing.quantity || 0) + 1;
    } else {
      items.push({ productId, unitPrice: Number(product.price) || 0, quantity: 1 });
    }
    renderLineItems();
    renderProductGrid();
  }

  productGrid.addEventListener('click', (event) => {
    const tile = event.target.closest('.product-tile');
    if (!tile) return;
    addProductToCart(Number(tile.dataset.productId));
  });

  productSearchInput.addEventListener('input', renderProductGrid);

  // ---------- Line items (cart) ----------

  function stockHintFor(productId) {
    const product = productsCache.find((p) => p.id === productId);
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
      const product = productsCache.find((p) => p.id === item.productId);
      const tr = document.createElement('tr');
      tr.dataset.rowIndex = String(idx);
      tr.innerHTML = `
        <td class="name-cell">
          ${window.App.escapeHtml(product ? product.name : '(削除された商品)')}
          ${stockHintFor(item.productId)}
        </td>
        <td class="num"><input type="number" class="line-input line-item-price" data-index="${idx}" min="0" step="1" value="${item.unitPrice}" /></td>
        <td class="num">
          <div class="qty-stepper">
            <button type="button" class="qty-stepper__btn" data-action="dec" data-index="${idx}" aria-label="数量を減らす">－</button>
            <input type="number" class="qty-stepper__input line-item-qty" data-index="${idx}" min="1" step="1" value="${item.quantity}" />
            <button type="button" class="qty-stepper__btn" data-action="inc" data-index="${idx}" aria-label="数量を増やす">＋</button>
          </div>
        </td>
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

  lineItemsBody.addEventListener('input', (event) => {
    const idx = Number(event.target.dataset.index);
    if (Number.isNaN(idx)) return;
    if (event.target.classList.contains('line-item-price')) {
      items[idx].unitPrice = Number(event.target.value) || 0;
      updateRowSubtotal(idx);
      updateTotalDisplay();
    } else if (event.target.classList.contains('line-item-qty')) {
      const next = Math.max(1, Number(event.target.value) || 1);
      items[idx].quantity = next;
      updateRowSubtotal(idx);
      updateTotalDisplay();
      renderProductGrid();
    }
  });

  lineItemsBody.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn) return;
    const idx = Number(btn.dataset.index);

    if (btn.dataset.action === 'remove-line') {
      items.splice(idx, 1);
      renderLineItems();
      renderProductGrid();
    } else if (btn.dataset.action === 'inc') {
      items[idx].quantity = Number(items[idx].quantity || 0) + 1;
      renderLineItems();
      renderProductGrid();
    } else if (btn.dataset.action === 'dec') {
      const next = Number(items[idx].quantity || 0) - 1;
      if (next <= 0) {
        items.splice(idx, 1);
      } else {
        items[idx].quantity = next;
      }
      renderLineItems();
      renderProductGrid();
    }
  });

  // ---------- Submit / edit / delete ----------

  function startEdit(sale) {
    editingId = sale.id;
    idField.value = String(sale.id);
    customerField.value = sale.customerId ? String(sale.customerId) : '';
    noteField.value = sale.note || '';
    items = sale.items.map((i) => ({ productId: i.productId || '', unitPrice: i.unitPrice, quantity: i.quantity }));

    formModeLabel.textContent = `売上を編集中: ${window.App.formatDateTime(sale.createdAt)}`;
    submitButton.textContent = '更新する';
    cancelEditButton.hidden = false;
    clearFormError();
    renderLineItems();
    renderProductGrid();

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
    if (submitButton.disabled) return; // guard against double-tap/double-click firing this twice
    clearFormError();

    const validItems = items.filter((i) => i.productId && Number(i.quantity) > 0);
    if (validItems.length === 0) {
      showFormError('商品一覧からタップして、明細を1件以上追加してください。');
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
      customerId,
      customerName: customer ? customer.name : '',
      note: noteField.value.trim(),
      items: preparedItems,
    };

    submitButton.disabled = true;
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
      renderProductGrid();
      window.ProductsView?.refreshList();
    } catch (err) {
      console.error(err);
      showFormError('保存に失敗しました: ' + err.message);
    } finally {
      submitButton.disabled = false;
    }
  }

  async function handleDelete(id, label) {
    const ok = window.confirm(`${label} の売上を削除します。明細分の在庫は元に戻ります。よろしいですか?`);
    if (!ok) return;
    try {
      await window.SalesDB.remove(id);
      window.App.showToast('売上を削除し、在庫を戻しました。');
      if (editingId === id) resetForm();
      selectedIds.delete(id);
      await refreshProductsCache();
      renderProductGrid();
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
        <td class="checkbox-col">
          <input type="checkbox" class="sale-row-checkbox" data-id="${s.id}" aria-label="この売上を選択" ${selectedIds.has(s.id) ? 'checked' : ''} />
        </td>
        <td>${window.App.formatDateTime(s.createdAt)}</td>
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
    updateSelectionUI(sales);
  }

  // ---------- Bulk selection / delete ----------

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
    if (event.target.checked) {
      selectedIds.add(id);
    } else {
      selectedIds.delete(id);
    }
    updateSelectionUI(currentVisibleSales());
  });

  selectAllCheckbox.addEventListener('change', () => {
    const visible = currentVisibleSales();
    if (selectAllCheckbox.checked) {
      visible.forEach((s) => selectedIds.add(s.id));
    } else {
      visible.forEach((s) => selectedIds.delete(s.id));
    }
    renderTable(visible);
  });

  async function handleBulkDelete() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;

    const ok = window.confirm(`選択した${ids.length}件の売上を削除します。明細分の在庫はそれぞれ元に戻ります。よろしいですか?`);
    if (!ok) return;

    bulkDeleteButton.disabled = true;
    try {
      for (const id of ids) {
        await window.SalesDB.remove(id);
      }
      window.App.showToast(`${ids.length}件の売上を削除し、在庫を戻しました。`);
      if (editingId && ids.includes(editingId)) resetForm();
      selectedIds.clear();
      await refreshProductsCache();
      renderProductGrid();
      window.ProductsView?.refreshList();
    } catch (err) {
      console.error(err);
      window.App.showToast('一括削除に失敗しました: ' + err.message, true);
      await refreshList();
    } finally {
      bulkDeleteButton.disabled = selectedIds.size === 0;
    }
  }

  bulkDeleteButton.addEventListener('click', handleBulkDelete);

  function updateSummary(visibleSales) {
    const totalCount = allSales.length;
    const totalAmount = allSales.reduce((sum, s) => sum + (Number(s.totalAmount) || 0), 0);
    const shown = visibleSales.length;
    let text = `件数: ${totalCount}件 / 合計金額: ${window.App.formatCurrency(totalAmount)}`;
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

  tableBody.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const sale = allSales.find((s) => s.id === id);
    if (!sale) return;

    if (btn.dataset.action === 'edit') {
      startEdit(sale);
    } else if (btn.dataset.action === 'delete') {
      handleDelete(id, window.App.formatDateTime(sale.createdAt));
    }
  });

  searchInput.addEventListener('input', () => {
    const visible = filterSales(allSales, searchInput.value);
    renderTable(visible);
    updateSummary(visible);
  });

  form.addEventListener('submit', handleSubmit);
  cancelEditButton.addEventListener('click', resetForm);

  // ---------- Import / Export ----------

  function exportJSON() {
    if (allSales.length === 0) {
      window.App.showToast('エクスポートするデータがありません。', true);
      return;
    }
    const blob = new Blob([JSON.stringify(allSales, null, 2)], { type: 'application/json' });
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

  async function importJSON(file) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error('JSONの形式が不正です(配列である必要があります)。');

      const cleaned = data
        .filter((item) => item && typeof item === 'object' && Array.isArray(item.items) && item.items.length > 0)
        .map((item) => ({
          date: typeof item.date === 'string' ? item.date : '',
          customerId: item.customerId != null ? Number(item.customerId) : null,
          customerName: item.customerName || '',
          note: item.note || '',
          items: item.items
            .filter((i) => i && i.productName)
            .map((i) => ({
              productId: i.productId != null ? Number(i.productId) : null,
              productName: String(i.productName),
              unit: i.unit || '',
              unitPrice: Number(i.unitPrice) || 0,
              quantity: Number(i.quantity) || 0,
            })),
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        }))
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

  // ---------- Workspace code (cloud sync) ----------

  function showWorkspaceMessage(message, isError = false) {
    workspaceMessage.textContent = message;
    workspaceMessage.classList.toggle('is-error', isError);
  }

  function renderWorkspaceCode() {
    workspaceCodeDisplay.textContent = window.Cloud.getWorkspaceId();
  }

  workspaceCodeCopyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(window.Cloud.getWorkspaceId());
      showWorkspaceMessage('共有コードをコピーしました。');
    } catch (err) {
      console.error(err);
      showWorkspaceMessage('コピーに失敗しました。手動で選択してコピーしてください。', true);
    }
  });

  workspaceCodeJoinButton.addEventListener('click', () => {
    const input = window.prompt('参加する共有コードを入力してください(他の端末に表示されているコード):', '');
    if (input == null) return;
    const clean = input.trim();
    if (!clean) return;
    window.Cloud.setWorkspaceId(clean);
    showWorkspaceMessage('共有コードを変更しました。反映のためページを再読み込みします…');
    setTimeout(() => location.reload(), 800);
  });

  workspaceMigrateButton.addEventListener('click', async () => {
    const ok = window.confirm(
      'この端末にローカル保存されている過去の売上データを、現在の共有コードのクラウドにアップロードします。' +
      '在庫数は変更されません。同じデータを2回アップロードすると重複するのでご注意ください。続けますか?'
    );
    if (!ok) return;

    workspaceMigrateButton.disabled = true;
    try {
      const localSales = await window.LegacyLocalSalesDB.getAll();
      if (localSales.length === 0) {
        showWorkspaceMessage('アップロード対象のローカル売上データはありませんでした。');
        return;
      }
      await window.SalesDB.bulkImport(localSales);
      showWorkspaceMessage(`${localSales.length}件のローカル売上データをアップロードしました。`);
    } catch (err) {
      console.error(err);
      showWorkspaceMessage('アップロードに失敗しました: ' + err.message, true);
    } finally {
      workspaceMigrateButton.disabled = false;
    }
  });

  async function activate() {
    await Promise.all([refreshProductsCache(), refreshCustomerOptions()]);
    renderLineItems();
    renderProductGrid();
    renderWorkspaceCode();
    if (!unsubscribeSales) {
      unsubscribeSales = window.SalesDB.subscribe(applySales);
    }
  }

  window.SalesView = { refreshList, refreshCustomerOptions, refreshProductsCache };
  window.Router.onViewActivate('sales', activate);
})();
