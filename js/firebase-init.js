/*
 * Cloud sync bootstrap (pilot: sales data only).
 *
 * Loads the Firebase SDK from the CDN via dynamic import (works from a plain
 * classic script, no <script type="module"> ordering to worry about), signs
 * in anonymously, and manages the "workspace code" that scopes which shared
 * Firestore data a device sees. There is no per-user login — the workspace
 * code itself is the access control (see firestore.rules): anyone who is
 * signed in (even anonymously) and knows the code can read/write it, so it
 * should be treated like a shared password, not a public identifier.
 *
 * Everything else (products, customers) still lives only in local IndexedDB
 * (see js/db.js) and is not affected by any of this.
 */

(() => {
  'use strict';

  const SDK_VERSION = '12.16.0';
  const BASE = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;

  const firebaseConfig = {
    apiKey: 'AIzaSyCb3caXBNwk1tCGgy-lTjKgrIg1ABHBeRA',
    authDomain: 'sales-management-pwa-36ea0c.firebaseapp.com',
    projectId: 'sales-management-pwa-36ea0c',
    storageBucket: 'sales-management-pwa-36ea0c.firebasestorage.app',
    messagingSenderId: '214294587320',
    appId: '1:214294587320:web:3006c27cc1f0a55e25d14d',
  };

  const WORKSPACE_KEY = 'sales-management-workspace-id';
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I, easy to read aloud

  function randomWorkspaceId() {
    let id = '';
    for (let i = 0; i < 8; i++) {
      id += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return id;
  }

  function getWorkspaceId() {
    let id = localStorage.getItem(WORKSPACE_KEY);
    if (!id) {
      id = randomWorkspaceId();
      localStorage.setItem(WORKSPACE_KEY, id);
    }
    return id;
  }

  /** Joining a different workspace code takes effect on next reload (kept simple on purpose). */
  function setWorkspaceId(id) {
    const clean = String(id || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!clean) return getWorkspaceId();
    localStorage.setItem(WORKSPACE_KEY, clean);
    return clean;
  }

  const ready = (async () => {
    const [{ initializeApp }, authMod, firestoreMod] = await Promise.all([
      import(`${BASE}/firebase-app.js`),
      import(`${BASE}/firebase-auth.js`),
      import(`${BASE}/firebase-firestore.js`),
    ]);

    const app = initializeApp(firebaseConfig);
    const auth = authMod.getAuth(app);

    await new Promise((resolve, reject) => {
      const unsubscribe = authMod.onAuthStateChanged(auth, (user) => {
        if (user) {
          unsubscribe();
          resolve(user);
        }
      }, reject);
      authMod.signInAnonymously(auth).catch(reject);
    });

    const firestore = firestoreMod.initializeFirestore(app, {
      localCache: firestoreMod.persistentLocalCache({
        tabManager: firestoreMod.persistentSingleTabManager({}),
      }),
    });

    return { app, auth, firestore, fs: firestoreMod };
  })();

  ready.catch((err) => {
    console.error('Cloud sync initialization failed:', err);
  });

  window.Cloud = { ready, getWorkspaceId, setWorkspaceId };
})();
