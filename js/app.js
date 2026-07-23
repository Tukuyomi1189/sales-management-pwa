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

  function showToast(message, isError = false) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.toggle('toast--error', isError);
    toast.hidden = false;
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 2600);
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

  function init() {
    updateConnectionStatus();
    registerServiceWorker();
    window.Router.render();
  }

  init();
})();
