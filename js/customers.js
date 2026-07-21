/* Customer master view: registration form, search, list. */

(() => {
  'use strict';

  const form = document.getElementById('customer-form');
  const idField = document.getElementById('customer-id');
  const nameField = document.getElementById('customer-field-name');
  const contactField = document.getElementById('customer-field-contact');
  const phoneField = document.getElementById('customer-field-phone');
  const emailField = document.getElementById('customer-field-email');
  const addressField = document.getElementById('customer-field-address');
  const noteField = document.getElementById('customer-field-note');

  const formModeLabel = document.getElementById('customer-form-mode-label');
  const submitButton = document.getElementById('customer-submit-button');
  const cancelEditButton = document.getElementById('customer-cancel-edit-button');
  const formMessage = document.getElementById('customer-form-message');

  const searchInput = document.getElementById('customer-search-input');
  const tableBody = document.getElementById('customer-table-body');
  const emptyState = document.getElementById('customer-empty-state');
  const summaryStats = document.getElementById('customer-summary-stats');

  let allCustomers = [];
  let editingId = null;

  function resetForm() {
    form.reset();
    idField.value = '';
    editingId = null;
    formModeLabel.textContent = '顧客を登録';
    submitButton.textContent = '登録する';
    cancelEditButton.hidden = true;
    formMessage.textContent = '';
    formMessage.classList.remove('is-error');
  }

  function startEdit(customer) {
    editingId = customer.id;
    idField.value = String(customer.id);
    nameField.value = customer.name || '';
    contactField.value = customer.contactName || '';
    phoneField.value = customer.phone || '';
    emailField.value = customer.email || '';
    addressField.value = customer.address || '';
    noteField.value = customer.note || '';

    formModeLabel.textContent = `顧客を編集中: ${customer.name}`;
    submitButton.textContent = '更新する';
    cancelEditButton.hidden = false;
    formMessage.textContent = '';
    formMessage.classList.remove('is-error');

    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    nameField.focus();
  }

  function readFormValues() {
    return {
      name: nameField.value.trim(),
      contactName: contactField.value.trim(),
      phone: phoneField.value.trim(),
      email: emailField.value.trim(),
      address: addressField.value.trim(),
      note: noteField.value.trim(),
    };
  }

  function validate(values) {
    if (!values.name) return '顧客名を入力してください。';
    return null;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const values = readFormValues();
    const error = validate(values);
    if (error) {
      formMessage.textContent = error;
      formMessage.classList.add('is-error');
      return;
    }

    try {
      if (editingId) {
        await window.CustomerDB.update(editingId, values);
        window.App.showToast('顧客を更新しました。');
      } else {
        await window.CustomerDB.add(values);
        window.App.showToast('顧客を登録しました。');
      }
      resetForm();
      await refreshList();
      window.SalesView?.refreshCustomerOptions();
    } catch (err) {
      console.error(err);
      formMessage.textContent = '保存に失敗しました: ' + err.message;
      formMessage.classList.add('is-error');
    }
  }

  async function handleDelete(id, name) {
    const ok = window.confirm(`「${name}」を削除します。過去の売上記録には顧客名がそのまま残ります。よろしいですか?`);
    if (!ok) return;
    try {
      await window.CustomerDB.remove(id);
      window.App.showToast('顧客を削除しました。');
      if (editingId === id) resetForm();
      await refreshList();
      window.SalesView?.refreshCustomerOptions();
    } catch (err) {
      console.error(err);
      window.App.showToast('削除に失敗しました: ' + err.message, true);
    }
  }

  function filterCustomers(customers, query) {
    const q = query.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter((c) => (
      (c.name || '').toLowerCase().includes(q) ||
      (c.contactName || '').toLowerCase().includes(q)
    ));
  }

  function renderTable(customers) {
    tableBody.innerHTML = '';
    emptyState.hidden = customers.length !== 0;

    const fragment = document.createDocumentFragment();
    for (const c of customers) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="name-cell">${window.App.escapeHtml(c.name)}</td>
        <td>${window.App.escapeHtml(c.contactName) || '-'}</td>
        <td>${window.App.escapeHtml(c.phone) || '-'}</td>
        <td>${window.App.escapeHtml(c.email) || '-'}</td>
        <td>${window.App.escapeHtml(c.address) || '-'}</td>
        <td>${window.App.formatDateTime(c.updatedAt)}</td>
        <td class="actions-col">
          <div class="row-actions">
            <button type="button" class="btn btn--ghost btn--sm" data-action="edit" data-id="${c.id}">編集</button>
            <button type="button" class="btn btn--danger btn--sm" data-action="delete" data-id="${c.id}">削除</button>
          </div>
        </td>
      `;
      fragment.appendChild(tr);
    }
    tableBody.appendChild(fragment);
  }

  function updateSummary(visibleCustomers) {
    const total = allCustomers.length;
    const shown = visibleCustomers.length;
    summaryStats.textContent = shown !== total
      ? `表示中: ${shown}件 / 登録件数: ${total}件`
      : `登録件数: ${total}件`;
  }

  async function refreshList() {
    try {
      allCustomers = await window.CustomerDB.getAll();
    } catch (err) {
      console.error(err);
      window.App.showToast('データの読み込みに失敗しました。', true);
      allCustomers = [];
    }
    const visible = filterCustomers(allCustomers, searchInput.value);
    renderTable(visible);
    updateSummary(visible);
  }

  tableBody.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const customer = allCustomers.find((c) => c.id === id);
    if (!customer) return;

    if (btn.dataset.action === 'edit') {
      startEdit(customer);
    } else if (btn.dataset.action === 'delete') {
      handleDelete(id, customer.name);
    }
  });

  searchInput.addEventListener('input', () => {
    const visible = filterCustomers(allCustomers, searchInput.value);
    renderTable(visible);
    updateSummary(visible);
  });

  form.addEventListener('submit', handleSubmit);
  cancelEditButton.addEventListener('click', resetForm);

  window.CustomersView = { refreshList };
  window.Router.onViewActivate('customers', refreshList);
})();
