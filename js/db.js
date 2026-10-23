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

const ProductDB = {
  ...createCrud(STORE_PRODUCTS),

  /** First product whose code matches exactly (uses the `code` index). */
  async findByCode(code) {
    const clean = String(code || '').trim();
    if (!clean) return undefined;
    const matches = await withStore(STORE_PRODUCTS, 'readonly', (store) => requestToPromise(store.index('code').getAll(clean)));
    return matches[0];
  },

  /**
   * The product whose stock this product actually uses. Products with `stockSourceCode`
   * (e.g. 「新刊（無償）」) share the stock of the product with that code; everything else
   * uses its own. Linked by product CODE rather than id because ids are re-assigned on
   * JSON import (moving products to another device) while codes stay the same. If the
   * source can't be found the product falls back to its own stock.
   */
  async getStockOwner(id) {
    const product = await ProductDB.get(id);
    if (!product) return undefined;
    const code = String(product.stockSourceCode || '').trim();
    if (!code) return product;
    const source = await ProductDB.findByCode(code);
    return source && source.id !== product.id ? source : product;
  },
};
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
 * Runs against the local IndexedDB product store via ProductDB — Firestore (where sales
 * live now, see below) can't share a transaction with IndexedDB, so this is a best-effort
 * follow-up write rather than an atomic part of the sale write.
 */
async function adjustStockLocally(items, sign) {
  for (const item of items) {
    if (!item.productId) continue;
    // Shared-stock products (stockSourceCode) move the stock of their source product.
    const owner = await ProductDB.getStockOwner(item.productId);
    if (!owner) continue;
    const nextStock = (Number(owner.stock) || 0) + sign * Number(item.quantity);
    await ProductDB.update(owner.id, { stock: nextStock });
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

window.ProductDB = ProductDB;
window.CustomerDB = CustomerDB;
window.SalesDB = SalesDB;
window.LegacyLocalSalesDB = LegacyLocalSalesDB;