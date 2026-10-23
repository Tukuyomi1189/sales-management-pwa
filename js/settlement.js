/* 精算 (settlement) section of the レポート view: totals per payee (精算先) for the
 * report's selected period, with an ad-hoc "selected products" sum and CSV export.
 *
 * Which payee a sold line belongs to:
 *   1. the payee snapshotted on the sale line at the time of sale (item.payee), else
 *   2. the product's CURRENT payee in this device's product master (so sales made before
 *      payees were set up still land with the right person), else
 *   3. 未設定.
 * Prices/quantities always come from the sale itself, never from the current master.
 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const body = $('settlement-body');
  const periodNote = $('settlement-period');
  const csvButton = $('settlement-csv-button');
  const selectionBar = $('settlement-selection');
  const selectionDetail = $('settlement-selection-detail');
  const selectionTotal = $('settlement-selection-total');
  const selectionClear = $('settlement-selection-clear');

  const UNASSIGNED = '未設定';

  let groups = []; // [{ payee, rows: [{ key, name, code, prices:Set, qty, amount }], qty, amount }]
  let rowsByKey = new Map();
  let selected = new Set(); // product keys, kept across period changes
  let period = { from: '', to: '' };

  const fmt = (n) => window.App.formatCurrency(n);
  const esc = (s) => window.App.escapeHtml(s);

  function lineKey(item) {
    return item.productId != null && item.productId !== '' ? `id:${item.productId}` : `name:${item.productName}`;
  }

  async function aggregate(sales) {
    const products = await window.ProductDB.getAll();
    const byId = new Map(products.map((p) => [p.id, p]));
    const byName = new Map(products.map((p) => [p.name, p]));

    const rows = new Map();
    for (const sale of sales) {
      for (const item of sale.items || []) {
        const product = byId.get(Number(item.productId)) || byName.get(item.productName);
        const payee = (item.payee || '').trim() || (product?.payee || '').trim() || UNASSIGNED;
        const key = lineKey(item);
        // Same product can end up under two payees (payee changed mid-period) — keep them apart.
        const rowKey = `${encodeURIComponent(payee)}|${key}`;
        let row = rows.get(rowKey);
        if (!row) {
          row = { key: rowKey, payee, name: item.productName, code: product?.code || '', prices: new Set(), qty: 0, amount: 0 };
          rows.set(rowKey, row);
        }
        const qty = Number(item.quantity) || 0;
        const price = Number(item.unitPrice) || 0;
        row.prices.add(price);
        row.qty += qty;
        row.amount += qty * price;
      }
    }

    const byPayee = new Map();
    for (const row of rows.values()) {
      if (!byPayee.has(row.payee)) byPayee.set(row.payee, { payee: row.payee, rows: [], qty: 0, amount: 0 });
      const g = byPayee.get(row.payee);
      g.rows.push(row);
      g.qty += row.qty;
      g.amount += row.amount;
    }
    const sortRows = (a, b) => (a.code || '￿').localeCompare(b.code || '￿', 'ja', { numeric: true }) || a.name.localeCompare(b.name, 'ja');
    for (const g of byPayee.values()) g.rows.sort(sortRows);
    return [...byPayee.values()].sort((a, b) => {
      if (a.payee === UNASSIGNED) return 1;
      if (b.payee === UNASSIGNED) return -1;
      return a.payee.localeCompare(b.payee, 'ja');
    });
  }

  function priceText(row) {
    if (row.prices.size === 1) return fmt([...row.prices][0]);
    const list = [...row.prices].sort((a, b) => a - b);
    return `${fmt(list[0])}〜${fmt(list[list.length - 1])}`;
  }

  function periodText() {
    const { from, to } = period;
    if (!from && !to) return '集計期間: 全期間';
    return `集計期間: ${from || '最初'} 〜 ${to || '最新'}`;
  }

  function renderBody() {
    periodNote.textContent = `${periodText()}(上の「集計期間」で変更できます)。商品マスタの「精算先」ごとに集計します。`;
    if (groups.length === 0) {
      body.innerHTML = '<p class="empty-state">対象期間の売上がありません。</p>';
      updateSelection();
      return;
    }
    const grandQty = groups.reduce((s, g) => s + g.qty, 0);
    const grandAmount = groups.reduce((s, g) => s + g.amount, 0);
    const onlyUnassigned = groups.length === 1 && groups[0].payee === UNASSIGNED;

    body.innerHTML = `
      ${onlyUnassigned ? '<p class="settlement-hint">精算先がまだ設定されていません。「商品マスタ」で各商品の「精算先」を入力すると、ここで相手ごとに分かれます。</p>' : ''}
      <div class="settlement-groups">
        ${groups.map((g, gi) => `
          <section class="settlement-group ${g.payee === UNASSIGNED ? 'is-unassigned' : ''}">
            <header class="settlement-group__head">
              <label class="settlement-check">
                <input type="checkbox" data-group="${gi}" aria-label="${esc(g.payee)}の商品をすべて選択" />
                <span class="settlement-group__name">${esc(g.payee)}</span>
              </label>
              <span class="settlement-group__sum"><span class="settlement-qty">${g.qty}点</span><strong>${fmt(g.amount)}</strong></span>
            </header>
            <table class="settlement-table">
              <thead><tr><th></th><th>商品</th><th class="num">単価</th><th class="num">数量</th><th class="num">金額</th></tr></thead>
              <tbody>
                ${g.rows.map((r) => `
                  <tr>
                    <td class="settlement-table__check"><input type="checkbox" data-key="${esc(r.key)}" aria-label="${esc(r.name)}を選択" ${selected.has(r.key) ? 'checked' : ''} /></td>
                    <td>${esc(r.name)}${r.code ? `<span class="payment-detail">${esc(r.code)}</span>` : ''}</td>
                    <td class="num">${priceText(r)}</td>
                    <td class="num">${r.qty}</td>
                    <td class="num">${fmt(r.amount)}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </section>`).join('')}
      </div>
      <div class="settlement-grand">
        <span>総計</span>
        <span class="settlement-qty">${grandQty}点</span>
        <strong>${fmt(grandAmount)}</strong>
      </div>
    `;
    updateSelection();
  }

  function updateSelection() {
    // Drop selections that no longer exist in this period's data.
    selected = new Set([...selected].filter((k) => rowsByKey.has(k)));
    let qty = 0;
    let amount = 0;
    for (const key of selected) {
      const r = rowsByKey.get(key);
      qty += r.qty;
      amount += r.amount;
    }
    selectionBar.hidden = selected.size === 0;
    selectionDetail.textContent = `${selected.size}商品 ・ ${qty}点`;
    selectionTotal.textContent = fmt(amount);

    // Group checkboxes reflect their rows (all / some / none).
    groups.forEach((g, gi) => {
      const box = body.querySelector(`input[data-group="${gi}"]`);
      if (!box) return;
      const n = g.rows.filter((r) => selected.has(r.key)).length;
      box.checked = n > 0 && n === g.rows.length;
      box.indeterminate = n > 0 && n < g.rows.length;
    });
  }

  body.addEventListener('change', (event) => {
    const box = event.target;
    if (box.dataset.key != null) {
      if (box.checked) selected.add(box.dataset.key);
      else selected.delete(box.dataset.key);
    } else if (box.dataset.group != null) {
      const g = groups[Number(box.dataset.group)];
      for (const r of g.rows) {
        if (box.checked) selected.add(r.key);
        else selected.delete(r.key);
      }
      for (const r of g.rows) {
        const rowBox = body.querySelector(`input[data-key="${CSS.escape(r.key)}"]`);
        if (rowBox) rowBox.checked = box.checked;
      }
    } else {
      return;
    }
    updateSelection();
  });

  selectionClear.addEventListener('click', () => {
    selected.clear();
    for (const box of body.querySelectorAll('input[type="checkbox"]')) box.checked = false;
    updateSelection();
  });

  // ---------- CSV ----------

  function csvCell(v) {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function exportCSV() {
    if (groups.length === 0) {
      window.App.showToast('対象期間の売上がありません。', true);
      return;
    }
    const lines = [[periodText()], ['精算先', '商品コード', '商品名', '単価', '数量', '金額']];
    for (const g of groups) {
      for (const r of g.rows) {
        lines.push([g.payee, r.code, r.name, r.prices.size === 1 ? [...r.prices][0] : [...r.prices].sort((a, b) => a - b).join('/'), r.qty, r.amount]);
      }
      lines.push([`${g.payee} 小計`, '', '', '', g.qty, g.amount]);
    }
    lines.push(['総計', '', '', '', groups.reduce((s, g) => s + g.qty, 0), groups.reduce((s, g) => s + g.amount, 0)]);
    const csv = '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n'); // BOM: Excel opens UTF-8 correctly
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `settlement-${period.from || 'all'}_${period.to || 'all'}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    window.App.showToast('精算結果をCSVで保存しました。');
  }

  csvButton.addEventListener('click', exportCSV);

  let renderSeq = 0;
  async function render(filteredSales, range) {
    const seq = ++renderSeq;
    period = range || { from: '', to: '' };
    const result = await aggregate(filteredSales);
    if (seq !== renderSeq) return; // a newer period was chosen while this one was loading
    groups = result;
    rowsByKey = new Map(groups.flatMap((g) => g.rows.map((r) => [r.key, r])));
    renderBody();
  }

  window.SettlementView = { render };
})();
