/*
 * Cloud sync bootstrap: sales and products (incl. stock) are shared through Firestore.
 *
 * Loads the Firebase SDK from the CDN via dynamic import (works from a plain
 * classic script, no <script type="module"> ordering to worry about), signs
 * in anonymously, and manages the "workspace code" that scopes which shared
 * Firestore data a device sees. There is no per-user login — the workspace
 * code itself is the access control (see firestore.rules): anyone who is
 * signed in (even anonymously) and knows the code can read/write it, so it
 * should be treated like a shared password, not a public identifier.
 *
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
  const CODE_LENGTH = 8; // 32^8 ≈ 1.1 trillion codes

  /** A new code from the browser's cryptographic random source (not Math.random). */
  function randomWorkspaceId() {
    const bytes = new Uint8Array(CODE_LENGTH);
    crypto.getRandomValues(bytes);
    // 256 is a multiple of 32, so `% 32` picks every letter with the same probability.
    return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  }

  /** Upper-case, drop spaces and hyphens (people read codes aloud / type them in groups). */
  function normalizeWorkspaceId(raw) {
    return String(raw || '').trim().toUpperCase().replace(/[\s-]+/g, '');
  }

  /**
   * Why a code can't be joined, or '' if it can. The code is the only thing that protects a
   * workspace's data (see firestore.rules), so short or guessable codes are refused.
   * Codes already in use on a device keep working; this only applies when joining.
   */
  function workspaceIdProblem(raw) {
    const clean = normalizeWorkspaceId(raw);
    if (!clean) return '共有コードを入力してください。';
    if (!/^[A-Z0-9]+$/.test(clean)) return '共有コードに使えるのは英字と数字だけです。';
    if (clean.length < CODE_LENGTH) return `共有コードは${CODE_LENGTH}文字以上にしてください(他の端末の「設定」に表示されているコードをそのまま入力します)。`;
    return '';
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
    const problem = workspaceIdProblem(id);
    if (problem) throw new Error(problem);
    const clean = normalizeWorkspaceId(id);
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

  window.Cloud = { ready, getWorkspaceId, setWorkspaceId, normalizeWorkspaceId, workspaceIdProblem };
})();
