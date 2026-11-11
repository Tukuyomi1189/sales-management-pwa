// Test double for js/firebase-init.js — a tiny Firestore look-alike.
// "Server" state lives in localStorage so several pages (= devices) of the same test
// context share it; other pages are notified through the `storage` event.
// Supports collections by path, auto ids, increment(), hasPendingWrites with a slow
// (or never, when offline) server ack, and permission-denied per collection.
(() => {
  const SERVER_DELAY = window.__SERVER_DELAY ?? 1500; // Infinity = never acked (offline)
  const DENY = new Set(window.__DENY_COLLECTIONS || []); // e.g. ['products'] = rules not deployed
  const KEY = 'mockfs:server';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
  const save = (st) => localStorage.setItem(KEY, JSON.stringify(st));
  const pending = new Set(); // `${path}/${id}` written by THIS page and not yet acked
  const listeners = new Set(); // { path, cb }
  let seq = 0;
  const lastCol = (path) => path.split('/').pop();
  const denied = (path) => DENY.has(lastCol(path));
  const permErr = () => Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });

  const snapshotOf = (path) => {
    const docs = load()[path] || {};
    return { docs: Object.entries(docs).map(([id, data]) => ({ id, data: () => JSON.parse(JSON.stringify(data)), metadata: { hasPendingWrites: pending.has(`${path}/${id}`) } })) };
  };
  const notify = (path) => setTimeout(() => listeners.forEach((l) => { if (!path || l.path === path) l.cb(snapshotOf(l.path)); }), 0);
  window.addEventListener('storage', (e) => { if (e.key === KEY) notify(null); });

  const write = (path, id, fn) => {
    if (denied(path)) return Promise.reject(permErr());
    const st = load(); st[path] = st[path] || {};
    fn(st[path]); save(st);
    pending.add(`${path}/${id}`); notify(path);
    return new Promise((res) => {
      if (SERVER_DELAY === Infinity) return;
      setTimeout(() => { pending.delete(`${path}/${id}`); notify(path); res(); }, SERVER_DELAY);
    });
  };
  const applyPatch = (doc, patch) => {
    for (const [k, v] of Object.entries(patch)) {
      doc[k] = v && v.__op === 'inc' ? (Number(doc[k]) || 0) + v.n : v;
    }
    return doc;
  };
  const docSnap = (ref) => { const d = (load()[ref.path] || {})[ref.id]; return { id: ref.id, exists: () => !!d, data: () => d && JSON.parse(JSON.stringify(d)) }; };

  const fs = {
    collection: (_f, ...parts) => ({ path: parts.join('/') }),
    doc: (col, id) => ({ path: col.path, id: id || `auto${Date.now().toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}` }),
    increment: (n) => ({ __op: 'inc', n }),
    setDoc: (ref, data) => write(ref.path, ref.id, (c) => { c[ref.id] = applyPatch({}, data); }),
    addDoc: async (col, data) => { const ref = fs.doc(col); await fs.setDoc(ref, data); return ref; },
    updateDoc: (ref, patch) => {
      if (!(load()[ref.path] || {})[ref.id]) return Promise.reject(Object.assign(new Error('No document to update'), { code: 'not-found' }));
      return write(ref.path, ref.id, (c) => { applyPatch(c[ref.id], patch); });
    },
    deleteDoc: (ref) => write(ref.path, ref.id, (c) => { delete c[ref.id]; }),
    getDocFromCache: async (ref) => docSnap(ref),
    getDoc: async (ref) => docSnap(ref),
    getDocs: async (col) => { if (denied(col.path)) throw permErr(); return snapshotOf(col.path); },
    onSnapshot: (col, a, b, c) => {
      const cb = typeof a === 'function' ? a : b;
      const err = typeof a === 'function' ? b : c;
      if (denied(col.path)) { setTimeout(() => err && err(permErr()), 0); return () => {}; }
      const l = { path: col.path, cb };
      listeners.add(l); notify(col.path);
      return () => listeners.delete(l);
    },
  };
  const WS = 'mockfs:workspace';
  window.Cloud = {
    ready: Promise.resolve({ fs, firestore: {} }),
    getWorkspaceId: () => localStorage.getItem(WS) || 'TESTCODE',
    setWorkspaceId: (x) => { localStorage.setItem(WS, x); return x; },
  };
})();
