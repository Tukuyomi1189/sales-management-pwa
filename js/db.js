/* IndexedDB wrapper for all offline-first data: products, customers, sales. */

const DB_NAME = 'sales-management-db';
const DB_VERSION = 2;
const STORE_PRODUCTS = 'products';
const STORE_CUSTOMERS = 'customers';
const STORE_SALES = 'sales';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORE_PRODUCTS)) {
        const store = db.createObjectStore(STORE_PRODUCTS, {
          keyPath: 'id',
          autoIncrement: true,
        });
        store.createIndex('name', 'name', { unique: false });
        store.createIndex('code', 'code', { unique: false });
        store.createIndex('category', 'category', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_CUSTOMERS)) {
        const store = db.createObjectStore(STORE_CUSTOMERS, {
          keyPath: 'id',
          autoIncrement: true,
        });
        store.createIndex('name', 'name', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_SALES)) {
        const store = db.createObjectStore(STORE_SALES, {
          keyPath: 'id',
          autoIncrement: true,
        });
        store.createIndex('date', 'date', { unique: false });
        store.createIndex('customerId', 'customerId', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });

  return dbPromise;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Run `callback(storesByName)` inside a single transaction spanning `storeNames`. */
function withStores(storeNames, mode, callback) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      const stores = Object.fromEntries(storeNames.map((name) => [name, tx.objectStore(name)]));
      let result;

      Promise.resolve(callback(stores))
        .then((r) => {
          result = r;
        })
        .catch((err) => {
          tx.abort();
          reject(err);
        });

      tx.oncomplete = () => resolve(result);
      tx.onerror = (event) => reject(event.target.error);
      tx.onabort = (event) => reject(event.target.error || new Error('Transaction aborted'));
    });
  });
}

function withStore(storeName, mode, callback) {
  return withStores([storeName], mode, (stores) => callback(stores[storeName]));
}

/** Generic CRUD factory shared by simple master-data stores (products, customers). */
function createCrud(storeName) {
  return {
    add(record) {
      const now = new Date().toISOString();
      return withStore(storeName, 'readwrite', (store) =>
        requestToPromise(store.add({ ...record, createdAt: now, updatedAt: now }))
      );
    },

    update(id, changes) {
      return withStore(storeName, 'readwrite', async (store) => {
        const existing = await requestToPromise(store.get(id));
        if (!existing) throw new Error(`Record with id ${id} not found in ${storeName}`);
        const updated = { ...existing, ...changes, id, updatedAt: new Date().toISOString() };
        await requestToPromise(store.put(updated));
        return updated;
      });
    },

    remove(id) {
      return withStore(storeName, 'readwrite', (store) => requestToPromise(store.delete(id)));
    },

    get(id) {
      return withStore(storeName, 'readonly', (store) => requestToPromise(store.get(id)));
    },

    async getAll() {
      const all = await withStore(storeName, 'readonly', (store) => requestToPromise(store.getAll()));
      return all.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    },

    clear() {
      return withStore(storeName, 'readwrite', (store) => requestToPromise(store.clear()));
    },

    async bulkAdd(records) {
      return withStore(storeName, 'readwrite', async (store) => {
        const now = new Date().toISOString();
        for (const r of records) {
          const { id, ...rest } = r;
          await requestToPromise(
            store.add({ ...rest, createdAt: rest.createdAt || now, updatedAt: now })
          );
        }
      });
    },
  };
}

/**
 * The pre-cloud product master in this device's IndexedDB. Since products moved to
 * Firestore (see ProductDB below) it is only read for the one-time upload to the cloud
 * ("この端末の商品をクラウドへアップロード") and as a fallback when the cloud can't be used.
 */
const LocalProductDB = createCrud(STORE_PRODUCTS);
const CustomerDB = createCrud(STORE_CUSTOMERS);

// ---------- Sales: line-item transactions that also adjust product stock ----------

function calcTotal(items) {
  return items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unitPrice), 0);
}

