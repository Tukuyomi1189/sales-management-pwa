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
  const stockSourceField = document.getElementById('field-stock-source');
  const payeeField = document.getElementById('field-payee');
  const payeeOptions = document.getElementById('payee-options');
  const stockSourceHint = document.getElementById('field-stock-source-hint');
  const stockReq = document.getElementById('field-stock-req');

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
  let editingOriginalCode = '';

  const esc = (s) => window.App.escapeHtml(s);

  // ---------- Shared stock (在庫を共有する商品) ----------
  // A product with `stockSourceCode` uses the stock of the product with that code (see
  // ProductDB.getStockOwner in db.js). Linked by code because ids change on JSON import.

  const codeOf = (p) => String(p.code || '').trim();
  const sourceCodeOf = (p) => String(p.stockSourceCode || '').trim();

  function findByCode(code) {
    return code ? allProducts.find((p) => codeOf(p) === code) : undefined;
  }

  /** Products that share `product`'s stock (i.e. point at its code). */
  function dependentsOf(product, code = codeOf(product)) {
    return code ? allProducts.filter((p) => p.id !== product.id && sourceCodeOf(p) === code) : [];
  }

  function stockSourceOf(product) {
    const source = findByCode(sourceCodeOf(product));
    return source && source.id !== product.id ? source : undefined;
  }

  /** Fill the 「在庫を共有する商品」 select: only products with a code that don't themselves borrow stock (no chains). */
  function renderStockSourceOptions(selected = '') {
    const candidates = allProducts
      .filter((p) => codeOf(p) && !sourceCodeOf(p) && p.id !== editingId)
      .sort((a, b) => codeOf(a).localeCompare(codeOf(b), 'ja', { numeric: true }));
    stockSourceField.innerHTML = '<option value="">共有しない</option>' +
      candidates.map((p) => `<option value="${esc(codeOf(p))}">${esc(codeOf(p))} ${esc(p.name)}(在庫 ${esc(p.stock)})</option>`).join('');
    if (selected && !candidates.some((p) => codeOf(p) === selected)) {
      // Keep a dangling link visible instead of silently dropping it.
      stockSourceField.insertAdjacentHTML('beforeend', `<option value="${esc(selected)}">${esc(selected)}(見つかりません)</option>`);
    }
    stockSourceField.value = selected;

    // A product that others already borrow from can't borrow from someone else.
    const editing = editingId ? allProducts.find((p) => p.id === editingId) : null;
    const hasDependents = editing && dependentsOf(editing).length > 0;
    stockSourceField.disabled = !!hasDependents;
    stockSourceHint.textContent = hasDependents
      ? `この商品の在庫は ${dependentsOf(editing).map((p) => p.name).join('、')} と共有されています`
      : '無償譲渡用など、別の商品と在庫を共通にするときに選択';
    syncStockFieldState();
  }

  function syncStockFieldState() {
    const linked = !!stockSourceField.value;
    stockField.disabled = linked;
    stockField.required = !linked;
    stockReq.hidden = linked;
    stockField.placeholder = linked ? '共有元の在庫を使用' : '例: 10';
    if (linked) stockField.value = '';
  }

  stockSourceField.addEventListener('change', syncStockFieldState);

  function resetForm() {
    form.reset();
    idField.value = '';
    editingId = null;
    editingOriginalCode = '';
    renderStockSourceOptions('');
    formModeLabel.textContent = '商品を登録';
    submitButton.textContent = '登録する';
    cancelEditButton.hidden = true;
    formMessage.textContent = '';
    formMessage.classList.remove('is-error');
  }

  function startEdit(product) {
    editingId = product.id;
    editingOriginalCode = codeOf(product);
    idField.value = String(product.id);
    codeField.value = product.code || '';
    nameField.value = product.name || '';
    categoryField.value = product.category || '';
    priceField.value = product.price ?? '';
    stockField.value = product.stock ?? '';
    unitField.value = product.unit || '';
    noteField.value = product.note || '';
    payeeField.value = product.payee || '';
    renderStockSourceOptions(sourceCodeOf(product));

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
      stockSourceCode: stockSourceField.value.trim(),
      payee: payeeField.value.trim(),
    };
  }

  function validate(values) {
    if (!values.name) return '商品名を入力してください。';
    if (!Number.isFinite(values.price) || values.price < 0) return '単価には0以上の数値を入力してください。';
    if (values.stockSourceCode) {
      if (values.stockSourceCode === values.code) return '自分自身とは在庫を共有できません。';
      values.stock = 0; // unused: the source product's stock is used
    } else if (!Number.isInteger(values.stock) || values.stock < 0) {
      return '在庫数には0以上の整数を入力してください。';
    }
    if (editingId) {
      const editing = allProducts.find((p) => p.id === editingId);
      const dependents = editing ? dependentsOf(editing, editingOriginalCode) : [];
      if (dependents.length && !values.code) {
        return `「${dependents.map((p) => p.name).join('、')}」がこの商品の在庫を共有しているため、商品コードを空にできません。`;
      }
    }
    if (values.code && allProducts.some((p) => p.id !== editingId && codeOf(p) === values.code)) {
      return `商品コード「${values.code}」は他の商品で使われています。`;
    }
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
        const editing = allProducts.find((p) => p.id === editingId);
        const dependents = editing ? dependentsOf(editing, editingOriginalCode) : [];
        await window.ProductDB.update(editingId, values);
        // Code changed: re-point the products that share this product's stock.
        if (values.code !== editingOriginalCode) {
          for (const d of dependents) await window.ProductDB.update(d.id, { stockSourceCode: values.code });
        }
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
    const product = allProducts.find((p) => p.id === id);
    const dependents = product ? dependentsOf(product) : [];
    if (dependents.length) {
      window.App.showToast(`「${dependents.map((p) => p.name).join('、')}」がこの商品の在庫を共有しているため削除できません。先にそちらの共有を解除するか削除してください。`, true);
      return;
    }
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
      const source = sourceCodeOf(p) ? stockSourceOf(p) : null;
      const isLow = Number((source || p).stock) <= LOW_STOCK_THRESHOLD;
      const stockCell = sourceCodeOf(p)
        ? (source
          ? `<span class="stock-badge stock-badge--shared ${isLow ? 'stock-badge--low' : ''}" title="${esc(source.name)} と在庫を共有">${esc(source.stock)}</span><span class="payment-detail">${esc(codeOf(source))} と共有</span>`
          : `<span class="stock-badge stock-badge--low">共有元なし</span><span class="payment-detail">${esc(sourceCodeOf(p))} が見つかりません</span>`)
        : `<span class="stock-badge ${isLow ? 'stock-badge--low' : ''}">${esc(p.stock)}</span>`;

      tr.innerHTML = `
        <td>${window.App.escapeHtml(p.code) || '-'}</td>
        <td class="name-cell">${esc(p.name)}${p.payee ? `<span class="payment-detail">精算先: ${esc(p.payee)}</span>` : ''}</td>
        <td>${window.App.escapeHtml(p.category) || '-'}</td>
        <td class="num">${window.App.formatCurrency(p.price)}</td>
        <td class="num">${stockCell}</td>
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
    // Shared-stock products don't hold stock of their own — don't count it twice.
    const owners = allProducts.filter((p) => !sourceCodeOf(p) || !stockSourceOf(p));
    const totalStock = owners.reduce((sum, p) => sum + (Number(p.stock) || 0), 0);
    const totalValue = owners.reduce((sum, p) => sum + (Number(p.stock) || 0) * (Number(p.price) || 0), 0);
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
    if (!stockSourceField.matches(':focus')) renderStockSourceOptions(stockSourceField.value);
    // Suggest payees already in use so the same person isn't typed two different ways.
    const payees = [...new Set(allProducts.map((p) => (p.payee || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
    payeeOptions.innerHTML = payees.map((name) => `<option value="${esc(name)}"></option>`).join('');
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
          stockSourceCode: item.stockSourceCode ? String(item.stockSourceCode).trim() : '',
          payee: item.payee ? String(item.payee).trim() : '',
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