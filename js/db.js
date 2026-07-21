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

const ProductDB = createCrud(STORE_PRODUCTS);
const CustomerDB = createCrud(STORE_CUSTOMERS);

// ---------- Sales: line-item transactions that also adjust product stock ----------

function calcTotal(items) {
  return items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unitPrice), 0);
}

/** Apply `sign` * quantity to each item's product stock (sign = -1 on sale, +1 on revert). */
async function adjustStock(productsStore, items, sign) {
  for (const item of items) {
    if (!item.productId) continue;
    const product = await requestToPromise(productsStore.get(item.productId));
    if (!product) continue;
    const nextStock = (Number(product.stock) || 0) + sign * Number(item.quantity);
    await requestToPromise(
      productsStore.put({ ...product, stock: nextStock, updatedAt: new Date().toISOString() })
    );
  }
}

const SalesDB = {
  add(sale) {
    return withStores([STORE_SALES, STORE_PRODUCTS], 'readwrite', async (stores) => {
      const now = new Date().toISOString();
      const record = {
        ...sale,
        totalAmount: calcTotal(sale.items),
        createdAt: now,
        updatedAt: now,
      };
      const id = await requestToPromise(stores[STORE_SALES].add(record));
      await adjustStock(stores[STORE_PRODUCTS], sale.items, -1);
      return id;
    });
  },

  update(id, changes) {
    return withStores([STORE_SALES, STORE_PRODUCTS], 'readwrite', async (stores) => {
      const existing = await requestToPromise(stores[STORE_SALES].get(id));
      if (!existing) throw new Error(`Sale with id ${id} not found`);

      // Revert stock impact of the old line items before applying the new ones.
      await adjustStock(stores[STORE_PRODUCTS], existing.items, +1);

      const updated = {
        ...existing,
        ...changes,
        id,
        totalAmount: calcTotal(changes.items || existing.items),
        updatedAt: new Date().toISOString(),
      };
      await requestToPromise(stores[STORE_SALES].put(updated));
      await adjustStock(stores[STORE_PRODUCTS], updated.items, -1);
      return updated;
    });
  },

  remove(id) {
    return withStores([STORE_SALES, STORE_PRODUCTS], 'readwrite', async (stores) => {
      const existing = await requestToPromise(stores[STORE_SALES].get(id));
      if (!existing) return;
      await adjustStock(stores[STORE_PRODUCTS], existing.items, +1);
      await requestToPromise(stores[STORE_SALES].delete(id));
    });
  },

  get(id) {
    return withStore(STORE_SALES, 'readonly', (store) => requestToPromise(store.get(id)));
  },

  async getAll() {
    const all = await withStore(STORE_SALES, 'readonly', (store) => requestToPromise(store.getAll()));
    return all.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
  },
};

window.ProductDB = ProductDB;
window.CustomerDB = CustomerDB;
window.SalesDB = SalesDB;