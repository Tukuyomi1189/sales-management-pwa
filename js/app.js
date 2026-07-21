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

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch((err) => {
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
