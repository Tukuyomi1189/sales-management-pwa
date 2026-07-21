/* Product master view: registration form, search, list, import/export. */

(() => {
  'use strict';

  const form = document.getElementById('product-form');
  const idField = document.getElementById('product-id');
  const codeField = document.getElementById('field-code');
  const nameField = document.getElementById('field-name');
  const categoryField = document.getElementById('field-category');
  const priceField = document.getElementById('field-price');
  const stockField = document.getElementById('field-stock');
  const unitField = document.getElementById('field-unit');
  const noteField = document.getElementById('field-note');

  const formModeLabel = document.getElementById('form-mode-label');
  const submitButton = document.getElementById('submit-button');
  const cancelEditButton = document.getElementById('cancel-edit-button');
  const formMessage = document.getElementById('form-message');

  const searchInput = document.getElementById('search-input');
  const tableBody = document.getElementById('product-table-body');
  const emptyState = document.getElementById('empty-state');
  const summaryStats = document.getElementById('summary-stats');

  const exportButton = document.getElementById('export-button');
  const importInput = document.getElementById('import-input');

  const LOW_STOCK_THRESHOLD = 5;

  let allProducts = [];
  let editingId = null;

  function resetForm() {
    form.reset();
    idField.value = '';
    editingId = null;
    formModeLabel.textContent = '商品を登録';
    submitButton.textContent = '登録する';
    cancelEditButton.hidden = true;
    formMessage.textContent = '';
    formMessage.classList.remove('is-error');
  }

  function startEdit(product) {
    editingId = product.id;
    idField.value = String(product.id);
    codeField.value = product.code || '';
    nameField.value = product.name || '';
    categoryField.value = product.category || '';
    priceField.value = product.price ?? '';
    stockField.value = product.stock ?? '';
    unitField.value = product.unit || '';
    noteField.value = product.note || '';

    formModeLabel.textContent = `商品を編集中: ${product.name}`;
    submitButton.textContent = '更新する';
    cancelEditButton.hidden = false;
    formMessage.textContent = '';
    formMessage.classList.remove('is-error');

    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    nameField.focus();
  }

  function readFormValues() {
    return {
      code: codeField.value.trim(),
      name: nameField.value.trim(),
      category: categoryField.value.trim(),
      price: Number(priceField.value),
      stock: Number(stockField.value),
      unit: unitField.value.trim(),
      note: noteField.value.trim(),
    };
  }

  function validate(values) {
    if (!values.name) return '商品名を入力してください。';
    if (!Number.isFinite(values.price) || values.price < 0) return '単価には0以上の数値を入力してください。';
    if (!Number.isInteger(values.stock) || values.stock < 0) return '在庫数には0以上の整数を入力してください。';
    return null;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitButton.disabled) return; // guard against double-tap/double-click firing this twice

    const values = readFormValues();
    const error = validate(values);
    if (error) {
      formMessage.textContent = error;
      formMessage.classList.add('is-error');
      return;
    }

    submitButton.disabled = true;
    try {
      if (editingId) {
        await window.ProductDB.update(editingId, values);
        window.App.showToast('商品を更新しました。');
      } else {
        await window.ProductDB.add(values);
        window.App.showToast('商品を登録しました。');
      }
      resetForm();
      await refreshList();
    } catch (err) {
      console.error(err);
      formMessage.textContent = '保存に失敗しました: ' + err.message;
      formMessage.classList.add('is-error');
    } finally {
      submitButton.disabled = false;
    }
  }

  async function handleDelete(id, name) {
    const ok = window.confirm(`「${name}」を削除します。よろしいですか?`);
    if (!ok) return;
    try {
      await window.ProductDB.remove(id);
      window.App.showToast('商品を削除しました。');
      if (editingId === id) resetForm();
      await refreshList();
    } catch (err) {
      console.error(err);
      window.App.showToast('削除に失敗しました: ' + err.message, true);
    }
  }

  function filterProducts(products, query) {
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) => (
      (p.name || '').toLowerCase().includes(q) ||
      (p.code || '').toLowerCase().includes(q) ||
      (p.category || '').toLowerCase().includes(q)
    ));
  }

  function renderTable(products) {
    tableBody.innerHTML = '';
    emptyState.hidden = products.length !== 0;

    const fragment = document.createDocumentFragment();
    for (const p of products) {
      const tr = document.createElement('tr');
      const isLow = Number(p.stock) <= LOW_STOCK_THRESHOLD;

      tr.innerHTML = `
        <td>${window.App.escapeHtml(p.code) || '-'}</td>
        <td class="name-cell">${window.App.escapeHtml(p.name)}</td>
        <td>${window.App.escapeHtml(p.category) || '-'}</td>
        <td class="num">${window.App.formatCurrency(p.price)}</td>
        <td class="num">
          <span class="stock-badge ${isLow ? 'stock-badge--low' : ''}">${window.App.escapeHtml(p.stock)}</span>
        </td>
        <td>${window.App.escapeHtml(p.unit) || '-'}</td>
        <td>${window.App.formatDateTime(p.updatedAt)}</td>
        <td class="actions-col">
          <div class="row-actions">
            <button type="button" class="btn btn--ghost btn--sm" data-action="edit" data-id="${p.id}">編集</button>
            <button type="button" class="btn btn--danger btn--sm" data-action="delete" data-id="${p.id}">削除</button>
          </div>
        </td>
      `;
      fragment.appendChild(tr);
    }
    tableBody.appendChild(fragment);
  }

  function updateSummary(visibleProducts) {
    const totalItems = allProducts.length;
    const totalStock = allProducts.reduce((sum, p) => sum + (Number(p.stock) || 0), 0);
    const totalValue = allProducts.reduce((sum, p) => sum + (Number(p.stock) || 0) * (Number(p.price) || 0), 0);
    const shown = visibleProducts.length;

    let text = `登録件数: ${totalItems}件 / 在庫合計: ${totalStock} / 在庫評価額: ${window.App.formatCurrency(totalValue)}`;
    if (shown !== totalItems) {
      text = `表示中: ${shown}件 / ` + text;
    }
    summaryStats.textContent = text;
  }

  async function refreshList() {
    try {
      allProducts = await window.ProductDB.getAll();
    } catch (err) {
      console.error(err);
      window.App.showToast('データの読み込みに失敗しました。', true);
      allProducts = [];
    }
    const visible = filterProducts(allProducts, searchInput.value);
    renderTable(visible);
    updateSummary(visible);
  }

  tableBody.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const product = allProducts.find((p) => p.id === id);
    if (!product) return;

    if (btn.dataset.action === 'edit') {
      startEdit(product);
    } else if (btn.dataset.action === 'delete') {
      handleDelete(id, product.name);
    }
  });

  searchInput.addEventListener('input', () => {
    const visible = filterProducts(allProducts, searchInput.value);
    renderTable(visible);
    updateSummary(visible);
  });

  form.addEventListener('submit', handleSubmit);
  cancelEditButton.addEventListener('click', resetForm);

  function exportJSON() {
    if (allProducts.length === 0) {
      window.App.showToast('エクスポートするデータがありません。', true);
      return;
    }
    const blob = new Blob([JSON.stringify(allProducts, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = url;
    a.download = `products-${stamp}.json`;
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
        .filter((item) => item && typeof item === 'object' && item.name)
        .map((item) => ({
          code: item.code || '',
          name: String(item.name),
          category: item.category || '',
          price: Number(item.price) || 0,
          stock: Number.isInteger(item.stock) ? item.stock : Number(item.stock) || 0,
          unit: item.unit || '',
          note: item.note || '',
          createdAt: item.createdAt,
        }));

      if (cleaned.length === 0) throw new Error('インポート可能な商品データが見つかりませんでした。');

      await window.ProductDB.bulkAdd(cleaned);
      window.App.showToast(`${cleaned.length}件の商品をインポートしました。`);
      await refreshList();
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

  window.ProductsView = { refreshList };
  window.Router.onViewActivate('products', refreshList);
})();