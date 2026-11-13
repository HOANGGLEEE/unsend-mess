/* Callback adapter for existing content/popup flows; history writes go to one worker. */
globalThis.HistoryStore = (() => {
  const epochs = {};
  const imageData = new Map();
  const imageRefs = new Map();
  const knownImages = new Set();
  let cacheBytes = 0;
  let writes = Promise.resolve();
  let events = Promise.resolve();
  const listeners = new Set();
  function report(error) {
    console.error('History storage:', error);
    window.dispatchEvent(new CustomEvent('history-storage-error', { detail: error.message }));
  }
  function call(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError?.message || (!response?.ok && response?.error);
        if (error || !response?.ok) reject(new Error(error || 'History worker did not respond'));
        else resolve(response);
      });
    });
  }
  function remember(id, dataUrl) {
    cacheBytes -= (imageData.get(id)?.length || 0) * 2;
    imageData.set(id, dataUrl);
    imageRefs.set(dataUrl, id);
    knownImages.add(id);
    cacheBytes += dataUrl.length * 2;
    while (cacheBytes > 32 * 1024 * 1024 || imageData.size > 256) {
      const oldest = imageData.keys().next().value;
      const value = imageData.get(oldest);
      cacheBytes -= value.length * 2;
      imageData.delete(oldest);
      imageRefs.delete(value);
      knownImages.delete(oldest);
    }
  }
  async function loadImages(ids) {
    const uniqueIds = [...new Set(ids)].filter((id) => HistoryModel.isImageRef(id));
    const missing = uniqueIds.filter((id) => !imageData.has(id));
    for (let i = 0; i < missing.length; i += 3) {
      const batch = missing.slice(i, i + 3);
      const response = await call({ type: 'HISTORY_IMAGES', ids: batch });
      for (const [id, dataUrl] of Object.entries(response.images)) remember(id, dataUrl);
    }
    return new Map(uniqueIds.filter((id) => imageData.has(id)).map((id) => [id, imageData.get(id)]));
  }
  async function hydrate(collections, options = {}) {
    const missing = new Set();
    if (options.hydrateImages !== false) {
      for (const entry of Object.values(collections)) {
        for (const record of entry.records) {
          for (const value of [
            ...(record.attachments || []),
            ...Object.values(record.imageSources || {}),
            record.avatarUrl,
            record.senderAvatar
          ]) {
            if (HistoryModel.isImageRef(value) && !imageData.has(value)) missing.add(value);
          }
        }
      }
      await loadImages([...missing]);
    }
    const resolved = new Map(imageData);
    const values = {};
    for (const [key, entry] of Object.entries(collections)) {
      epochs[key] = Math.max(epochs[key] || 0, entry.epoch);
      values[key] = entry.records.map((record) => {
        const decoded = { ...record, attachments: (record.attachments || []).map((value) => resolved.get(value) || value) };
        decoded.imageSources = Object.fromEntries(Object.entries(record.imageSources || {}).map(([url, id]) => [url, resolved.get(id) || id]));
        for (const field of ['avatarUrl', 'senderAvatar']) if (resolved.has(decoded[field])) decoded[field] = resolved.get(decoded[field]);
        return decoded;
      });
    }
    return values;
  }
  async function read(keys, retry = true, options = {}) {
    const historyKeys = keys.filter((key) => HistoryModel.keys.includes(key));
    const otherKeys = keys.filter((key) => !HistoryModel.keys.includes(key));
    const response = historyKeys.length ? await call({ type: 'HISTORY_READ', keys: historyKeys }) : { collections: {} };
    let values;
    try { values = await hydrate(response.collections, options); }
    catch (error) {
      if (retry && error.message === 'Missing stored image') return read(keys, false, options);
      throw error;
    }
    if (otherKeys.length) Object.assign(values, await chrome.storage.local.get(otherKeys));
    return { values, collections: response.collections };
  }
  async function encode(patch) {
    const images = {};
    const refs = new Map(imageRefs);
    for (const records of Object.values(patch)) {
      for (const record of records) {
        const sourceKeys = Object.keys(record.imageSources || {}).filter((key) => !key.startsWith('data:'));
        record.sourceImages = sourceKeys.map((key) => record.imageSources[key]);
        for (const field of ['attachments', 'sourceImages', 'avatarUrl', 'senderAvatar']) {
          const isArray = field === 'attachments' || field === 'sourceImages';
          const values = isArray ? record[field] || [] : [record[field]];
          for (let i = 0; i < values.length; i++) {
            const value = values[i];
            if (typeof value !== 'string' || !value.startsWith('data:image/')) continue;
            let id = refs.get(value);
            if (!id) {
              const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
              id = `idb-image:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
              refs.set(value, id);
            }
            if (!knownImages.has(id)) images[id] = value;
            values[i] = id;
          }
          if (!isArray && values[0] !== undefined) record[field] = values[0];
        }
        record.imageSources = Object.fromEntries(sourceKeys.map((key, i) => [key, record.sourceImages[i]]));
        delete record.sourceImages;
      }
    }
    return { patch, images };
  }
  function get(keys, callback, options = {}) {
    read(keys, true, options).then(({ values }) => callback(values)).catch(report);
  }
  function getImages(ids) {
    return loadImages(ids).then((resolved) => Object.fromEntries(resolved));
  }
  function set(patch, callback = () => {}, options = {}) {
    const snapshot = structuredClone(patch);
    const expectedEpochs = { ...epochs };
    const work = writes.then(async () => {
      const history = Object.fromEntries(Object.entries(snapshot).filter(([key]) => HistoryModel.keys.includes(key)));
      const settings = Object.fromEntries(Object.entries(snapshot).filter(([key]) => !HistoryModel.keys.includes(key)));
      const unknown = Object.keys(history).filter((key) => expectedEpochs[key] === undefined);
      if (unknown.length) {
        const response = await call({ type: 'HISTORY_READ', keys: unknown });
        for (const [key, entry] of Object.entries(response.collections)) expectedEpochs[key] = entry.epoch;
      }
      if (Object.keys(history).length) {
        let encoded = await encode(structuredClone(history));
        let response;
        try {
          response = await call({ type: 'HISTORY_WRITE', ...encoded, epochs: expectedEpochs, restore: Boolean(options.restore) });
        } catch (error) {
          if (error.message !== 'Missing stored image') throw error;
          // An old tab may reference an image collected after retention/deletion.
          knownImages.clear();
          encoded = await encode(structuredClone(history));
          response = await call({ type: 'HISTORY_WRITE', ...encoded, epochs: expectedEpochs, restore: Boolean(options.restore) });
        }
        Object.assign(epochs, response.epochs);
        for (const [id, dataUrl] of Object.entries(encoded.images)) remember(id, dataUrl);
      }
      if (Object.keys(settings).length) await chrome.storage.local.set(settings);
    });
    writes = work.catch(() => {});
    work.then(() => callback()).catch((error) => { report(error); callback(error); });
  }
  function removeUnsent(key, ids, callback) {
    const work = writes.then(() => call({ type: 'HISTORY_DELETE', key, ids }));
    writes = work.catch(() => {});
    work.then((response) => { Object.assign(epochs, response.epochs); callback(); })
      .catch((error) => { report(error); callback(error); });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const signal = changes.unsend_history_revision?.newValue;
    events = events.catch(() => {}).then(async () => {
      const decoded = { ...changes };
      if (signal) {
        const previousEpochs = { ...epochs };
        const { values, collections } = await read(signal.keys);
        for (const [key, entry] of Object.entries(collections)) {
          decoded[key] = { newValue: values[key], deletedIds: entry.deletedIds,
            cleared: previousEpochs[key] !== undefined && previousEpochs[key] !== entry.epoch };
        }
      }
      for (const listener of listeners) listener(decoded, area);
    }).catch(report);
  });
  function mergeLocal(incoming, local, change) {
    return HistoryModel.merge(incoming, change?.cleared ? [] : local, change?.deletedIds || []);
  }
  return { get, getImages, set, removeUnsent, mergeLocal, onChanged: { addListener: (listener) => listeners.add(listener) } };
})();
