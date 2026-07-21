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
      if (currentView() === btn.dataset.view) {
        render();
      } else {
        location.hash = btn.dataset.view;
      }
    });
  });

  window.addEventListener('hashchange', render);

  window.Router = { onViewActivate, render };
})();