function localDateString(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Apply `sign` * quantity to each item's product stock (sign = -1 on sale, +1 on revert).
 * Products live in Firestore, and stock moves with an atomic `increment`, so two devices
 * selling the same product at the same time both count (no lost updates). Shared-stock
 * products (stockSourceCode) move the stock of their source product.
 */
async function adjustStockLocally(items, sign) {
  for (const item of items) {
    if (item.productId == null || item.productId === '') continue;
    await ProductDB.adjustStock(item.productId, sign * Number(item.quantity));
  }
}

/**
 * Sales (cloud-synced pilot): stored in Firestore under
 * workspaces/{workspaceId}/sales so multiple devices sharing the same
 * workspace code see the same data in real time. Product/customer master
 * data is unaffected — it still lives only in local IndexedDB.
 *
 * IDs are Firestore document ID strings (not the auto-increment numbers
 * IndexedDB used), and the registration moment (local time) is always used
 * as a sale's date/time — there is no manual date field in the sales entry UI.
 */
async function salesCollection() {
  const { firestore, fs } = await window.Cloud.ready;
  return fs.collection(firestore, 'workspaces', window.Cloud.getWorkspaceId(), 'sales');
}

function sortSales(all) {
  return all.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/**
 * Firestore write promises (setDoc/updateDoc/deleteDoc) only resolve once the
 * SERVER acknowledges the write — a network round trip online, and never while
 * offline. The write itself lands in the local persistent cache (and fires
 * onSnapshot listeners) immediately, so we don't await the server ack: the UI
 * moves on right away and Firestore syncs in the background. A server-side
 * rejection (e.g. security rules) is surfaced as an error toast instead.
 */
function syncInBackground(writePromise, label) {
  writePromise.catch((err) => {
    console.error(`SalesDB ${label} sync failed:`, err);
    window.App?.showToast(`クラウドへの同期に失敗しました(${label}): ${err.message}`, true);
  });
}

/** Read a sale, preferring the local cache (instant; the live subscription keeps it warm) over a server round trip. */
async function readSaleDoc(fs, docRef) {
  try {
    return await fs.getDocFromCache(docRef);
  } catch {
    return fs.getDoc(docRef);
  }
}

const SalesDB = {
  async add(sale) {
    const { fs } = await window.Cloud.ready;
    const col = await salesCollection();
    const now = new Date();
    const nowIso = now.toISOString();
    const record = {
      ...sale,
      date: localDateString(now),
      totalAmount: calcTotal(sale.items),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const docRef = fs.doc(col); // auto-generated ID, known locally before any network I/O
    syncInBackground(fs.setDoc(docRef, record), '登録');
    await adjustStockLocally(sale.items, -1);
    return docRef.id;
  },

  /** Editing a sale never changes its original date/time — only the line items, customer, or note. */
  async update(id, changes) {
    const { fs } = await window.Cloud.ready;
    const col = await salesCollection();
    const docRef = fs.doc(col, id);
    const snap = await readSaleDoc(fs, docRef);
    if (!snap.exists()) throw new Error(`Sale with id ${id} not found`);
    const existing = snap.data();

    // Revert stock impact of the old line items before applying the new ones.
    await adjustStockLocally(existing.items, +1);

    const { date, createdAt, id: _id, ...safeChanges } = changes;
    const updated = {
      ...safeChanges,
      totalAmount: calcTotal(safeChanges.items || existing.items),
      updatedAt: new Date().toISOString(),
    };
    syncInBackground(fs.updateDoc(docRef, updated), '更新');
    await adjustStockLocally(updated.items || existing.items, -1);
    return { ...existing, ...updated, id };
  },

  async remove(id) {
    const { fs } = await window.Cloud.ready;
    const col = await salesCollection();
    const docRef = fs.doc(col, id);
    const snap = await readSaleDoc(fs, docRef);
    if (snap.exists()) {
      await adjustStockLocally(snap.data().items, +1);
    }
    syncInBackground(fs.deleteDoc(docRef), '削除');
  },

  async get(id) {
    const { fs } = await window.Cloud.ready;
    const col = await salesCollection();
    const snap = await fs.getDoc(fs.doc(col, id));
    return snap.exists() ? { id: snap.id, ...snap.data() } : undefined;
  },

  /** One-time fetch (works offline against the local Firestore cache too). */
  async getAll() {
    const { fs } = await window.Cloud.ready;
    const col = await salesCollection();
    const snap = await fs.getDocs(col);
    return sortSales(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  },

  /**
   * Real-time subscription: `callback` fires immediately with the current data,
   * then again whenever this workspace's sales change — from this device or
   * any other one sharing the same workspace code. Returns an unsubscribe fn.
   */
  subscribe(callback) {
    let unsubscribe = null;
    let cancelled = false;
    salesCollection().then((col) => {
      if (cancelled) return;
      window.Cloud.ready.then(({ fs }) => {
        if (cancelled) return;
        // includeMetadataChanges: also fire when a local write finishes syncing,
        // so the list can drop its "同期待ち" marker. `pending` is UI-only state
        // (never written back to Firestore; stripped on JSON export).
        unsubscribe = fs.onSnapshot(col, { includeMetadataChanges: true }, (snap) => {
          callback(sortSales(snap.docs.map((d) => ({ id: d.id, ...d.data(), pending: d.metadata.hasPendingWrites }))));
        }, (err) => console.error('SalesDB.subscribe error:', err));
      });
    });
    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
  },

  /**
   * Restore previously-exported (or locally-migrated) sales as-is, keeping their
   * original date/createdAt/updatedAt. Unlike add()/update(), this does NOT touch
   * product stock — a bulk historical import would otherwise double-count stock
   * that a paired product export/local state already reflects.
   */
  async bulkImport(sales) {
    const { fs } = await window.Cloud.ready;
    const col = await salesCollection();
    const now = new Date().toISOString();
    for (const s of sales) {
      const { id, ...rest } = s;
      const createdAt = rest.createdAt || now;
      await fs.addDoc(col, {
        ...rest,
        date: rest.date || localDateString(new Date(createdAt)),
        totalAmount: calcTotal(rest.items || []),
        createdAt,
        updatedAt: rest.updatedAt || createdAt,
      });
    }
  },
};

/** Read-only access to the old local IndexedDB sales store, kept only so its
 * data can be migrated into the cloud-synced SalesDB above (see the
 * "ローカルの売上データをアップロード" button in the sales view). */
const LegacyLocalSalesDB = {
  async getAll() {
    return withStore(STORE_SALES, 'readonly', (store) => requestToPromise(store.getAll()));
  },
};

// ---------- Products (cloud-synced): workspaces/{workspaceId}/products ----------

/**
 * Product master shared by every device using the same workspace code.
 *
 * - A live onSnapshot subscription keeps all products in memory, so reads never wait on
 *   the network (Firestore's persistent cache also serves them offline) and changes made
 *   on another device — including stock moving after its sales — appear right away.
 * - Writes update that in-memory copy immediately and sync in the background (same
 *   reasoning as SalesDB: Firestore write promises only resolve on server ack).
 * - Stock changes use Firestore `increment`, so concurrent sales on two devices add up.
 * - Ids are Firestore document id strings. Products uploaded from the old local master
 *   keep their old numeric id as the document id ("12"), so existing sales that point at
 *   productId 12 still resolve. Always compare ids as strings.
 * - If the cloud can't be used (Firestore rules not deployed yet → permission-denied, or
 *   the SDK failed to load) it falls back to this device's IndexedDB master and says so,
 *   so the register keeps working instead of showing no products.
 */
const ProductDB = (() => {
  let mode = 'cloud'; // 'cloud' | 'local'
  let products = new Map(); // id (string) -> product
  let ready = null;
  let fallbackReason = '';
  const listeners = new Set();

  const sid = (id) => String(id);
  const copy = (p) => (p ? { ...p } : undefined);
  const nowIso = () => new Date().toISOString();
  const stripId = ({ id, ...rest }) => rest;

  async function productsCollection() {
    const { firestore, fs } = await window.Cloud.ready;
    return fs.collection(firestore, 'workspaces', window.Cloud.getWorkspaceId(), 'products');
  }

  function notify() {
    for (const fn of listeners) {
      try { fn(); } catch (err) { console.error(err); }
    }
  }

  async function loadLocal() {
    const local = await LocalProductDB.getAll();
    products = new Map(local.map((p) => [sid(p.id), { ...p, id: sid(p.id) }]));
  }

  async function fallBackToLocal(err) {
    if (mode === 'local') return;
    mode = 'local';
    const denied = err && (err.code === 'permission-denied' || /permission/i.test(err.message || ''));
    fallbackReason = denied
      ? 'Firestoreのルールで商品の共有が許可されていません(ルール未反映)'
      : `クラウドに接続できません(${err && err.message ? err.message : '不明なエラー'})`;
    console.warn('ProductDB: falling back to the local product master —', fallbackReason);
    await loadLocal();
    window.App?.showToast(`商品のクラウド共有を使えないため、この端末の商品マスタで動作しています: ${fallbackReason}`, true);
  }

  function start() {
    if (ready) return ready;
    ready = new Promise((resolve) => {
      let settled = false;
      const settle = () => { if (!settled) { settled = true; resolve(); } };
      (async () => {
        try {
          const { fs } = await window.Cloud.ready;
          const col = await productsCollection();
          fs.onSnapshot(col, (snap) => {
            if (mode !== 'cloud') return;
            products = new Map(snap.docs.map((d) => [d.id, { ...d.data(), id: d.id }]));
            settle();
            notify();
          }, async (err) => {
            console.error('ProductDB subscribe error:', err);
            await fallBackToLocal(err);
            settle();
            notify();
          });
        } catch (err) {
          await fallBackToLocal(err);
          settle();
          notify();
        }
      })();
    });
    return ready;
  }

  function sorted() {
    return [...products.values()].map(copy)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  function findByCodeSync(code) {
    const clean = String(code || '').trim();
    if (!clean) return undefined;
    // Deterministic if two products somehow share a code: oldest first.
    return [...products.values()]
      .filter((p) => String(p.code || '').trim() === clean)
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id))[0];
  }

  function stockOwnerSync(id) {
    const product = products.get(sid(id));
    if (!product) return undefined;
    const code = String(product.stockSourceCode || '').trim();
    if (!code) return product;
    const source = findByCodeSync(code);
    return source && source.id !== product.id ? source : product;
  }

  async function cloudWrite(label, fn) {
    const { fs } = await window.Cloud.ready;
    const col = await productsCollection();
    syncInBackground(fn(fs, col), label);
  }

  const api = {
    /** Resolves once the first product list is available (cloud snapshot or local fallback). */
    ready: start,

    async getAll() {
      await start();
      return sorted();
    },

    async get(id) {
      await start();
      return copy(products.get(sid(id)));
    },

    async findByCode(code) {
      await start();
      return copy(findByCodeSync(code));
    },

    /**
     * The product whose stock this product actually uses. Products with `stockSourceCode`
     * (e.g. 「新刊（無償）」) share the stock of the product with that code; everything else
     * uses its own. Linked by product CODE (stable across devices / JSON import). If the
     * source can't be found the product falls back to its own stock.
     */
    async getStockOwner(id) {
      await start();
      return copy(stockOwnerSync(id));
    },

    async add(record) {
      await start();
      const now = nowIso();
      const data = { ...stripId(record), createdAt: record.createdAt || now, updatedAt: now };
      if (mode === 'local') {
        const id = await LocalProductDB.add(data);
        await loadLocal();
        notify();
        return sid(id);
      }
      const { fs } = await window.Cloud.ready;
      const ref = fs.doc(await productsCollection());
      products.set(ref.id, { ...data, id: ref.id });
      syncInBackground(fs.setDoc(ref, data), '商品の登録');
      notify();
      return ref.id;
    },

    async update(id, changes) {
      await start();
      const key = sid(id);
      const existing = products.get(key);
      if (!existing) throw new Error(`Product ${key} not found`);
      const patch = { ...stripId(changes), updatedAt: nowIso() };
      if (mode === 'local') {
        const updated = await LocalProductDB.update(Number(key), patch);
        await loadLocal();
        notify();
        return copy({ ...updated, id: key });
      }
      products.set(key, { ...existing, ...patch, id: key });
      await cloudWrite('商品の更新', (fs, col) => fs.updateDoc(fs.doc(col, key), patch));
      notify();
      return copy(products.get(key));
    },

    async remove(id) {
      await start();
      const key = sid(id);
      if (mode === 'local') {
        await LocalProductDB.remove(Number(key));
        await loadLocal();
        notify();
        return;
      }
      products.delete(key);
      await cloudWrite('商品の削除', (fs, col) => fs.deleteDoc(fs.doc(col, key)));
      notify();
    },

    async bulkAdd(records) {
      for (const r of records) await api.add(r);
    },

    async clear() {
      await start();
      for (const id of [...products.keys()]) await api.remove(id);
    },

    /** Move stock by `delta` on the product that owns this product's stock (see getStockOwner). */
    async adjustStock(productId, delta) {
      await start();
      const owner = stockOwnerSync(productId);
      if (!owner || !Number.isFinite(delta) || delta === 0) return;
      if (mode === 'local') {
        await LocalProductDB.update(Number(owner.id), { stock: (Number(owner.stock) || 0) + delta });
        await loadLocal();
        notify();
        return;
      }
      const updatedAt = nowIso();
      products.set(owner.id, { ...owner, stock: (Number(owner.stock) || 0) + delta, updatedAt });
      await cloudWrite('在庫の更新', (fs, col) => fs.updateDoc(fs.doc(col, owner.id), { stock: fs.increment(delta), updatedAt }));
      notify();
    },

    /** Call `fn` whenever the product list changes (this device or any other). Returns an unsubscribe fn. */
    subscribe(fn) {
      listeners.add(fn);
      start();
      return () => listeners.delete(fn);
    },

    isCloud: () => mode === 'cloud',
    fallbackReason: () => fallbackReason,

    /** How many products this device still has only in its old local master (cloud is empty). */
    async localOnlyCount() {
      await start();
      if (mode !== 'cloud' || products.size > 0) return 0;
      return (await LocalProductDB.getAll()).length;
    },

    /**
     * One-time move of this device's old local product master into the shared cloud master.
     * Products whose code already exists in the cloud are skipped (so two devices uploading
     * don't create duplicates). The old numeric id is kept as the document id so existing
     * sales still point at the right product (unless that id is already taken in the cloud).
     */
    async uploadLocalProducts() {
      await start();
      if (mode !== 'cloud') throw new Error(fallbackReason || 'クラウドに接続できません');
      const local = await LocalProductDB.getAll();
      const { fs } = await window.Cloud.ready;
      const col = await productsCollection();
      let added = 0;
      let skipped = 0;
      for (const p of local) {
        const code = String(p.code || '').trim();
        if (code && findByCodeSync(code)) { skipped++; continue; }
        const wantedId = sid(p.id);
        const ref = products.has(wantedId) ? fs.doc(col) : fs.doc(col, wantedId);
        const data = { ...stripId(p), stock: Number(p.stock) || 0, updatedAt: nowIso() };
        products.set(ref.id, { ...data, id: ref.id });
        syncInBackground(fs.setDoc(ref, data), '商品のアップロード');
        added++;
      }
      notify();
      return { added, skipped, total: local.length };
    },
  };
  return api;
})();

window.ProductDB = ProductDB;
window.LocalProductDB = LocalProductDB;
window.CustomerDB = CustomerDB;
window.SalesDB = SalesDB;
window.LegacyLocalSalesDB = LegacyLocalSalesDB;