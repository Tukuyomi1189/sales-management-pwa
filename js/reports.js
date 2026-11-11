/* Reports view: period or event filtering, stat tiles, daily trend chart, rankings (the 精算
 * and 在庫の照合 sections are in js/settlement.js and js/events.js). */

(() => {
  'use strict';

  const presetSelect = document.getElementById('report-preset');
  const fromInput = document.getElementById('report-from');
  const toInput = document.getElementById('report-to');
  const statTilesContainer = document.getElementById('report-stat-tiles');
  const dailyChartContainer = document.getElementById('report-daily-chart');
  const productRankingContainer = document.getElementById('report-product-ranking');
  const customerRankingContainer = document.getElementById('report-customer-ranking');
  const reportsPanel = document.querySelector('[data-view-panel="reports"]');
  const chartModeButtons = document.querySelectorAll('.chart-mode-toggle__btn');
  const hourlyDateField = document.getElementById('hourly-date-field');
  const hourlyDateInput = document.getElementById('report-hourly-date');

  const eventDetail = document.getElementById('report-event-detail');
  const eventText = document.getElementById('report-event-text');
  const eventEditButton = document.getElementById('report-event-edit');
  const eventDeleteButton = document.getElementById('report-event-delete');
  const eventAddPastButton = document.getElementById('report-event-add-past');
  const EVENT_PREFIX = 'event:';

  let allSalesCache = [];
  let eventsCache = [];
  let lastDailyPoints = null;
  let initialized = false;
  let chartMode = 'daily';

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function toISODate(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function computeRange(preset) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    switch (preset) {
      case 'this-month': {
        const from = new Date(today.getFullYear(), today.getMonth(), 1);
        return { from: toISODate(from), to: toISODate(today) };
      }
      case 'last-month': {
        const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        const to = new Date(today.getFullYear(), today.getMonth(), 0);
        return { from: toISODate(from), to: toISODate(to) };
      }
      case 'last-7': {
        const from = new Date(today);
        from.setDate(from.getDate() - 6);
        return { from: toISODate(from), to: toISODate(today) };
      }
      case 'last-30': {
        const from = new Date(today);
        from.setDate(from.getDate() - 29);
        return { from: toISODate(from), to: toISODate(today) };
      }
      case 'all':
      default:
        return { from: '', to: '' };
    }
  }

  function filterByRange(sales, from, to) {
    return sales.filter((s) => (!from || s.date >= from) && (!to || s.date <= to));
  }

  // ---------- Stat tiles ----------

  function renderStatTiles(filtered) {
    const total = filtered.reduce((sum, s) => sum + (Number(s.totalAmount) || 0), 0);
    const count = filtered.length;
    const avg = count ? total / count : 0;

    statTilesContainer.innerHTML = `
      <div class="stat-tile">
        <div class="stat-tile__label">期間合計売上</div>
        <div class="stat-tile__value">${window.App.formatCurrency(total)}</div>
      </div>
      <div class="stat-tile">
        <div class="stat-tile__label">件数</div>
        <div class="stat-tile__value">${count.toLocaleString('ja-JP')}件</div>
      </div>
      <div class="stat-tile">
        <div class="stat-tile__label">平均客単価</div>
        <div class="stat-tile__value">${window.App.formatCurrency(avg)}</div>
      </div>
    `;
  }

  // ---------- Daily trend chart (SVG column chart) ----------

  function buildSeries(filtered, fromStr, toStr) {
    const fromDate = new Date(fromStr + 'T00:00:00');
    const toDate = new Date(toStr + 'T00:00:00');
    const dayCount = Math.round((toDate - fromDate) / 86400000) + 1;

    const amountByDate = new Map();
    for (const s of filtered) {
      amountByDate.set(s.date, (amountByDate.get(s.date) || 0) + (Number(s.totalAmount) || 0));
    }

    if (dayCount <= 62) {
      const points = [];
      for (let i = 0; i < dayCount; i++) {
        const d = new Date(fromDate);
        d.setDate(d.getDate() + i);
        const key = toISODate(d);
        points.push({ key, label: `${d.getMonth() + 1}/${d.getDate()}`, amount: amountByDate.get(key) || 0 });
      }
      return points;
    }

    const amountByMonth = new Map();
    for (const [dateKey, amount] of amountByDate) {
      const monthKey = dateKey.slice(0, 7);
      amountByMonth.set(monthKey, (amountByMonth.get(monthKey) || 0) + amount);
    }
    const points = [];
    const cursor = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);
    const end = new Date(toDate.getFullYear(), toDate.getMonth(), 1);
    while (cursor <= end) {
      const key = `${cursor.getFullYear()}-${pad2(cursor.getMonth() + 1)}`;
      points.push({ key, label: `${cursor.getFullYear()}/${pad2(cursor.getMonth() + 1)}`, amount: amountByMonth.get(key) || 0 });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return points;
  }

  function niceStep(maxValue, targetTicks = 4) {
    if (maxValue <= 0) return 1;
    const roughStep = maxValue / targetTicks;
    const magnitude = 10 ** Math.floor(Math.log10(roughStep));
    const residual = roughStep / magnitude;
    let step;
    if (residual > 5) step = 10 * magnitude;
    else if (residual > 2) step = 5 * magnitude;
    else if (residual > 1) step = 2 * magnitude;
    else step = magnitude;
    return step;
  }

  function roundedTopBarPath(x, yTop, w, h, r) {
    if (h <= 0) return '';
    const yBase = yTop + h;
    return `M${x},${yBase} L${x},${yTop + r} Q${x},${yTop} ${x + r},${yTop} ` +
      `L${x + w - r},${yTop} Q${x + w},${yTop} ${x + w},${yTop + r} L${x + w},${yBase} Z`;
  }

  function renderColumnChart(container, points, chartLabel = '売上推移グラフ') {
    const width = Math.max(280, Math.round(container.clientWidth || 320));
    const height = 220;
    const marginLeft = 52;
    const marginRight = 12;
    const marginTop = 16;
    const marginBottom = 26;
    const plotWidth = width - marginLeft - marginRight;
    const plotHeight = height - marginTop - marginBottom;

    const maxValue = Math.max(1, ...points.map((p) => p.amount));
    const step = niceStep(maxValue);
    const niceMax = Math.ceil(maxValue / step) * step;
    const tickCount = Math.round(niceMax / step);

    const n = points.length;
    const bandWidth = plotWidth / n;
    const barWidth = Math.max(2, Math.min(24, bandWidth * 0.6));
    const yScale = (v) => marginTop + plotHeight - (v / niceMax) * plotHeight;
    const baselineY = marginTop + plotHeight;

    let gridSvg = '';
    for (let i = 0; i <= tickCount; i++) {
      const v = i * step;
      const y = yScale(v);
      gridSvg += `<line x1="${marginLeft}" y1="${y}" x2="${width - marginRight}" y2="${y}" class="chart-grid-line" />`;
      gridSvg += `<text x="${marginLeft - 8}" y="${y}" class="chart-axis-label" text-anchor="end" dominant-baseline="middle">${Math.round(v).toLocaleString('ja-JP')}</text>`;
    }

    const maxLabels = Math.max(1, Math.floor(plotWidth / 42));
    const labelStep = Math.max(1, Math.ceil(n / maxLabels));

    let barsSvg = '';
    let xLabelsSvg = '';
    points.forEach((p, i) => {
      const x = marginLeft + i * bandWidth + (bandWidth - barWidth) / 2;
      const yTop = yScale(p.amount);
      const barHeight = Math.max(0, baselineY - yTop);
      const r = Math.max(0, Math.min(4, barWidth / 2, barHeight / 2));
      barsSvg += `<path d="${roundedTopBarPath(x, yTop, barWidth, barHeight, r)}" class="chart-bar"><title>${window.App.escapeHtml(p.label)}: ${window.App.formatCurrency(p.amount)}</title></path>`;
      if (i % labelStep === 0) {
        xLabelsSvg += `<text x="${x + barWidth / 2}" y="${height - 6}" class="chart-axis-label" text-anchor="middle">${window.App.escapeHtml(p.label)}</text>`;
      }
    });

    container.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${window.App.escapeHtml(chartLabel)}">
        ${gridSvg}
        <line x1="${marginLeft}" y1="${baselineY}" x2="${width - marginRight}" y2="${baselineY}" class="chart-baseline" />
        ${barsSvg}
        ${xLabelsSvg}
      </svg>
    `;
  }

  function renderDailyChart(filtered, from, to) {
    if (filtered.length === 0) {
      dailyChartContainer.innerHTML = '<p class="empty-state">対象期間の売上データがありません。</p>';
      lastDailyPoints = null;
      return;
    }
    let chartFrom = from;
    let chartTo = to;
    if (!chartFrom || !chartTo) {
      const dates = filtered.map((s) => s.date).sort();
      chartFrom = chartFrom || dates[0];
      chartTo = chartTo || dates[dates.length - 1];
    }
    const points = buildSeries(filtered, chartFrom, chartTo);
    lastDailyPoints = points;
    renderColumnChart(dailyChartContainer, points, '日別売上推移グラフ');
  }

  // ---------- Hourly trend chart (for a single selected day) ----------

  function buildHourlySeries(dayStr) {
    const daySales = allSalesCache.filter((s) => s.date === dayStr);
    const amountByHour = new Array(24).fill(0);
    for (const s of daySales) {
      const hour = new Date(s.createdAt).getHours();
      amountByHour[hour] += Number(s.totalAmount) || 0;
    }
    return amountByHour.map((amount, hour) => ({ key: String(hour), label: `${hour}時`, amount }));
  }

  function renderHourlyChart() {
    if (!hourlyDateInput.value) {
      hourlyDateInput.value = toISODate(new Date());
    }
    const dayStr = hourlyDateInput.value;
    const points = buildHourlySeries(dayStr);

    if (!points.some((p) => p.amount > 0)) {
      dailyChartContainer.innerHTML = `<p class="empty-state">${window.App.escapeHtml(dayStr)} の売上データがありません。</p>`;
      lastDailyPoints = null;
      return;
    }
    lastDailyPoints = points;
    renderColumnChart(dailyChartContainer, points, '時間帯別売上推移グラフ');
  }

  function renderChart(filtered, from, to) {
    if (chartMode === 'hourly') {
      renderHourlyChart();
    } else {
      renderDailyChart(filtered, from, to);
    }
  }

  // ---------- Rankings (product / customer) ----------

  function aggregateProducts(filtered) {
    const map = new Map();
    for (const s of filtered) {
      for (const item of s.items) {
        // Old sales carry numeric ids, new ones strings (12 ≡ "12") — normalise before grouping.
        const key = item.productId != null && item.productId !== '' ? `id:${item.productId}` : `name:${item.productName}`;
        const prev = map.get(key) || { name: item.productName, amount: 0, qty: 0 };
        prev.amount += Number(item.unitPrice) * Number(item.quantity);
        prev.qty += Number(item.quantity) || 0;
        map.set(key, prev);
      }
    }
    return [...map.values()].sort((a, b) => b.amount - a.amount || b.qty - a.qty).slice(0, 8);
  }

  function aggregateCustomers(filtered) {
    const map = new Map();
    for (const s of filtered) {
      const key = s.customerId || 'none';
      const name = s.customerName || '一般客';
      const prev = map.get(key) || { name, amount: 0 };
      prev.amount += Number(s.totalAmount) || 0;
      map.set(key, prev);
    }
    return [...map.values()].sort((a, b) => b.amount - a.amount).slice(0, 8);
  }

  function renderRanking(container, rows) {
    if (rows.length === 0) {
      container.innerHTML = '<p class="empty-state">対象期間のデータがありません。</p>';
      return;
    }
    const max = rows[0].amount || 1;
    container.innerHTML = rows.map((r) => `
      <div class="ranking-row">
        <div class="ranking-row__label" title="${window.App.escapeHtml(r.name)}">${window.App.escapeHtml(r.name)}</div>
        <div class="ranking-row__track">
          <div class="ranking-row__bar" style="width:${Math.max(4, (r.amount / max) * 100)}%"></div>
        </div>
        <div class="ranking-row__value">${window.App.formatCurrency(r.amount)}${r.qty != null ? ` ・${r.qty}点` : ''}</div>
      </div>
    `).join('');
  }

  // ---------- Orchestration ----------

  // ---------- Events in the period select ----------

  function selectedEvent() {
    const v = presetSelect.value;
    return v.startsWith(EVENT_PREFIX) ? eventsCache.find((e) => e.id === v.slice(EVENT_PREFIX.length)) : undefined;
  }

  /** Rebuild the 「イベント」 group of the period select, keeping the current choice if it still exists. */
  function renderEventOptions(selectValue = presetSelect.value) {
    presetSelect.querySelector('optgroup[data-events]')?.remove();
    if (eventsCache.length) {
      const group = document.createElement('optgroup');
      group.label = 'イベント';
      group.dataset.events = '';
      for (const e of eventsCache) {
        const opt = document.createElement('option');
        opt.value = EVENT_PREFIX + e.id;
        opt.textContent = `${e.closedAt ? '' : '[開催中] '}${e.name}(${window.EventDB.datesText(e)})`;
        group.append(opt);
      }
      presetSelect.append(group);
    }
    const exists = [...presetSelect.options].some((o) => o.value === selectValue);
    presetSelect.value = exists ? selectValue : 'this-month';
  }

  function renderEventDetail(event) {
    eventDetail.hidden = !event;
    if (!event) return;
    const fmt = window.App.formatDateTime;
    const state = !event.closedAt ? `開催中(${fmt(event.startedAt)} に開始)`
      : event.past ? '過去のイベント(在庫の記録なし)'
      : `${fmt(event.startedAt)} 開始 〜 ${fmt(event.closedAt)} 締め`;
    eventText.innerHTML = `<strong>${window.App.escapeHtml(event.name)}</strong>(${window.App.escapeHtml(window.EventDB.datesText(event))})・${window.App.escapeHtml(state)}`;
  }

  eventEditButton.addEventListener('click', () => {
    const event = selectedEvent();
    if (!event) return;
    window.EventsView.openForm({
      title: 'イベントの名前・日付を変更',
      submitLabel: '変更する',
      hint: '日付を変えると、イベントの記録がない売上(導入前の売上など)のうち、どれをこのイベントとして集計するかも変わります。',
      initial: event,
      submit: (values) => window.EventDB.update(event.id, values),
    });
  });

  eventDeleteButton.addEventListener('click', async () => {
    const event = selectedEvent();
    if (!event) return;
    if (!window.confirm(`イベント「${event.name}」を削除します。売上と在庫は変わりません(このイベントの売上は、日付で集計されるようになります)。\n\n削除しますか?`)) return;
    await window.EventDB.remove(event.id);
    presetSelect.value = 'this-month';
    render();
    window.App.showToast(`イベント「${event.name}」を削除しました。`);
  });

  eventAddPastButton.addEventListener('click', () => {
    window.EventsView.openForm({
      title: '過去のイベントを登録',
      submitLabel: '登録する',
      hint: '開催日に記録された売上が、このイベントとして集計されます(在庫の記録はないので、在庫の照合は出ません)。',
      submit: async (values) => {
        const id = await window.EventDB.addPast(values);
        eventsCache = await window.EventDB.getAll();
        renderEventOptions(EVENT_PREFIX + id);
        render();
      },
    });
  });

  // After every script has run (see js/events.js: the first update can arrive before app.js).
  const subscribeEvents = () => window.EventDB.subscribe(async () => {
    eventsCache = await window.EventDB.getAll();
    renderEventOptions();
    if (reportsPanel && !reportsPanel.hidden) render();
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', subscribeEvents, { once: true });
  else subscribeEvents();

  function render() {
    const preset = presetSelect.value;
    const event = selectedEvent();
    let from;
    let to;
    if (event) {
      from = event.startDate;
      to = event.endDate || event.startDate;
      fromInput.value = from;
      toInput.value = to;
    } else if (preset === 'custom') {
      from = fromInput.value;
      to = toInput.value;
    } else {
      ({ from, to } = computeRange(preset));
      fromInput.value = from;
      toInput.value = to;
    }

    const filtered = event ? window.EventDB.salesOf(event, allSalesCache) : filterByRange(allSalesCache, from, to);
    renderEventDetail(event);
    renderStatTiles(filtered);
    renderChart(filtered, from, to);
    renderRanking(productRankingContainer, aggregateProducts(filtered));
    renderRanking(customerRankingContainer, aggregateCustomers(filtered));
    const label = event ? `イベント: ${event.name}(${window.EventDB.datesText(event)})` : '';
    window.SettlementView?.render(filtered, { from, to, label });
    window.EventsView?.renderReconcile(event, filtered);
  }

  presetSelect.addEventListener('change', render);
  fromInput.addEventListener('change', () => {
    presetSelect.value = 'custom';
    render();
  });
  toInput.addEventListener('change', () => {
    presetSelect.value = 'custom';
    render();
  });

  chartModeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (chartMode === btn.dataset.chartMode) return;
      chartMode = btn.dataset.chartMode;
      chartModeButtons.forEach((b) => b.classList.toggle('is-active', b === btn));
      hourlyDateField.hidden = chartMode !== 'hourly';
      render();
    });
  });

  hourlyDateInput.addEventListener('change', () => {
    if (chartMode === 'hourly') render();
  });

  function debounce(fn, wait) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  window.addEventListener('resize', debounce(() => {
    if (reportsPanel && !reportsPanel.hidden && lastDailyPoints) {
      const label = chartMode === 'hourly' ? '時間帯別売上推移グラフ' : '日別売上推移グラフ';
      renderColumnChart(dailyChartContainer, lastDailyPoints, label);
    }
  }, 200));

  async function activate() {
    allSalesCache = await window.SalesDB.getAll();
    eventsCache = await window.EventDB.getAll();
    renderEventOptions();
    if (!initialized) {
      presetSelect.value = 'this-month';
      hourlyDateInput.value = toISODate(new Date());
      initialized = true;
    }
    render();
  }

  window.ReportsView = { refresh: activate };
  window.Router.onViewActivate('reports', activate);
})();
