// Local storage for the E2EE client core.
//
// The client only ever stores JSON-safe values, so both of these are thin
// key/value adapters with one extra operation the core needs: list(prefix), in
// key order. Memory is used by tests and by anything that must not touch disk;
// IndexedDB is the web build's only persistence, chosen because MLS state is
// several kilobytes per conversation and localStorage would put private keys in
// a synchronous, 5 MB, easily-dumped string store.
const STORE = 'kv';

/** @returns {object} an in-memory store with the same async surface as IndexedDB */
export function memoryStore() {
  const data = new Map();
  return {
    async get(key) {
      return data.get(key);
    },
    async set(key, value) {
      data.set(key, value);
    },
    async remove(key) {
      data.delete(key);
    },
    async list(prefix) {
      return [...data.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, value]) => value);
    },
    // Lets a test assert what a device holds without reaching into internals.
    async keys() {
      return [...data.keys()].sort();
    },
    async close() {
      data.clear();
    },
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.name]
 */
export function indexedDbStore(options = {}) {
  const name = options.name ?? 'openbridge-e2ee';
  let database = null;

  function open() {
    if (database) return Promise.resolve(database);
    return new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDB.open(name, 1);
      } catch (error) {
        reject(new Error(`ذخیره‌سازی محلی در این مرورگر کار نمی‌کند: ${error.message}`));
        return;
      }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        database = request.result;
        // Private browsing and "clear site data" can drop the file underneath a
        // live tab; without a handler the failure would surface as a hang.
        database.onclose = () => { database = null; };
        database.onversionchange = () => {
          database.close();
          database = null;
        };
        resolve(database);
      };
      request.onerror = () => reject(new Error('ذخیره‌سازی محلی باز نشد'));
      request.onblocked = () => reject(new Error('ذخیره‌سازی محلی در تب دیگری قفل است'));
    });
  }

  function run(mode, work) {
    return open().then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(value);
      };
      transaction.onerror = () => finish(transaction.error ?? new Error('خواندن حافظه‌ی محلی ناموفق بود'));
      transaction.onabort = () => finish(transaction.error ?? new Error('خواندن حافظه‌ی محلی ناموفق بود'));
      transaction.oncomplete = () => finish(null, value);
      let value;
      try {
        value = work(transaction.objectStore(STORE), finish);
      } catch (error) {
        finish(error);
      }
    }));
  }

  return {
    get(key) {
      return run('readonly', (store, finish) => {
        const request = store.get(key);
        request.onsuccess = () => finish(null, request.result);
      });
    },
    set(key, value) {
      return run('readwrite', (store) => { store.put(value, key); });
    },
    remove(key) {
      return run('readwrite', (store) => { store.delete(key); });
    },
    list(prefix) {
      return run('readonly', (store, finish) => {
        const found = [];
        const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`, false, true);
        const cursor = store.openCursor(range);
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) finish(null, found);
          else {
            found.push(row.value);
            row.continue();
          }
        };
      });
    },
    keys() {
      return run('readonly', (store, finish) => {
        const found = [];
        const cursor = store.openKeyCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) finish(null, found.sort());
          else {
            found.push(row.key);
            row.continue();
          }
        };
      });
    },
    close() {
      if (database) {
        database.close();
        database = null;
      }
      return Promise.resolve();
    },
  };
}
