/* Minimal hash-based tab router shared by all views. */

(() => {
  'use strict';

  const NAV_BUTTONS = document.querySelectorAll('.tab-nav__btn');
  const PANELS = document.querySelectorAll('[data-view-panel]');
  const DEFAULT_VIEW = 'sales';
  const KNOWN_VIEWS = new Set([...PANELS].map((p) => p.dataset.viewPanel));

  const activateListeners = {};

  function onViewActivate(view, fn) {
    (activateListeners[view] ||= []).push(fn);
  }

  function currentView() {
    const hash = location.hash.replace('#', '');
    return KNOWN_VIEWS.has(hash) ? hash : DEFAULT_VIEW;
  }

  function render() {
    const view = currentView();

    PANELS.forEach((panel) => {
      panel.hidden = panel.dataset.viewPanel !== view;
    });

    NAV_BUTTONS.forEach((btn) => {
      const active = btn.dataset.view === view;
      btn.classList.toggle('is-active', active);
      if (active) {
        btn.setAttribute('aria-current', 'page');
      } else {
        btn.removeAttribute('aria-current');
      }
    });

    (activateListeners[view] || []).forEach((fn) => fn());
  }

  NAV_BUTTONS.forEach((btn) => {
    btn.addEventListener('click', () => {
      // Update the hash for back/forward + deep-linking, but don't rely solely on the
      // 'hashchange' event to reflect it — rapid clicks across tabs can update
      // location.hash faster than the browser dispatches/coalesces that event, which
      // left the UI showing a stale view. Rendering synchronously here is idempotent
      // (hashchange firing afterward just re-renders the same, already-current view).
      if (currentView() !== btn.dataset.view) {
        location.hash = btn.dataset.view;
      }
      render();
    });
  });

  window.addEventListener('hashchange', render);

  window.Router = { onViewActivate, render };
})();