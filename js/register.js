/* Register (レジ) view: POS-style product buttons + receipt-style cart + checkout dialog
 * (tender / change / void). Stock is deducted via SalesDB like before.
 *
 * Responsiveness notes: tapping a product / stepping a quantity only patches what
 * changed (one tile badge, one cart row, the totals) instead of rebuilding the grid
 * and the cart. The grid is rebuilt only when the product master changes; category
 * tabs and search just toggle `hidden` on existing tiles.
 */

(() => {
  'use strict';

  /**
   * Payment methods offered at checkout. To add one later (e.g. card / QR), append an
   * entry here — the checkout dialog shows a method picker automatically once there is
   * more than one. `tender: true` means the cashier enters the amount received and the
   * change is calculated (cash); `tender: false` methods are settled for the exact total.
   * The chosen method is saved on the sale as `payment.method` (see buildPayment()).
   */
  const PAYMENT_METHODS = [
    { id: 'cash', label: '現金', tender: true },
    // { id: 'card', label: 'カード', tender: false },
    // { id: 'qr', label: 'QRコード', tender: false },
  ];

  /**
   * Quick "お預かり" buttons shown after 「ちょうど」 in the checkout dialog. Configurable per
   * device in 設定 (stored in localStorage — a device preference, not shared data). Each tap
   * ADDS the amount to the received total, so 500 twice = ¥1,000.
   */
  const TENDER_AMOUNTS_KEY = 'sales-management-tender-amounts';
  // Per device: whether the product buttons show 「残り N個」 (off = hide it from customers).
  const SHOW_STOCK_KEY = 'sales-management-show-stock';

  function getShowStock() {
    try {
      return localStorage.getItem(SHOW_STOCK_KEY) !== 'off';
    } catch {
      return true;
    }
  }

  function setShowStock(show) {
    try {
      if (show) localStorage.removeItem(SHOW_STOCK_KEY);
      else localStorage.setItem(SHOW_STOCK_KEY, 'off');
    } catch { /* storage unavailable: keep the default */ }
    renderProductGrid();
    renderCart();
    return getShowStock();
  }
  const DEFAULT_TENDER_AMOUNTS = [1000, 5000, 10000];
  const MAX_TENDER_AMOUNTS = 8;

  /** "300, 500 1000" / full-width digits → [300, 500, 1000] (deduped, ascending, 1〜1,000,000, max 8). */
  function parseTenderAmounts(text) {
    const normalised = String(text)
      .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/[¥￥円,，]/g, ' '); // commas are separators ("300,500"), so write 1000 not 1,000
    const nums = normalised.split(/[\s、・/]+/).filter(Boolean).map(Number)
      .filter((n) => Number.isInteger(n) && n > 0 && n <= 1000000);
    return [...new Set(nums)].sort((a, b) => a - b).slice(0, MAX_TENDER_AMOUNTS);
  }

  function getTenderAmounts() {
    try {
      const saved = JSON.parse(localStorage.getItem(TENDER_AMOUNTS_KEY) || 'null');
      if (Array.isArray(saved)) {
        const clean = parseTenderAmounts(saved.join(' '));
        if (clean.length) return clean;
      }
    } catch { /* storage unavailable / corrupt → defaults */ }
    return [...DEFAULT_TENDER_AMOUNTS];
  }

  function setTenderAmounts(amounts) {
    const clean = amounts && amounts.length ? parseTenderAmounts(amounts.join(' ')) : [];
    try {
      if (clean.length) localStorage.setItem(TENDER_AMOUNTS_KEY, JSON.stringify(clean));
      else localStorage.removeItem(TENDER_AMOUNTS_KEY);
    } catch { /* private mode etc. — falls back to defaults next time */ }
    renderTenderQuickButtons();
    return getTenderAmounts();
  }

  /**
   * Custom order of the product buttons (並べ替え), per device. Stored as product keys —
   * `code:<商品コード>` (stable across JSON import) or `id:<id>` for products without a code.
   * Products not in the saved order follow, in the default code/name order.
   */
  const TILE_ORDER_KEY = 'sales-management-tile-order';

  const CATEGORY_COLORS = ['#2f6fed', '#1f9d55', '#d97706', '#c2417a', '#7c3aed', '#0e9aa7', '#b45309', '#64748b'];
  const LOW_STOCK = 5;
  const NO_CATEGORY = '__none__'; // tab id for products without a category (「その他」)

  const $ = (id) => document.getElementById(id);

  const customerField = $('sale-field-customer');
  const noteField = $('sale-field-note');
  const extraDetails = $('sale-extra');
  const extraSummary = $('sale-extra-summary');

  const formModeLabel = $('sale-form-mode-label');
  const submitButton = $('sale-submit-button');
  const formMessage = $('sale-form-message');
  const editBanner = $('sale-edit-banner');
  const editLabel = $('sale-edit-label');
  const cancelEditButton = $('sale-cancel-edit-button');
  const clearCartButton = $('cart-clear-button');

  const categoryTabs = $('register-category-tabs');
  const arrangeButton = $('tile-arrange-button');
  const arrangeBar = $('arrange-bar');
  const arrangeResetButton = $('arrange-reset-button');
  const arrangeDoneButton = $('arrange-done-button');
  const cartAgeBanner = $('cart-age-banner');
  const cartPanel = document.querySelector('.register__cart');
  const cartToggleButton = $('cart-toggle-button');
  const cartSheetBackdrop = $('cart-sheet-backdrop');
  const productSearchInput = $('sale-product-search');
  const productGrid = $('sale-product-grid');

  const cartList = $('line-items-body');
  const cartEmpty = $('line-items-empty');

  const checkoutBar = $('sale-checkout-bar');
  const totalDisplay = $('sale-total-display');
  const totalCountEl = $('sale-total-count');
  const totalDeltaEl = $('sale-total-delta');

  const dialog = $('checkout-dialog');
  const tenderStep = dialog.querySelector('[data-step="tender"]');
  const doneStep = dialog.querySelector('[data-step="done"]');
  const coTotal = $('checkout-total');
  const coCount = $('checkout-count');
  const coMethods = $('checkout-methods');
  const coTenderRows = $('checkout-tender-rows');
  const coReceived = $('checkout-received');
  const coChange = $('checkout-change');
  const coChangeLabel = $('checkout-change-label');
  const coWarning = $('checkout-warning');
  const coAgeNotice = $('checkout-age-notice');
  const coPad = $('checkout-pad');
  const coQuick = $('tender-quick');
  const coConfirm = $('checkout-confirm');
  const doneChange = $('checkout-done-change');
  const doneChangeLabel = $('checkout-done-change-label');
  const doneDetail = $('checkout-done-detail');

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let productsCache = [];
  let productMap = new Map(); // id (string) -> product, O(1) lookups on every tap
  let productByCode = new Map(); // code -> product, for shared stock (stockSourceCode)
  let categoryColor = new Map();
  let activeCategory = ''; // '' = すべて
  let customersCache = [];
  let items = []; // { key, productId, unitPrice, quantity } — `key` identifies the cart row in the DOM
  let nextItemKey = 1;
  let expandedKey = null;
  let lastTotal = 0;
  let editing = null; // the sale being edited (from 売上履歴), or null
  let checkout = null; // { methodId, received, savedId, snapshot } while the dialog is open
  let saving = false;
  let wakeLock = null;

  const fmt = (n) => window.App.formatCurrency(n);
  /** Product ids are Firestore document id strings; old sales may still carry numbers (12 ≡ "12"). */
  const pid = (id) => (id == null || id === '' ? '' : String(id));
  const productById = (id) => productMap.get(pid(id));
  const esc = (s) => window.App.escapeHtml(s);

  function makeItem(productId, unitPrice, quantity) {
    return { key: nextItemKey++, productId: pid(productId), unitPrice, quantity };
  }

  /** Accepts full-width digits (IME on) and strips anything else; null when there is no digit at all. */
  function parseIntInput(raw) {
    const digits = String(raw)
      .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/\D/g, '');
    return digits === '' ? null : Number(digits);
  }

  function animate(el, keyframes, options) {
    if (reduceMotion.matches || !el.animate) return;
    el.animate(keyframes, options);
  }

  function showFormError(message) {
    formMessage.textContent = message;
    formMessage.classList.add('is-error');
  }

  function clearFormError() {
    formMessage.textContent = '';
    formMessage.classList.remove('is-error');
  }

  // ---------- Master data ----------

  async function refreshCustomerOptions() {
    customersCache = await window.CustomerDB.getAll();
    const currentValue = customerField.value;
    customerField.innerHTML = '<option value="">選択なし(一般客)</option>' +
      customersCache.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    if (currentValue && customersCache.some((c) => String(c.id) === currentValue)) {
      customerField.value = currentValue;
    }
    updateExtraSummary();
  }

  /**
   * ProductDB.getAll() orders by updatedAt, and every sale bumps the sold products'
   * updatedAt (stock change) — which made buttons jump around after each sale. The
   * register uses a fixed order instead (product code, then name) so buttons stay put.
   */
  function pickerOrder(a, b) {
    const ac = a.code || '';
    const bc = b.code || '';
    if (!ac !== !bc) return ac ? -1 : 1; // products with a code first
    return ac.localeCompare(bc, 'ja', { numeric: true }) ||
      (a.name || '').localeCompare(b.name || '', 'ja', { numeric: true }) ||
      String(a.id).localeCompare(String(b.id));
  }

  // ---------- Button order (並べ替え) ----------

  const tileKey = (p) => ((p.code || '').trim() ? `code:${p.code.trim()}` : `id:${p.id}`);

  function loadTileOrder() {
    try {
      const saved = JSON.parse(localStorage.getItem(TILE_ORDER_KEY) || 'null');
      return Array.isArray(saved) ? saved : null;
    } catch {
      return null;
    }
  }

  function saveTileOrder(keys) {
    try {
      if (keys) localStorage.setItem(TILE_ORDER_KEY, JSON.stringify(keys));
      else localStorage.removeItem(TILE_ORDER_KEY);
    } catch { /* storage unavailable — order lasts until reload */ }
  }

  /** Default code/name order, then the saved custom order on top of it. */
  function sortForRegister(products) {
    const sorted = [...products].sort(pickerOrder);
    const order = loadTileOrder();
    if (!order) return sorted;
    const rank = new Map(order.map((k, i) => [k, i]));
    const pos = new Map(sorted.map((p, i) => [p.id, i]));
    return sorted.sort((a, b) => {
      const ra = rank.has(tileKey(a)) ? rank.get(tileKey(a)) : Infinity;
      const rb = rank.has(tileKey(b)) ? rank.get(tileKey(b)) : Infinity;
      return ra !== rb ? ra - rb : pos.get(a.id) - pos.get(b.id);
    });
  }

  let localOnlyCount = 0; // products still only in this device's old local master (cloud empty)

  async function refreshProductsCache() {
    productsCache = sortForRegister(await window.ProductDB.getAll());
    localOnlyCount = productsCache.length ? 0 : await window.ProductDB.localOnlyCount();
    productMap = new Map(productsCache.map((p) => [pid(p.id), p]));
    productByCode = new Map();
    for (const p of productsCache) {
      const code = (p.code || '').trim();
      if (code && !productByCode.has(code)) productByCode.set(code, p);
    }
    const categories = [...new Set(productsCache.map((p) => (p.category || '').trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'ja'));
    categoryColor = new Map(categories.map((c, i) => [c, CATEGORY_COLORS[i % CATEGORY_COLORS.length]]));
    if (activeCategory && activeCategory !== NO_CATEGORY && !categoryColor.has(activeCategory)) activeCategory = '';
  }

  /** Re-read products (stock changed) and redraw everything that shows them. */
  async function reloadProducts() {
    await refreshProductsCache();
    renderCategoryTabs();
    renderProductGrid();
    for (const item of items) refreshRow(item);
  }

  // ---------- Shared stock ----------

  /**
   * The product whose stock `p` uses: products with `stockSourceCode` (e.g. 「新刊（無償）」)
   * share the stock of the product with that code. Mirrors ProductDB.getStockOwner in db.js.
   */
  function stockOwner(p) {
    if (!p) return p;
    const code = (p.stockSourceCode || '').trim();
    const source = code ? productByCode.get(code) : null;
    return source && source.id !== p.id ? source : p;
  }

  /** Total quantity in the cart drawing on `owner`'s stock (across every product that shares it). */
  function cartQuantityForOwner(owner) {
    let qty = 0;
    for (const i of items) {
      if (stockOwner(productById(i.productId))?.id === owner.id) qty += Number(i.quantity) || 0;
    }
    return qty;
  }

  // ---------- Category tabs ----------

  function renderCategoryTabs() {
    const categories = [...categoryColor.keys()];
    const hasUncategorised = productsCache.some((p) => !(p.category || '').trim());
    if (categories.length === 0) {
      categoryTabs.hidden = true;
      return;
    }
    categoryTabs.hidden = false;
    const tabs = [{ id: '', label: 'すべて' }, ...categories.map((c) => ({ id: c, label: c }))];
    if (hasUncategorised) tabs.push({ id: NO_CATEGORY, label: 'その他' });
    categoryTabs.innerHTML = tabs.map((t) => {
      const color = categoryColor.get(t.id);
      return `<button type="button" class="category-tab ${t.id === activeCategory ? 'is-active' : ''}" data-category="${esc(t.id)}" aria-pressed="${t.id === activeCategory}"${color ? ` style="--cat:${color}"` : ''}>${esc(t.label)}</button>`;
    }).join('');
  }

  categoryTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.category-tab');
    if (!tab) return;
    activeCategory = tab.dataset.category;
    for (const t of categoryTabs.querySelectorAll('.category-tab')) {
      const on = t.dataset.category === activeCategory;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-pressed', String(on));
    }
    applyProductFilter();
    productGrid.scrollTop = 0;
  });

  // ---------- Product buttons ----------

  function cartQuantityOf(productId) {
    let qty = 0;
    const want = pid(productId);
    for (const i of items) if (i.productId === want) qty += Number(i.quantity) || 0;
    return qty;
  }

  function productMatches(p, q) {
    const cat = (p.category || '').trim();
    if (activeCategory === NO_CATEGORY ? cat : activeCategory && cat !== activeCategory) return false;
    return !q ||
      (p.name || '').toLowerCase().includes(q) ||
      (p.code || '').toLowerCase().includes(q) ||
      cat.toLowerCase().includes(q);
  }

  function tileHtml(p) {
    const qty = cartQuantityOf(p.id);
    const owner = stockOwner(p);
    const shared = owner !== p;
    const stock = Number(owner.stock);
    const soldOut = stock <= 0;
    const showStock = getShowStock();
    const low = showStock && !soldOut && stock <= LOW_STOCK;
    const free = Number(p.price) === 0;
    const age = !!p.ageRestricted;
    const color = categoryColor.get((p.category || '').trim());
    // 在庫切れ stays visible even when the count is hidden (the staff still need to know).
    const stockText = soldOut ? '在庫切れ' : (showStock ? `残り ${esc(owner.stock)}${esc(owner.unit || p.unit) || ''}` : '');
    const stockLine = stockText || shared
      ? `<span class="product-tile__stock ${low || soldOut ? 'stock-hint--low' : ''}">${stockText}${shared ? '<span class="shared-tag" title="' + esc(owner.name) + ' と在庫を共有">共通</span>' : ''}</span>`
      : '';
    return `
      <button type="button" class="product-tile ${qty ? 'is-in-cart' : ''} ${soldOut ? 'is-sold-out' : ''} ${free ? 'is-free' : ''} ${age ? 'is-age-restricted' : ''}" data-product-id="${esc(p.id)}"${color ? ` style="--cat:${color}"` : ''}>
        ${qty ? `<span class="product-tile__cart-badge">${qty}</span>` : ''}
        ${age ? '<span class="age-tag product-tile__age">年齢確認</span>' : ''}
        <span class="product-tile__name">${esc(p.name)}</span>
        <span class="product-tile__price">${free ? '<span class="free-tag">無償</span>' : fmt(p.price)}</span>
        ${stockLine}
      </button>
    `;
  }

  /** Full rebuild — only needed when the product master itself changes. */
  function renderProductGrid() {
    if (productsCache.length === 0) {
      productGrid.innerHTML = localOnlyCount
        ? `<div class="empty-state cloud-upload-hint"><p>この端末には、まだクラウドに上げていない商品が${localOnlyCount}件あります。アップロードすると、同じ共有コードの端末すべてで使えるようになります。</p><button type="button" class="btn btn--primary" data-action="upload-local-products">この端末の商品をクラウドへアップロード</button></div>`
        : '<p class="empty-state">商品が登録されていません。「商品マスタ」タブから登録してください。</p>';
      return;
    }
    productGrid.innerHTML = productsCache.map(tileHtml).join('') +
      '<p class="empty-state product-grid__no-match" hidden>該当する商品がありません。</p>';
    applyProductFilter();
  }

  /** Category / search just show or hide existing buttons — no DOM rebuild. */
  function applyProductFilter() {
    const q = productSearchInput.value.trim().toLowerCase();
    let shown = 0;
    for (const tile of productGrid.querySelectorAll('.product-tile')) {
      const product = productById(tile.dataset.productId);
      const visible = !!product && productMatches(product, q);
      tile.hidden = !visible;
      if (visible) shown++;
    }
    const noMatch = productGrid.querySelector('.product-grid__no-match');
    if (noMatch) noMatch.hidden = shown !== 0;
  }

  /** Patch one button's "in cart" badge instead of re-rendering the whole grid. */
  function updateTileBadge(productId, { pop = false } = {}) {
    const tile = productGrid.querySelector(`.product-tile[data-product-id="${CSS.escape(pid(productId))}"]`);
    if (!tile) return;
    const qty = cartQuantityOf(productId);
    tile.classList.toggle('is-in-cart', qty > 0);
    let badge = tile.querySelector('.product-tile__cart-badge');
    if (qty <= 0) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'product-tile__cart-badge';
      tile.prepend(badge);
    }
    badge.textContent = String(qty);
    if (pop) {
      animate(badge, [{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { duration: 220, easing: 'ease-out' });
    }
  }

  function addProductToCart(rawId) {
    const productId = pid(rawId);
    const product = productById(productId);
    if (!product) return;
    clearFormError();
    const existing = items.find((i) => i.productId === productId);
    let item = existing;
    if (existing) {
      existing.quantity = Number(existing.quantity || 0) + 1;
      refreshRow(existing);
    } else {
      item = makeItem(productId, Number(product.price) || 0, 1);
      items.push(item);
      cartList.appendChild(createRow(item));
      syncCartChrome();
    }
    revealRow(item);
    flashRow(item);
    updateTileBadge(productId, { pop: true });
    updateTotals();
  }

  productGrid.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="upload-local-products"]')) {
      window.SettingsView?.uploadLocalProducts();
      return;
    }
    const tile = event.target.closest('.product-tile');
    if (!tile || arranging) return; // while arranging, taps/drags never add to the cart
    addProductToCart(tile.dataset.productId);
  });

  productSearchInput.addEventListener('input', applyProductFilter);

  // Barcode scanners type the code followed by Enter. An exact code match (or a search
  // that leaves exactly one button) is added straight to the cart, then the field clears
  // so the next scan can follow immediately.
  productSearchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    const q = productSearchInput.value.trim().toLowerCase();
    if (!q) return;
    const exact = productsCache.find((p) => (p.code || '').trim().toLowerCase() === q);
    const visible = [...productGrid.querySelectorAll('.product-tile:not([hidden])')];
    const target = exact || (visible.length === 1 ? productById(visible[0].dataset.productId) : null);
    if (target) {
      addProductToCart(target.id);
      productSearchInput.value = '';
      applyProductFilter();
    } else {
      window.App.showToast(visible.length ? '候補が複数あります。商品をタップしてください。' : `「${productSearchInput.value.trim()}」に該当する商品がありません。`, !visible.length);
    }
  });

  // ---------- Arrange mode: drag buttons into any order ----------

  let arranging = false;
  let drag = null; // { tile, pointerId }

  function setArranging(on) {
    arranging = on;
    productGrid.classList.toggle('is-arranging', on);
    arrangeBar.hidden = !on;
    arrangeButton.hidden = on;
    if (on) {
      // Show every button so the whole order can be arranged.
      productSearchInput.value = '';
      activeCategory = '';
      renderCategoryTabs();
      applyProductFilter();
    }
    for (const t of categoryTabs.querySelectorAll('.category-tab')) t.disabled = on;
    productSearchInput.disabled = on;
  }

  function currentTileOrder() {
    return [...productGrid.querySelectorAll('.product-tile')]
      .map((t) => productById(t.dataset.productId))
      .filter(Boolean)
      .map(tileKey);
  }

  arrangeButton.addEventListener('click', () => setArranging(true));

  arrangeDoneButton.addEventListener('click', async () => {
    saveTileOrder(currentTileOrder());
    setArranging(false);
    await refreshProductsCache();
    renderProductGrid();
    window.App.showToast('ボタンの並びを保存しました。');
  });

  arrangeResetButton.addEventListener('click', async () => {
    saveTileOrder(null);
    await refreshProductsCache();
    renderProductGrid();
    window.App.showToast('商品コード順に戻しました。');
  });

  function tileUnderPointer(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      const tile = el.closest?.('.product-tile');
      if (tile && tile !== drag.tile && productGrid.contains(tile)) return tile;
    }
    return null;
  }

  productGrid.addEventListener('pointerdown', (event) => {
    if (!arranging) return;
    const tile = event.target.closest('.product-tile');
    if (!tile || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    drag = { tile, pointerId: event.pointerId };
    tile.classList.add('is-dragging');
    tile.setPointerCapture?.(event.pointerId);
  });

  productGrid.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    // Auto-scroll when dragging near the top/bottom edge of the grid.
    const box = productGrid.getBoundingClientRect();
    if (event.clientY < box.top + 48) productGrid.scrollTop -= 12;
    else if (event.clientY > box.bottom - 48) productGrid.scrollTop += 12;

    const target = tileUnderPointer(event.clientX, event.clientY);
    if (!target) return;
    const r = target.getBoundingClientRect();
    const after = event.clientX > r.left + r.width / 2;
    const ref = after ? target.nextElementSibling : target;
    if (ref !== drag.tile && drag.tile.nextElementSibling !== ref) productGrid.insertBefore(drag.tile, ref);
  });

  function endDrag(event) {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    drag.tile.classList.remove('is-dragging');
    drag = null;
  }
  productGrid.addEventListener('pointerup', endDrag);
  productGrid.addEventListener('pointercancel', endDrag);

  // ---------- Cart (receipt-style rows) ----------

  function stockNote(item) {
    const owner = stockOwner(productById(item.productId));
    if (!owner) return '';
    // Shared stock: e.g. 新刊 ×2 + 新刊(無償) ×1 together must fit in 新刊's stock.
    if (cartQuantityForOwner(owner) > Number(owner.stock)) {
      if (!getShowStock()) return '<span class="cart-row__warn">在庫不足</span>';
      return `<span class="cart-row__warn">在庫不足(残り${esc(owner.stock)}${pid(owner.id) !== pid(item.productId) ? '・共通' : ''})</span>`;
    }
    return '';
  }

  /** Shared stock means a change in one row can push another row over; refresh every row's note. */
  function refreshStockNotes() {
    for (const item of items) {
      const note = rowFor(item)?.querySelector('.cart-row__note');
      if (note) {
        const html = stockNote(item);
        if (note.innerHTML !== html) note.innerHTML = html;
      }
    }
  }

  function rowSubtotal(item) {
    return (Number(item.unitPrice) || 0) * (Number(item.quantity) || 0);
  }

  function rowHtml(item) {
    const product = productById(item.productId);
    const name = product ? product.name : '(削除された商品)';
    const expanded = expandedKey === item.key;
    return `
      <div class="cart-row__line">
        <button type="button" class="cart-row__main" data-action="toggle" aria-expanded="${expanded}">
          <span class="cart-row__name">${product?.ageRestricted ? '<span class="age-tag age-tag--sm">年齢確認</span>' : ''}${esc(name)}</span>
          <span class="cart-row__formula">${fmt(item.unitPrice)} × ${item.quantity}</span>
          <span class="cart-row__note">${stockNote(item)}</span>
        </button>
        <div class="qty-stepper">
          <button type="button" class="qty-stepper__btn" data-action="dec" aria-label="${esc(name)}の数量を減らす">－</button>
          <input type="text" inputmode="numeric" enterkeyhint="done" autocomplete="off" class="qty-stepper__input line-item-qty" aria-label="${esc(name)}の数量" value="${item.quantity}" />
          <button type="button" class="qty-stepper__btn" data-action="inc" aria-label="${esc(name)}の数量を増やす">＋</button>
        </div>
        <strong class="cart-row__amount">${fmt(rowSubtotal(item))}</strong>
      </div>
      <div class="cart-row__detail" ${expanded ? '' : 'hidden'}>
        <label class="cart-row__price">
          <span>単価</span>
          <input type="text" inputmode="numeric" enterkeyhint="done" autocomplete="off" class="line-input line-item-price" value="${item.unitPrice}" />
        </label>
        <button type="button" class="btn btn--danger btn--sm" data-action="remove-line">この商品を削除</button>
      </div>
    `;
  }

  function createRow(item) {
    const li = document.createElement('li');
    li.className = 'cart-row';
    li.dataset.key = String(item.key);
    li.innerHTML = rowHtml(item);
    return li;
  }

  function rowFor(item) {
    return cartList.querySelector(`.cart-row[data-key="${item.key}"]`);
  }

  /** Patch one cart row in place. Inputs the user is currently typing in are left alone. */
  function refreshRow(item) {
    const row = rowFor(item);
    if (!row) return;
    const priceInput = row.querySelector('.line-item-price');
    const qtyInput = row.querySelector('.line-item-qty');
    if (document.activeElement !== priceInput) priceInput.value = String(item.unitPrice);
    if (document.activeElement !== qtyInput) qtyInput.value = String(item.quantity);
    row.querySelector('.cart-row__formula').textContent = `${fmt(item.unitPrice)} × ${item.quantity}`;
    row.querySelector('.cart-row__amount').textContent = fmt(rowSubtotal(item));
    row.querySelector('.cart-row__note').innerHTML = stockNote(item);
  }

  /** Scroll the cart list (only the list, never the page) so the touched row is visible. */
  function revealRow(item) {
    const row = rowFor(item);
    if (!row || cartList.scrollHeight <= cartList.clientHeight) return;
    const top = row.offsetTop - cartList.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < cartList.scrollTop) cartList.scrollTop = top;
    else if (bottom > cartList.scrollTop + cartList.clientHeight) cartList.scrollTop = bottom - cartList.clientHeight;
  }

  function flashRow(item) {
    const row = rowFor(item);
    if (row) animate(row, [{ background: 'var(--color-primary-soft)' }, { background: 'transparent' }], { duration: 600, easing: 'ease-out' });
  }

  function removeItem(item) {
    items = items.filter((i) => i !== item);
    if (expandedKey === item.key) expandedKey = null;
    rowFor(item)?.remove();
    syncCartChrome();
    updateTileBadge(item.productId);
    updateTotals();
  }

  function toggleRow(item) {
    const prev = expandedKey;
    expandedKey = prev === item.key ? null : item.key;
    for (const row of cartList.querySelectorAll('.cart-row')) {
      const open = Number(row.dataset.key) === expandedKey;
      row.querySelector('.cart-row__detail').hidden = !open;
      row.querySelector('.cart-row__main').setAttribute('aria-expanded', String(open));
      row.classList.toggle('is-expanded', open);
    }
  }

  function syncCartChrome() {
    cartEmpty.hidden = items.length !== 0;
    clearCartButton.disabled = items.length === 0;
  }

  /** Full rebuild — used on reset / starting an edit / restoring a cart. */
  function renderCart() {
    cartList.innerHTML = '';
    const fragment = document.createDocumentFragment();
    items.forEach((item) => fragment.appendChild(createRow(item)));
    cartList.appendChild(fragment);
    syncCartChrome();
    updateTotals({ animateChange: false });
  }

  function cartTotals(list = items) {
    let total = 0;
    let count = 0;
    for (const item of list) {
      total += rowSubtotal(item);
      count += Number(item.quantity) || 0;
    }
    return { total, count };
  }

  function updateTotals({ animateChange = true } = {}) {
    const { total, count } = cartTotals();
    totalDisplay.textContent = fmt(total);
    totalCountEl.textContent = `${count}点`;
    checkoutBar.classList.toggle('is-empty', count === 0);
    refreshStockNotes();
    cartAgeBanner.hidden = ageRestrictedNames().length === 0;

    const delta = total - lastTotal;
    lastTotal = total;
    if (!animateChange) {
      // Reset / start of edit: drop any "+¥…" chip still fading out from the previous entry.
      totalDeltaEl.getAnimations?.().forEach((a) => a.cancel());
      return;
    }
    if (delta === 0) return;

    totalDeltaEl.textContent = `${delta > 0 ? '+' : '−'}${fmt(Math.abs(delta))}`;
    totalDeltaEl.classList.toggle('is-negative', delta < 0);
    animate(totalDeltaEl, [
      { opacity: 0, transform: 'translateY(6px)' },
      { opacity: 1, transform: 'translateY(0)', offset: 0.15 },
      { opacity: 1, transform: 'translateY(0)', offset: 0.75 },
      { opacity: 0, transform: 'translateY(-4px)' },
    ], { duration: 1200, easing: 'ease-out', fill: 'forwards' });
    animate(totalDisplay, [{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }], { duration: 240, easing: 'ease-out' });
  }

  function itemFromTarget(target) {
    const row = target.closest('.cart-row');
    if (!row) return null;
    const key = Number(row.dataset.key);
    return items.find((i) => i.key === key) || null;
  }

  function handleLineInput(target) {
    const item = itemFromTarget(target);
    if (!item) return;
    const n = parseIntInput(target.value);
    const normalised = n == null ? '' : String(n); // full-width / stray characters → plain digits
    if (target.value !== normalised) target.value = normalised;

    if (target.classList.contains('line-item-price')) {
      item.unitPrice = n ?? 0;
    } else if (target.classList.contains('line-item-qty')) {
      if (n == null || n < 1) return; // empty/0 while typing: keep the last valid qty, restored on blur
      item.quantity = n;
      updateTileBadge(item.productId);
    } else {
      return;
    }
    refreshRow(item);
    updateTotals();
  }

  cartList.addEventListener('input', (event) => {
    if (event.isComposing) return; // IME still composing — handled on compositionend
    handleLineInput(event.target);
  });
  cartList.addEventListener('compositionend', (event) => handleLineInput(event.target));

  // On commit (blur/enter), snap the field back to the model value (e.g. an emptied qty → previous qty).
  cartList.addEventListener('change', (event) => {
    const item = itemFromTarget(event.target);
    if (!item) return;
    if (event.target.classList.contains('line-item-price')) event.target.value = String(item.unitPrice);
    if (event.target.classList.contains('line-item-qty')) event.target.value = String(item.quantity);
  });

  // Select the whole value on focus so retyping a price/qty doesn't need manual deleting.
  cartList.addEventListener('focusin', (event) => {
    const input = event.target;
    if (!input.matches('.line-input, .qty-stepper__input')) return;
    setTimeout(() => { if (document.activeElement === input) input.select(); }, 0);
  });

  cartList.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.matches('input')) {
      event.preventDefault();
      event.target.blur();
    }
  });

  cartList.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn) return;
    const item = itemFromTarget(btn);
    if (!item) return;

    switch (btn.dataset.action) {
      case 'toggle':
        toggleRow(item);
        break;
      case 'remove-line':
        removeItem(item);
        break;
      case 'inc':
        item.quantity = Number(item.quantity || 0) + 1;
        refreshRow(item);
        updateTileBadge(item.productId, { pop: true });
        updateTotals();
        break;
      case 'dec': {
        const next = Number(item.quantity || 0) - 1;
        if (next <= 0) {
          removeItem(item);
        } else {
          item.quantity = next;
          refreshRow(item);
          updateTileBadge(item.productId);
          updateTotals();
        }
        break;
      }
      default:
    }
  });

  // 全取消: no confirm() — undo from the toast instead.
  clearCartButton.addEventListener('click', () => {
    if (items.length === 0) return;
    const snapshot = snapshotCart();
    clearCart();
    window.App.showToast('カートを空にしました。', false, {
      label: '元に戻す',
      onClick: () => restoreCart(snapshot),
    });
  });

  // ---------- Phone: the cart is a bottom sheet (collapsed = only the total bar) ----------

  function setCartSheet(open) {
    const on = !!open && window.App.isPhone();
    cartPanel.classList.toggle('is-sheet-open', on);
    cartSheetBackdrop.hidden = !on;
    document.body.classList.toggle('is-cart-sheet-open', on);
    cartToggleButton.setAttribute('aria-expanded', String(on));
    cartToggleButton.textContent = on ? '閉じる' : '明細';
  }

  // Keep the product grid's bottom padding equal to the collapsed sheet's height (it grows
  // when e.g. the 年齢確認 notice is shown), so the last buttons never hide behind it.
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => {
      if (!cartPanel.classList.contains('is-sheet-open')) {
        document.documentElement.style.setProperty('--cart-bar-h', `${cartPanel.offsetHeight}px`);
      }
    }).observe(cartPanel);
  }

  cartToggleButton.addEventListener('click', () => setCartSheet(!cartPanel.classList.contains('is-sheet-open')));
  cartSheetBackdrop.addEventListener('click', () => setCartSheet(false));
  window.addEventListener('hashchange', () => setCartSheet(false));
  window.matchMedia('(max-width: 759px)').addEventListener?.('change', () => setCartSheet(false));

  // ---------- Customer / memo (collapsed by default) ----------

  function updateExtraSummary() {
    const parts = [];
    const customer = customersCache.find((c) => String(c.id) === customerField.value);
    if (customer) parts.push(customer.name);
    if (noteField.value.trim()) parts.push('メモあり');
    extraSummary.textContent = parts.length ? `: ${parts.join(' / ')}` : '';
  }

  customerField.addEventListener('change', updateExtraSummary);
  noteField.addEventListener('input', updateExtraSummary);

  // ---------- Cart state helpers ----------

  function snapshotCart() {
    return {
      items: items.map((i) => ({ productId: i.productId, unitPrice: i.unitPrice, quantity: i.quantity })),
      customerId: customerField.value,
      note: noteField.value,
    };
  }

  function restoreCart(snapshot) {
    items = snapshot.items.map((i) => makeItem(i.productId, i.unitPrice, i.quantity));
    customerField.value = snapshot.customerId;
    noteField.value = snapshot.note;
    expandedKey = null;
    updateExtraSummary();
    renderCart();
    for (const p of productsCache) updateTileBadge(p.id);
  }

  function clearCart() {
    const touched = new Set(items.map((i) => i.productId));
    items = [];
    expandedKey = null;
    customerField.value = '';
    noteField.value = '';
    extraDetails.open = false;
    updateExtraSummary();
    clearFormError();
    renderCart();
    for (const id of touched) updateTileBadge(id);
  }

  // ---------- Editing a past sale (entered from 売上履歴) ----------

  function setEditing(sale) {
    editing = sale;
    editBanner.hidden = !sale;
    formModeLabel.textContent = sale ? '売上の編集' : 'ご注文';
    submitButton.textContent = sale ? '更新する' : 'お会計';
    if (sale) editLabel.textContent = `${window.App.formatDateTime(sale.createdAt)} の売上を編集中`;
  }

  function startEdit(sale) {
    setEditing(sale);
    items = sale.items.map((i) => makeItem(pid(i.productId), i.unitPrice, i.quantity));
    customerField.value = sale.customerId ? String(sale.customerId) : '';
    noteField.value = sale.note || '';
    extraDetails.open = !!(sale.customerId || sale.note);
    expandedKey = null;
    updateExtraSummary();
    clearFormError();
    renderCart();
    for (const p of productsCache) updateTileBadge(p.id);
    if (location.hash !== '#sales') location.hash = 'sales';
  }

  cancelEditButton.addEventListener('click', () => {
    setEditing(null);
    clearCart();
    location.hash = 'history';
  });

  // ---------- Building the sale ----------

  function preparedItemsFrom(list) {
    return list
      .filter((i) => i.productId && Number(i.quantity) > 0)
      .map((i) => {
        const product = productById(i.productId);
        return {
          productId: pid(i.productId),
          productName: product ? product.name : '(削除された商品)',
          unit: product ? product.unit : '',
          // Snapshot of who this line is settled to (精算先) at the time of sale.
          payee: product ? (product.payee || '').trim() : '',
          ...(product?.ageRestricted ? { ageRestricted: true } : {}),
          unitPrice: Number(i.unitPrice) || 0,
          quantity: Number(i.quantity) || 0,
        };
      });
  }

  function buildPayload() {
    const customerId = customerField.value ? Number(customerField.value) : null;
    const customer = customerId ? customersCache.find((c) => c.id === customerId) : null;
    return {
      customerId,
      customerName: customer ? customer.name : '',
      note: noteField.value.trim(),
      items: preparedItemsFrom(items),
    };
  }

  /** Names of age-restricted products currently in the cart (display only — never blocks checkout). */
  function ageRestrictedNames() {
    const names = [];
    for (const item of items) {
      const p = productById(item.productId);
      if (p?.ageRestricted && !names.includes(p.name)) names.push(p.name);
    }
    return names;
  }

  function shortageNames() {
    const owners = new Map();
    for (const item of items) {
      const owner = stockOwner(productById(item.productId));
      if (owner && cartQuantityForOwner(owner) > Number(owner.stock)) owners.set(owner.id, owner.name);
    }
    return [...owners.values()];
  }

  // ---------- Checkout button ----------

  submitButton.addEventListener('click', async () => {
    clearFormError();
    const payload = buildPayload();
    if (payload.items.length === 0) {
      showFormError('商品をタップしてカートに追加してください。');
      return;
    }
    if (editing) {
      await saveEdit(payload);
    } else {
      openCheckout();
    }
  });

  async function saveEdit(payload) {
    if (saving) return;
    saving = true;
    submitButton.disabled = true;
    try {
      const { total, count } = cartTotals();
      const id = editing.id;
      await window.SalesDB.update(id, payload);
      window.App.showToast(`${fmt(total)}(${count}点) に更新しました。`);
      setEditing(null);
      clearCart();
      await reloadProducts();
      window.ProductsView?.refreshList();
      window.HistoryView?.highlight(id);
      location.hash = 'history';
    } catch (err) {
      console.error(err);
      showFormError('保存に失敗しました: ' + err.message);
    } finally {
      saving = false;
      submitButton.disabled = false;
    }
  }

  // ---------- Checkout dialog ----------

  function renderTenderQuickButtons() {
    const amounts = getTenderAmounts();
    coQuick.innerHTML = '<button type="button" class="tender-btn tender-btn--exact" data-tender="exact">ちょうど</button>' +
      amounts.map((n) => `<button type="button" class="tender-btn" data-tender="add" data-amount="${n}">+${fmt(n)}</button>`).join('');
    // ちょうど + an odd number of amounts leaves the last row full; otherwise let 「ちょうど」 span the row.
    coQuick.classList.toggle('is-exact-wide', amounts.length % 2 === 0);
  }

  function methodById(id) {
    return PAYMENT_METHODS.find((m) => m.id === id) || PAYMENT_METHODS[0];
  }

  function openCheckout() {
    setCartSheet(false);
    const { total, count } = cartTotals();
    checkout = { methodId: PAYMENT_METHODS[0].id, received: 0, total, count, savedId: null, snapshot: null };

    coTotal.textContent = fmt(total);
    coCount.textContent = `(${count}点)`;
    coMethods.hidden = PAYMENT_METHODS.length < 2;
    coMethods.innerHTML = PAYMENT_METHODS.map((m) => `
      <button type="button" class="payment-method" role="radio" data-method="${m.id}" aria-checked="${m.id === checkout.methodId}">${esc(m.label)}</button>
    `).join('');

    const ageNames = ageRestrictedNames();
    coAgeNotice.hidden = ageNames.length === 0;
    coAgeNotice.innerHTML = ageNames.length
      ? `<span class="age-tag">年齢確認</span><span>年齢確認が必要な商品: ${ageNames.map(esc).join('、')}</span>`
      : '';

    const short = shortageNames();
    coWarning.hidden = short.length === 0;
    coWarning.textContent = short.length ? `在庫数を超えています: ${short.join('、')}(このまま会計できます)` : '';

    renderTenderQuickButtons();
    showStep('tender');
    renderTender();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    coConfirm.focus({ preventScroll: true });
  }

  function closeCheckout() {
    if (dialog.open) dialog.close();
    checkout = null;
  }

  function showStep(step) {
    tenderStep.hidden = step !== 'tender';
    doneStep.hidden = step !== 'done';
  }

  function renderTender() {
    const method = methodById(checkout.methodId);
    for (const btn of coMethods.querySelectorAll('.payment-method')) {
      btn.setAttribute('aria-checked', String(btn.dataset.method === method.id));
    }
    coTenderRows.hidden = !method.tender;
    coPad.hidden = !method.tender;

    if (!method.tender) {
      coConfirm.disabled = false;
      return;
    }
    coReceived.textContent = fmt(checkout.received);
    const diff = checkout.received - checkout.total;
    const enough = diff >= 0;
    coChangeLabel.textContent = enough || checkout.received === 0 ? 'お釣り' : '不足';
    coChange.textContent = checkout.received === 0 ? '-' : fmt(Math.abs(diff));
    coChange.classList.toggle('is-short', checkout.received > 0 && !enough);
    coConfirm.disabled = !enough;
  }

  coMethods.addEventListener('click', (event) => {
    const btn = event.target.closest('.payment-method');
    if (!btn || !checkout) return;
    checkout.methodId = btn.dataset.method;
    renderTender();
  });

  function tenderKey(key) {
    if (!checkout) return;
    const cur = String(checkout.received);
    let next = checkout.received;
    if (key === 'back') next = Number(cur.slice(0, -1) || 0);
    else if (key === 'clear') next = 0;
    else if (/^\d+$/.test(key)) next = Number((checkout.received === 0 ? '' : cur) + key);
    checkout.received = Math.min(next, 99999999);
    renderTender();
  }

  coPad.addEventListener('click', (event) => {
    const key = event.target.closest('[data-key]');
    if (key) {
      tenderKey(key.dataset.key);
      return;
    }
    const btn = event.target.closest('[data-tender]');
    if (!btn || !checkout) return;
    if (btn.dataset.tender === 'exact') checkout.received = checkout.total;
    else if (btn.dataset.tender === 'add') checkout.received += Number(btn.dataset.amount);
    else if (btn.dataset.tender === 'clear') checkout.received = 0;
    renderTender();
  });

  // iPad hardware keyboards: digits / Backspace / Enter work in the tender step too.
  dialog.addEventListener('keydown', (event) => {
    if (!checkout) return;
    if (!tenderStep.hidden) {
      if (/^[0-9]$/.test(event.key)) { event.preventDefault(); tenderKey(event.key); }
      else if (event.key === 'Backspace') { event.preventDefault(); tenderKey('back'); }
      else if (event.key === 'Enter' && !coConfirm.disabled) { event.preventDefault(); confirmCheckout(); }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      finishCheckout();
    }
  });

  // Esc / backdrop: only allowed while still on the tender step (cancels the checkout).
  dialog.addEventListener('cancel', (event) => {
    if (!doneStep.hidden) {
      event.preventDefault();
      finishCheckout();
      return;
    }
    checkout = null;
  });

  /** True when a click landed on the dimmed backdrop (outside the dialog box). */
  function isBackdropClick(event) {
    if (event.target !== dialog) return false;
    const r = dialog.getBoundingClientRect();
    return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
  }

  dialog.addEventListener('click', (event) => {
    // Done step: tapping outside = 「次のお客様」 (the sale is already saved, nothing to lose).
    // Tender step: outside taps are ignored so a stray touch can't wipe the お預かり entered so far.
    if (isBackdropClick(event)) {
      if (!doneStep.hidden) finishCheckout();
      return;
    }
    // Phones show the dialog full screen, so there is no backdrop: an empty-space tap on the
    // done screen (not on the text or buttons) does the same as 「次のお客様」.
    if (!doneStep.hidden && window.App?.isPhone?.() && (event.target === dialog || event.target === doneStep)) {
      finishCheckout();
      return;
    }
    const action = event.target.closest('[data-checkout]')?.dataset.checkout;
    if (action === 'back') closeCheckout();
    else if (action === 'confirm') confirmCheckout();
    else if (action === 'next') finishCheckout();
    else if (action === 'void') voidLastCheckout();
  });

  function buildPayment() {
    const method = methodById(checkout.methodId);
    if (!method.tender) return { method: method.id };
    return { method: method.id, received: checkout.received, change: checkout.received - checkout.total };
  }

  async function confirmCheckout() {
    if (!checkout || saving || coConfirm.disabled) return;
    saving = true;
    coConfirm.disabled = true;
    const payload = { ...buildPayload(), payment: buildPayment() };
    const snapshot = snapshotCart();
    try {
      const savedId = await window.SalesDB.add(payload);
      checkout.savedId = savedId;
      checkout.snapshot = snapshot;
      showDone(payload.payment);
      clearCart();
      window.HistoryView?.highlight(savedId);
      reloadProducts(); // stock numbers on the buttons changed
      window.ProductsView?.refreshList();
    } catch (err) {
      console.error(err);
      coWarning.hidden = false;
      coWarning.textContent = '保存に失敗しました: ' + err.message;
      coConfirm.disabled = false;
    } finally {
      saving = false;
    }
  }

  function showDone(payment) {
    const method = methodById(payment.method);
    showStep('done');
    if (method.tender) {
      doneChangeLabel.textContent = 'お釣り';
      doneChange.textContent = fmt(payment.change);
      doneDetail.textContent = `合計 ${fmt(checkout.total)}(${checkout.count}点) / お預かり ${fmt(payment.received)}`;
    } else {
      doneChangeLabel.textContent = method.label;
      doneChange.textContent = fmt(checkout.total);
      doneDetail.textContent = `${checkout.count}点`;
    }
    dialog.querySelector('.checkout-done__next').focus({ preventScroll: true });
    animate(doneStep.querySelector('.checkout-done__check'), [{ transform: 'scale(0.6)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 260, easing: 'ease-out' });
  }

  function finishCheckout() {
    closeCheckout();
    productSearchInput.value = '';
    applyProductFilter();
  }

  /** "この会計を取り消す": delete the sale just made (stock is restored) and put the items back in the cart. */
  async function voidLastCheckout() {
    if (!checkout?.savedId || saving) return;
    saving = true;
    const { savedId, snapshot } = checkout;
    try {
      await window.SalesDB.remove(savedId);
      closeCheckout();
      restoreCart(snapshot);
      await reloadProducts();
      window.ProductsView?.refreshList();
      window.App.showToast('会計を取り消しました。商品はカートに戻してあります。');
    } catch (err) {
      console.error(err);
      window.App.showToast('取り消しに失敗しました: ' + err.message, true);
    } finally {
      saving = false;
    }
  }

  // ---------- Keep the screen on while the register is open (iPadOS 18.4+ for home-screen apps) ----------

  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch {
      wakeLock = null; // not allowed (e.g. low battery mode) — the iPad's auto-lock setting applies
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && location.hash.replace('#', '') in { '': 1, sales: 1 }) requestWakeLock();
  });

  // ---------- Live product updates (other devices' edits and stock changes) ----------

  const registerPanel = document.querySelector('[data-view-panel="sales"]');
  let productReloadTimer = null;
  function scheduleProductReload() {
    if (registerPanel.hidden) return; // activate() reloads when the register is opened
    clearTimeout(productReloadTimer);
    productReloadTimer = setTimeout(() => {
      if (arranging) return; // 「完了」 reloads anyway; don't shuffle buttons under a dragging finger
      reloadProducts();
    }, 150);
  }
  window.ProductDB.subscribe(scheduleProductReload);

  // ---------- Activation ----------

  async function activate() {
    await Promise.all([refreshProductsCache(), refreshCustomerOptions()]);
    renderCategoryTabs();
    renderProductGrid();
    renderCart();
    requestWakeLock();
  }

  window.RegisterView = {
    startEdit,
    getTenderAmounts,
    setTenderAmounts,
    parseTenderAmounts,
    defaultTenderAmounts: () => [...DEFAULT_TENDER_AMOUNTS],
    getShowStock,
    setShowStock,
    reloadProducts,
    refreshCustomerOptions,
    isEditing: (id) => editing?.id === id,
    cancelEditIf(id) {
      if (editing?.id === id) {
        setEditing(null);
        clearCart();
      }
    },
  };
  // Back-compat: products.js / customers.js call window.SalesView.*
  window.SalesView = { refreshCustomerOptions, refreshProductsCache: reloadProducts, refreshList: () => window.HistoryView?.refreshList() };
  window.PaymentMethods = PAYMENT_METHODS;
  window.Router.onViewActivate('sales', activate);
})();
