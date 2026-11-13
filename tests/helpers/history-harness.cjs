const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { IDBFactory } = require('fake-indexeddb');
const root = path.join(__dirname, '../..');
const source = (name) => fs.readFileSync(path.join(root, name), 'utf8');

function harness(legacy = {}) {
  const indexedDB = new IDBFactory();
  const stored = structuredClone(legacy);
  const storageListeners = [];
  const traffic = [];
  let worker;
  const chromeStorage = {
    async get(keys) { return Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, structuredClone(stored[key])])); },
    async set(patch) {
      const changes = {};
      for (const [key, value] of Object.entries(patch)) {
        changes[key] = { oldValue: stored[key], newValue: structuredClone(value) };
        stored[key] = structuredClone(value);
      }
      queueMicrotask(() => storageListeners.forEach((listener) => listener(changes, 'local')));
    },
    async remove(keys) {
      const changes = {};
      for (const key of keys) {
        if (!(key in stored)) continue;
        changes[key] = { oldValue: stored[key] };
        delete stored[key];
      }
      queueMicrotask(() => storageListeners.forEach((listener) => listener(changes, 'local')));
    }
  };
  function restart() {
    worker = vm.createContext({
      indexedDB, crypto: webcrypto, TextEncoder, Uint8Array, fetch, btoa, console,
      chrome: { storage: { local: chromeStorage } }
    });
    vm.runInContext(source('history-model.js'), worker);
    vm.runInContext(source('history-repository.js'), worker);
  }
  restart();
  async function run(message) {
    traffic.push(structuredClone(message));
    return worker.HistoryRepository.run(structuredClone(message));
  }
  function client() {
    const errors = [];
    const context = vm.createContext({
      crypto: webcrypto, TextEncoder, Uint8Array, structuredClone,
      console: { error(_label, error) { errors.push(error); } },
      CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
      window: { dispatchEvent() {} },
      chrome: {
        runtime: { sendMessage(message, callback) {
          run(message).then((response) => callback({ ok: true, ...response }),
            (error) => callback({ ok: false, error: error.message }));
        } },
        storage: { local: chromeStorage, onChanged: { addListener(listener) { storageListeners.push(listener); } } }
      }
    });
    vm.runInContext(source('history-model.js'), context);
    vm.runInContext(source('history-client.js'), context);
    return {
      store: context.HistoryStore, errors,
      get(keys) { return new Promise((resolve) => context.HistoryStore.get(keys, resolve)); },
      set(patch, options) { return new Promise((resolve, reject) => context.HistoryStore.set(patch, (error) => error ? reject(error) : resolve(), options)); },
      remove(key, ids) { return new Promise((resolve, reject) => context.HistoryStore.removeUnsent(key, ids, (error) => error ? reject(error) : resolve())); }
    };
  }
  async function inspect() {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('unsend-history', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const tx = db.transaction(['collections', 'images'], 'readonly');
      const getAll = (name) => new Promise((resolve, reject) => {
        const req = tx.objectStore(name).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const [collections, images] = await Promise.all([getAll('collections'), getAll('images')]);
      return { collections, images };
    } finally { db.close(); }
  }
  return { stored, indexedDB, run, restart, client, inspect, traffic, source };
}
module.exports = { harness, source };
