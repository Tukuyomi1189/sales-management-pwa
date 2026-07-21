/* IndexedDB wrapper for product master data (offline-first storage) */

const DB_NAME = 'sales-management-db';
const DB_VERSION = 1;
const STORE_PRODUCTS = 'products';

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
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });

  return dbPromise;
}

function withStore(mode, callback) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PRODUCTS, mode);
      const store = tx.objectStore(STORE_PRODUCTS);
      let result;

      Promise.resolve(callback(store))
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

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const ProductDB = {
  /** Add a new product. Returns the generated id. */
  add(product) {
    const now = new Date().toISOString();
    const record = {
      ...product,
      createdAt: now,
      updatedAt: now,
    };
    return withStore('readwrite', (store) => requestToPromise(store.add(record)));
  },

  /** Update an existing product by id. */
  update(id, changes) {
    return withStore('readwrite', async (store) => {
      const existing = await requestToPromise(store.get(id));
      if (!existing) {
        throw new Error(`Product with id ${id} not found`);
      }
      const updated = {
        ...existing,
        ...changes,
        id,
        updatedAt: new Date().toISOString(),
      };
      await requestToPromise(store.put(updated));
      return updated;
    });
  },

  /** Delete a product by id. */
  remove(id) {
    return withStore('readwrite', (store) => requestToPromise(store.delete(id)));
  },

  /** Get a single product by id. */
  get(id) {
    return withStore('readonly', (store) => requestToPromise(store.get(id)));
  },

  /** Get all products, sorted by updatedAt desc. */
  async getAll() {
    const all = await withStore('readonly', (store) => requestToPromise(store.getAll()));
    return all.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  },

  /** Clear all products (used for import/reset). */
  clear() {
    return withStore('readwrite', (store) => requestToPromise(store.clear()));
  },

  /** Bulk import products (replaces nothing, appends). */
  async bulkAdd(products) {
    return withStore('readwrite', async (store) => {
      const now = new Date().toISOString();
      for (const p of products) {
        const { id, ...rest } = p;
        await requestToPromise(
          store.add({ ...rest, createdAt: rest.createdAt || now, updatedAt: now })
        );
      }
    });
  },
};

window.ProductDB = ProductDB;
