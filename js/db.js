/*
 * Data layer.
 * - Sales (SalesDB) and products incl. stock (ProductDB): Firestore, shared by every device
 *   with the same workspace code; Firestore's persistent cache keeps them working offline.
 * - Customers (CustomerDB): this device's IndexedDB only.
 * - LocalProductDB / LegacyLocalSalesDB: the pre-cloud IndexedDB stores, kept for the one-time
 *   upload to the cloud and as ProductDB's fallback when the cloud can't be used.
 */

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
 * Sales: stored in Firestore under workspaces/{workspaceId}/sales so multiple
 * devices sharing the same workspace code see the same data in real time.
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
    const event = window.EventDB?.currentSync();
    const record = {
      ...sale,
      ...(event ? { eventId: event.id } : {}),
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
    // The amount handed over (お預かり / お釣り) belongs to the original total. If the edit
    // changes the total it no longer matches, and what was really received is unknown,
    // so keep only the payment method.
    if (existing.payment && existing.payment.method && updated.totalAmount !== Number(existing.totalAmount)
        && (existing.payment.received != null || existing.payment.change != null)) {
      updated.payment = { method: existing.payment.method };
    }
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
      // A sale that has an id (e.g. from this app's own export) is written under that id,
      // so importing the same backup twice overwrites it instead of duplicating it.
      const docRef = id ? fs.doc(col, String(id)) : fs.doc(col);
      // Like every other write here, don't wait for the server (that never ends offline).
      syncInBackground(fs.setDoc(docRef, {
        ...rest,
        date: rest.date || localDateString(new Date(createdAt)),
        totalAmount: calcTotal(rest.items || []),
        createdAt,
        updatedAt: rest.updatedAt || createdAt,
      }), 'インポート');
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

    /**
     * Move THIS product's own stock by `delta` (not redirected to a shared-stock source).
     * Used when the 在庫数 field is changed in the product form: sending the difference with
     * `increment` instead of the typed number keeps sales made on other devices while the
     * form was open (sending the number would overwrite them).
     */
    async adjustOwnStock(productId, delta) {
      await start();
      const product = products.get(sid(productId));
      if (!product || !Number.isFinite(delta) || delta === 0) return;
      if (mode === 'local') {
        await LocalProductDB.update(Number(product.id), { stock: (Number(product.stock) || 0) + delta });
        await loadLocal();
        notify();
        return;
      }
      products.set(product.id, { ...product, stock: (Number(product.stock) || 0) + delta });
      await cloudWrite('在庫の更新', (fs, col) => fs.updateDoc(fs.doc(col, product.id), { stock: fs.increment(delta) }));
      notify();
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
      // `updatedAt` means "the product was edited": a sale moving stock is not an edit, and
      // bumping it reshuffled the product list (newest first) on every sale.
      products.set(owner.id, { ...owner, stock: (Number(owner.stock) || 0) + delta });
      await cloudWrite('在庫の更新', (fs, col) => fs.updateDoc(fs.doc(col, owner.id), { stock: fs.increment(delta) }));
      notify();
    },

    /**
     * Every product's current stock, keyed by product id, for the products that own their
     * stock (shared-stock products such as 「新刊(無償)」 use their source's and are left out).
     * Used for an event's 開始時在庫 / 終了時在庫.
     */
    async stockSnapshot() {
      await start();
      const snap = {};
      for (const p of products.values()) {
        const code = String(p.stockSourceCode || '').trim();
        if (code && findByCodeSync(code)) continue;
        snap[p.id] = Number(p.stock) || 0;
      }
      return snap;
    },

    /** Same as getStockOwner, without waiting (products must already be loaded). */
    stockOwnerSync: (id) => copy(stockOwnerSync(id)),

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

// ---------- Events (cloud-synced): workspaces/{workspaceId}/events ----------

/**
 * An event (コミティア150, 2日開催なら開始日〜終了日) groups sales for reports, settlement and
 * the stock check (在庫の照合). Shared by every device with the same workspace code.
 *
 * - 「イベントを開始」 records every product's stock (startStock: {productId: n}); while it is
 *   open, new sales carry its id (SalesDB.add). 「イベントを締める」 records endStock + closedAt.
 *   Only one event is open at a time.
 * - A sale without an eventId (e.g. from a device that had not loaded the event yet) still
 *   belongs to an event when it was made between 開始 and 締め; for a past event (no such
 *   times) when its date falls within the event's dates. Nothing is rewritten.
 * - Past events can be created with just a name and dates (no stock record).
 * - If the Firestore rules don't allow `events` yet, events live in this device's
 *   localStorage instead and the UI says so; sales and products are unaffected.
 */
const EventDB = (() => {
  const LOCAL_KEY = 'sales-management-local-events';
  let mode = 'cloud'; // 'cloud' | 'local'
  let events = new Map(); // id -> event
  let ready = null;
  let fallbackReason = '';
  const listeners = new Set();
  const nowIso = () => new Date().toISOString();
  const copy = (e) => (e ? JSON.parse(JSON.stringify(e)) : undefined);

  function notify() {
    for (const fn of listeners) {
      try { fn(); } catch (err) { console.error(err); }
    }
  }

  async function eventsCollection() {
    const { firestore, fs } = await window.Cloud.ready;
    return fs.collection(firestore, 'workspaces', window.Cloud.getWorkspaceId(), 'events');
  }

  function loadLocal() {
    try {
      const all = JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}');
      events = new Map(Object.entries(all).map(([id, e]) => [id, { ...e, id }]));
    } catch {
      events = new Map();
    }
  }

  function saveLocal() {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(Object.fromEntries([...events].map(([id, { id: _id, ...e }]) => [id, e]))));
    } catch (err) {
      console.error(err);
    }
  }

  function fallBackToLocal(err) {
    if (mode === 'local') return;
    mode = 'local';
    const denied = err && (err.code === 'permission-denied' || /permission/i.test(err.message || ''));
    fallbackReason = denied
      ? 'Firestoreのルールでイベントの共有が許可されていません(ルール未反映)'
      : `クラウドに接続できません(${err && err.message ? err.message : '不明なエラー'})`;
    console.warn('EventDB: keeping events on this device only —', fallbackReason);
    loadLocal();
  }

  function start() {
    if (ready) return ready;
    ready = new Promise((resolve) => {
      let settled = false;
      const settle = () => { if (!settled) { settled = true; resolve(); } };
      (async () => {
        try {
          const { fs } = await window.Cloud.ready;
          const col = await eventsCollection();
          fs.onSnapshot(col, (snap) => {
            if (mode !== 'cloud') return;
            events = new Map(snap.docs.map((d) => [d.id, { ...d.data(), id: d.id }]));
            settle();
            notify();
          }, (err) => {
            console.error('EventDB subscribe error:', err);
            fallBackToLocal(err);
            settle();
            notify();
          });
        } catch (err) {
          fallBackToLocal(err);
          settle();
          notify();
        }
      })();
    });
    return ready;
  }

  async function write(id, data, label) {
    if (mode === 'local') {
      events.set(id, { ...(events.get(id) || {}), ...data, id });
      saveLocal();
      notify();
      return;
    }
    const { fs } = await window.Cloud.ready;
    const col = await eventsCollection();
    const existing = events.get(id);
    events.set(id, { ...(existing || {}), ...data, id });
    syncInBackground(existing ? fs.updateDoc(fs.doc(col, id), data) : fs.setDoc(fs.doc(col, id), data), label);
    notify();
  }

  async function newId() {
    if (mode === 'local') return `local-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const { fs } = await window.Cloud.ready;
    return fs.doc(await eventsCollection()).id;
  }

  const openEvents = () => [...events.values()].filter((e) => !e.closedAt);
  const byStartDesc = (a, b) => (b.startDate || '').localeCompare(a.startDate || '') || (b.createdAt || '').localeCompare(a.createdAt || '');

  function cleanDates({ startDate, endDate }) {
    const s = String(startDate || '').trim();
    const e = String(endDate || '').trim() || s;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) throw new Error('開催日を入力してください。');
    if (e < s) throw new Error('終了日は開始日以降にしてください。');
    return { startDate: s, endDate: e };
  }

  function cleanName(name) {
    const n = String(name || '').trim();
    if (!n) throw new Error('イベント名を入力してください。');
    return n;
  }

  const api = {
    ready: start,

    async getAll() {
      await start();
      return [...events.values()].map(copy).sort(byStartDesc);
    },

    async get(id) {
      await start();
      return copy(events.get(String(id)));
    },

    /** The open event (or undefined), without waiting — events load at startup. */
    currentSync() {
      return copy(openEvents().sort(byStartDesc)[0]);
    },

    async current() {
      await start();
      return api.currentSync();
    },

    /** 「イベントを開始」: records every product's stock as 開始時在庫. */
    async start({ name, startDate, endDate }) {
      await start();
      const open = api.currentSync();
      if (open) throw new Error(`「${open.name}」が開催中です。先に締めてください。`);
      const dates = cleanDates({ startDate, endDate });
      const now = nowIso();
      const id = await newId();
      await write(id, {
        name: cleanName(name), ...dates,
        startedAt: now, closedAt: null,
        startStock: await window.ProductDB.stockSnapshot(), endStock: null,
        createdAt: now, updatedAt: now,
      }, 'イベントの開始');
      return id;
    },

    /** 「イベントを締める」: records every product's stock as 終了時在庫. */
    async close(id) {
      await start();
      const event = events.get(String(id));
      if (!event) throw new Error('イベントが見つかりません。');
      if (event.closedAt) throw new Error('このイベントはすでに締めてあります。');
      const now = nowIso();
      await write(event.id, { closedAt: now, endStock: await window.ProductDB.stockSnapshot(), updatedAt: now }, 'イベントの締め');
    },

    /** A past event (no stock record): lets reports pick earlier sales by its dates. */
    async addPast({ name, startDate, endDate }) {
      await start();
      const dates = cleanDates({ startDate, endDate });
      const now = nowIso();
      const id = await newId();
      await write(id, {
        name: cleanName(name), ...dates,
        startedAt: null, closedAt: now, startStock: null, endStock: null, past: true,
        createdAt: now, updatedAt: now,
      }, 'イベントの登録');
      return id;
    },

    /** Change the name / dates. */
    async update(id, { name, startDate, endDate }) {
      await start();
      const event = events.get(String(id));
      if (!event) throw new Error('イベントが見つかりません。');
      await write(event.id, { name: cleanName(name), ...cleanDates({ startDate, endDate }), updatedAt: nowIso() }, 'イベントの更新');
    },

    async remove(id) {
      await start();
      const key = String(id);
      if (mode === 'local') {
        events.delete(key);
        saveLocal();
        notify();
        return;
      }
      const { fs } = await window.Cloud.ready;
      const col = await eventsCollection();
      events.delete(key);
      syncInBackground(fs.deleteDoc(fs.doc(col, key)), 'イベントの削除');
      notify();
    },

    /**
     * The sales that belong to `event`: those recorded with its id, plus those without an
     * event (or whose event no longer exists) made while it was open — between 「開始」 and
     * 「締める」 (still open → until now). A past event has no such times, so its dates decide.
     * (Matching by date alone would also pull in sales from before 開始 / after 締め on the
     * same day and skew the stock check.)
     */
    salesOf(event, sales) {
      const known = new Set(events.keys());
      const end = event.endDate || event.startDate;
      const inWindow = event.startedAt
        ? (s) => (s.createdAt || '') >= event.startedAt && (!event.closedAt || (s.createdAt || '') <= event.closedAt)
        : (s) => s.date >= event.startDate && s.date <= end;
      return sales.filter((s) => (s.eventId && known.has(s.eventId) ? s.eventId === event.id : inWindow(s)));
    },

    subscribe(fn) {
      listeners.add(fn);
      start();
      return () => listeners.delete(fn);
    },

    /** "2026/11/23" or "2026/11/23〜11/24" (the year shown once when both days share it). */
    datesText(event) {
      const s = event?.startDate || '';
      const e = event?.endDate || s;
      const full = (d) => d.replaceAll('-', '/');
      if (!s) return '';
      if (e === s) return full(s);
      return `${full(s)}〜${e.slice(0, 4) === s.slice(0, 4) ? e.slice(5).replace('-', '/') : full(e)}`;
    },

    isCloud: () => mode === 'cloud',
    fallbackReason: () => fallbackReason,
  };
  return api;
})();

window.EventDB = EventDB;
window.ProductDB = ProductDB;
window.LocalProductDB = LocalProductDB;
window.CustomerDB = CustomerDB;
window.SalesDB = SalesDB;
window.LegacyLocalSalesDB = LegacyLocalSalesDB;