/* App shell: shared formatting/toast helpers, connection status, install prompt, SW registration, router boot. */

(() => {
  'use strict';

  const toast = document.getElementById('toast');
  const connectionStatus = document.getElementById('connection-status');
  const connectionStatusText = document.getElementById('connection-status-text');
  const installButton = document.getElementById('install-button');

  let toastTimer = null;

  // ---------- Shared formatting helpers ----------

  const currencyFormatter = new Intl.NumberFormat('ja-JP', {
    style: 'currency',
    currency: 'JPY',
    maximumFractionDigits: 0,
  });

  function formatCurrency(value) {
    const n = Number(value);
    return Number.isFinite(n) ? currencyFormatter.format(n) : '-';
  }

  function formatDateTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }

  /**
   * Show a toast. Optional `action` ({ label, onClick }) adds a button such as
   * "元に戻す" — used instead of confirm() dialogs so the register flow never blocks.
   */
  function showToast(message, isError = false, action = null) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.toggle('toast--error', isError);
    toast.classList.toggle('toast--with-action', !!action);
    if (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast__action';
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        clearTimeout(toastTimer);
        toast.hidden = true;
        action.onClick();
      }, { once: true });
      toast.append(btn);
    }
    toast.hidden = false;
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, action ? 6000 : 2600);
  }

  window.App = { formatCurrency, formatDateTime, escapeHtml, showToast };

  // ---------- Connection status ----------

  function updateConnectionStatus() {
    const online = navigator.onLine;
    connectionStatus.classList.toggle('status-pill--online', online);
    connectionStatus.classList.toggle('status-pill--offline', !online);
    connectionStatusText.textContent = online ? 'オンライン' : 'オフライン(端末内データで動作中)';
  }

  window.addEventListener('online', updateConnectionStatus);
  window.addEventListener('offline', updateConnectionStatus);

  // ---------- PWA install prompt ----------

  let deferredInstallPrompt = null;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    installButton.hidden = false;
  });

  installButton.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    installButton.hidden = true;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
  });

  window.addEventListener('appinstalled', () => {
    installButton.hidden = true;
    showToast('アプリをインストールしました。');
  });

  // ---------- Service worker ----------

  const updateBanner = document.getElementById('update-banner');
  const updateReloadButton = document.getElementById('update-reload-button');

  updateReloadButton.addEventListener('click', () => {
    location.reload();
  });

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    // install/activate already call skipWaiting()+clients.claim(), so a new SW
    // takes over quickly — but the page already open keeps running the JS it
    // already loaded until reloaded. 'controllerchange' fires exactly when a
    // new SW takes control; if this page already had a controller before that
    // (i.e. it's not the very first activation ever), that means a newer
    // version just replaced the one this page is still running, so prompt a
    // reload instead of leaving people on a stale, silently-outdated screen.
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) {
        hadController = true;
        return;
      }
      updateBanner.hidden = false;
    });

    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js')
        .then((registration) => {
          // Catch updates promptly when the user returns to an already-open tab/app,
          // rather than only whenever the browser happens to check on its own.
          document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
              registration.update().catch(() => {});
            }
          });
        })
        .catch((err) => {
          console.error('Service worker registration failed:', err);
        });
    });
  }

  // ---------- Init ----------

  // ---------- Layout: expose header+tab height so the register can fill exactly one screen ----------

  const appHeader = document.querySelector('.app-header');
  const tabNav = document.querySelector('.tab-nav');

  function updateChromeHeight() {
    const banner = updateBanner.hidden ? 0 : updateBanner.offsetHeight;
    const h = appHeader.offsetHeight + tabNav.offsetHeight + banner;
    document.documentElement.style.setProperty('--chrome-h', `${h}px`);
  }

  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(updateChromeHeight);
    [appHeader, tabNav, updateBanner].forEach((el) => ro.observe(el));
  }
  window.addEventListener('resize', updateChromeHeight);

  function init() {
    updateChromeHeight();
    updateConnectionStatus();
    registerServiceWorker();
    window.Router.render();
  }

  init();
})();
