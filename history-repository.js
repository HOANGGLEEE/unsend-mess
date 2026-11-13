/* Only the extension service worker opens this database. */
globalThis.HistoryRepository = (() => {
  let database;
  let queue = Promise.resolve();
  const request = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const completed = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('History transaction aborted'));
    tx.onerror = () => {}; // onabort reports transaction failures after rollback.
  });
  function open() {
    if (!database) database = new Promise((resolve, reject) => {
      const req = indexedDB.open('unsend-history', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('collections', { keyPath: 'key' });
        req.result.createObjectStore('images', { keyPath: 'id' });
      };
      req.onerror = () => { database = null; reject(req.error); };
      req.onsuccess = () => {
        req.result.onversionchange = () => { req.result.close(); database = null; };
        resolve(req.result);
      };
    });
    return database;
  }
  async function imageId(dataUrl) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(dataUrl));
    return `idb-image:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  async function prepare(patch, suppliedImages = {}) {
    const images = new Map();
    for (const [id, dataUrl] of Object.entries(suppliedImages)) {
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/') || await imageId(dataUrl) !== id) {
        throw new Error('Invalid stored image');
      }
      images.set(id, { id, blob: await (await fetch(dataUrl)).blob() });
    }
    const encoded = {};
    for (const [key, records] of Object.entries(patch)) {
      if (!HistoryModel.keys.includes(key) || !Array.isArray(records)) throw new Error('Invalid history collection');
      encoded[key] = [];
      for (const record of HistoryModel.merge([], records)) {
        const clean = { ...record, attachments: [...record.attachments], imageSources: { ...record.imageSources } };
        const sourceKeys = Object.keys(clean.imageSources).filter((key) => !key.startsWith('data:'));
        clean.sourceImages = sourceKeys.map((key) => clean.imageSources[key]);
        for (const field of ['attachments', 'sourceImages', 'avatarUrl', 'senderAvatar']) {
          const isArray = field === 'attachments' || field === 'sourceImages';
          const values = isArray ? clean[field] : [clean[field]];
          for (let i = 0; i < values.length; i++) {
            if (typeof values[i] !== 'string' || !values[i].startsWith('data:image/')) continue;
            const dataUrl = values[i];
            const id = await imageId(dataUrl);
            if (!images.has(id)) images.set(id, { id, blob: await (await fetch(dataUrl)).blob() });
            values[i] = id;
          }
          if (!isArray && values[0] !== undefined) clean[field] = values[0];
        }
        clean.imageSources = Object.fromEntries(sourceKeys.map((key, i) => [key, clean.sourceImages[i]]));
        delete clean.sourceImages;
        encoded[key].push(clean);
      }
    }
    return { patch: encoded, images };
  }
  const empty = (key) => ({ key, records: [], epoch: 0, deletedIds: [] });
  async function readCollections() {
    const db = await open();
    const tx = db.transaction('collections', 'readonly');
    const done = completed(tx);
    const entries = await request(tx.objectStore('collections').getAll());
    await done;
    return Object.fromEntries(entries.map((entry) => [entry.key, entry]));
  }
  async function commit(entries, images) {
    const db = await open();
    const tx = db.transaction(['collections', 'images'], 'readwrite');
    const done = completed(tx);
    // Handle rollback even if an individual request fails before we await completion.
    done.catch(() => {});
    try {
      const media = tx.objectStore('images');
      const used = new Set();
      for (const key of HistoryModel.keys) {
        for (const record of entries[key]?.records || []) {
          for (const value of [...(record.attachments || []), record.avatarUrl, record.senderAvatar]) {
            if (HistoryModel.isImageRef(value)) used.add(value);
          }
        }
      }
      for (const id of used) {
        const existing = await request(media.getKey(id));
        if (!existing && !images.has(id)) throw new Error('Missing stored image');
        if (!existing) media.put(images.get(id));
      }
      for (const entry of Object.values(entries)) tx.objectStore('collections').put(entry);
      // Metadata and image cleanup commit together; no live image can be collected.
      const cursor = media.openCursor();
      cursor.onsuccess = () => {
        const value = cursor.result;
        if (!value) return;
        if (!used.has(value.key)) value.delete();
        value.continue();
      };
      await done;
    } catch (error) {
      try { tx.abort(); } catch (_) {}
      await done.catch(() => {});
      throw error;
    }
  }
  async function migrate() {
    const entries = await readCollections();
    if (!entries.__migration_v1) {
      const legacy = await chrome.storage.local.get(HistoryModel.keys);
      for (const key of HistoryModel.keys) {
        if (!Array.isArray(legacy[key])) { legacy[key] = []; continue; }
        legacy[key] = await Promise.all(legacy[key].map(async (record) => {
          if (!record || typeof record !== 'object' || record.messageId) return record;
          // Keep valid old rows even when an earlier version omitted their ID.
          return { ...record, messageId: `legacy_${(await imageId(JSON.stringify(record))).slice(10)}` };
        }));
      }
      const prepared = await prepare(Object.fromEntries(HistoryModel.keys.map((key) => [key, legacy[key] || []])));
      for (const key of HistoryModel.keys) {
        entries[key] = { ...empty(key), records: prepared.patch[key] };
      }
      entries.__migration_v1 = { key: '__migration_v1', completedAt: Date.now() };
      await commit(entries, prepared.images);
    }
    // Removal is after the IDB commit. An interrupted migration can safely retry.
    await chrome.storage.local.remove(HistoryModel.keys);
    return entries;
  }
  async function notify(keys) {
    try {
      await chrome.storage.local.set({ unsend_history_revision: { keys, token: crypto.randomUUID() } });
    } catch (error) { console.error('History saved; change notification failed', error); }
  }
  async function handle(message) {
    const entries = await migrate();
    if (message.type === 'HISTORY_LEGACY') {
      message = { ...message, type: 'HISTORY_WRITE', epochs: Object.fromEntries(HistoryModel.keys.map((key) => [key, 0])) };
    }
    if (message.type === 'HISTORY_READ') {
      return { collections: Object.fromEntries(message.keys.map((key) => {
        if (!HistoryModel.keys.includes(key)) throw new Error('Invalid history collection');
        return [key, entries[key] || empty(key)];
      })) };
    }
    if (message.type === 'HISTORY_IMAGES') {
      const db = await open();
      const tx = db.transaction('images', 'readonly');
      const done = completed(tx);
      const images = await Promise.all(message.ids.map((id) => request(tx.objectStore('images').get(id))));
      await done;
      const result = {};
      for (let i = 0; i < images.length; i++) {
        if (!images[i]) throw new Error('Missing stored image');
        const blob = images[i].blob;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
        result[message.ids[i]] = `data:${blob.type};base64,${btoa(binary)}`;
      }
      return { images: result };
    }
    const changed = [];
    if (message.type === 'HISTORY_WRITE') {
      const prepared = await prepare(message.patch, message.images);
      for (const [key, records] of Object.entries(prepared.patch)) {
        const entry = entries[key] || empty(key);
        const previous = JSON.stringify(entry);
        const previousCount = entry.records.length;
        if (message.epochs?.[key] !== entry.epoch) continue;
        if (message.restore) {
          const restored = new Set(records.map((record) => record.messageId));
          entry.deletedIds = entry.deletedIds.filter((id) => !restored.has(id));
        }
        entry.records = HistoryModel.merge(entry.records, records, entry.deletedIds);
        const unsent = key.includes('_unsent_');
        entry.records.sort((a, b) => unsent ? (b.unsentAt || b.timestamp || 0) - (a.unsentAt || a.timestamp || 0) : (a.timestamp || 0) - (b.timestamp || 0));
        if (!unsent) entry.records = entry.records.slice(-Math.max(message.restore ? 2000 : 500, previousCount));
        entries[key] = entry;
        if (JSON.stringify(entry) !== previous) changed.push(key);
      }
      if (changed.length) await commit(entries, prepared.images);
    } else if (message.type === 'HISTORY_DELETE') {
      const key = message.key;
      if (!HistoryModel.keys.includes(key) || !key.includes('_unsent_')) throw new Error('Invalid delete collection');
      const entry = entries[key] || empty(key);
      const ids = message.ids || entry.records.map((record) => record.messageId);
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw new Error('Invalid delete IDs');
      entry.deletedIds = [...new Set([...entry.deletedIds, ...ids])];
      entry.records = HistoryModel.merge([], entry.records, entry.deletedIds);
      if (!message.ids) entry.epoch++;
      entries[key] = entry;
      await commit(entries, new Map());
      changed.push(key);
    } else { throw new Error('Unknown history operation'); }
    if (changed.length) await notify(changed);
    return { epochs: Object.fromEntries(HistoryModel.keys.map((key) => [key, entries[key]?.epoch || 0])) };
  }
  function run(message) {
    const result = queue.then(() => handle(message));
    queue = result.catch(() => {});
    return result;
  }
  return { run };
})();
