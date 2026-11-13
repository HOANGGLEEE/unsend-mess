const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, source } = require('./helpers/history-harness.cjs');
const { IDBObjectStore } = require('fake-indexeddb');
const vm = require('node:vm');
const CAPTURED = 'fb_captured_messages_v2';
const UNSENT = 'fb_unsent_messages_v2';
const IMAGE = 'data:image/png;base64,AQID';
const record = (id, extra = {}) => ({ messageId: id, text: id, timestamp: 1, attachments: [], ...extra });

test('concurrent Facebook/Messenger snapshots merge instead of overwriting', async () => {
  const h = harness();
  const tabA = h.client();
  const tabB = h.client();
  await Promise.all([tabA.get([CAPTURED]), tabB.get([CAPTURED])]);
  await Promise.all([
    tabA.set({ [CAPTURED]: [record('a')] }),
    tabB.set({ [CAPTURED]: [record('b')] })
  ]);
  assert.deepEqual((await tabA.get([CAPTURED]))[CAPTURED].map((item) => item.messageId).sort(), ['a', 'b']);
});

test('stale records retain newer text, attachments and unsent status', async () => {
  const h = harness();
  const a = h.client();
  const b = h.client();
  await Promise.all([a.get([UNSENT]), b.get([UNSENT])]);
  await a.set({ [UNSENT]: [record('a', { text: 'new', updatedAt: 20, isUnsent: true, attachments: [IMAGE] })] });
  await b.set({ [UNSENT]: [record('a', { text: '', updatedAt: 10, isUnsent: false })] });
  const result = (await b.get([UNSENT]))[UNSENT][0];
  assert.equal(result.text, 'new');
  assert.equal(result.isUnsent, true);
  assert.equal(result.attachments[0], IMAGE);
});

test('legacy inline photos migrate to Blob storage and survive worker restart', async () => {
  const h = harness({ [CAPTURED]: [record('old', { attachments: [IMAGE] })], [UNSENT]: [record('old', { attachments: [IMAGE], isUnsent: true })] });
  const client = h.client();
  const data = await client.get([CAPTURED, UNSENT]);
  assert.equal(data[UNSENT][0].attachments[0], IMAGE);
  assert.equal(h.stored[UNSENT], undefined);
  const db = await h.inspect();
  assert.equal(db.images.length, 1, 'same image is deduplicated across collections');
  assert.ok(db.images[0].blob instanceof Blob);
  assert.equal(JSON.stringify(db.collections).includes('base64'), false);
  h.restart();
  assert.equal((await h.client().get([UNSENT]))[UNSENT][0].attachments[0], IMAGE);
});

test('repeated metadata updates neither retransmit nor rewrite image bytes', async () => {
  const h = harness();
  const client = h.client();
  await client.get([CAPTURED]);
  await client.set({ [CAPTURED]: [record('a', { attachments: [IMAGE] })] });
  await client.set({ [CAPTURED]: [record('a', { text: 'updated', updatedAt: 2, attachments: [IMAGE] })] });
  const saves = h.traffic.filter((message) => message.type === 'HISTORY_WRITE');
  assert.equal(Object.keys(saves[0].images).length, 1);
  assert.equal(Object.keys(saves[1].images).length, 0);
  assert.equal(JSON.stringify(saves[1]).includes('base64'), false);
  assert.equal((await h.inspect()).images.length, 1);
});

test('deletion cannot be undone by stale snapshots; explicit backup import can restore it', async () => {
  const h = harness();
  const oldTab = h.client();
  const popup = h.client();
  await oldTab.set({ [UNSENT]: [record('a', { attachments: [IMAGE] }), record('b')] });
  await popup.remove(UNSENT, ['a']);
  await oldTab.set({ [UNSENT]: [record('a', { attachments: [IMAGE] }), record('b')] });
  assert.deepEqual((await popup.get([UNSENT]))[UNSENT].map((item) => item.messageId), ['b']);
  await popup.set({ [UNSENT]: [record('a', { attachments: [IMAGE] })] }, { restore: true });
  assert.equal((await popup.get([UNSENT]))[UNSENT].length, 2);
});

test('clear-all invalidates writes queued with an old epoch', async () => {
  const h = harness();
  const client = h.client();
  await client.set({ [UNSENT]: [record('a')] });
  await client.remove(UNSENT);
  await h.run({ type: 'HISTORY_WRITE', patch: { [UNSENT]: [record('stale')] }, epochs: { [UNSENT]: 0 } });
  assert.equal((await client.get([UNSENT]))[UNSENT].length, 0);
  await client.set({ [UNSENT]: [record('new')] });
  assert.equal((await client.get([UNSENT]))[UNSENT][0].messageId, 'new');
});

test('photo cleanup retains shared images and removes unreferenced blobs atomically', async () => {
  const h = harness();
  const client = h.client();
  await client.set({ [CAPTURED]: [record('a', { attachments: [IMAGE] })], [UNSENT]: [record('a', { attachments: [IMAGE] })] });
  await client.remove(UNSENT);
  assert.equal((await h.inspect()).images.length, 1, 'captured history still uses the image');
  await client.set({ [UNSENT]: [record('b', { attachments: ['data:image/png;base64,BAUG'] })] });
  await client.remove(UNSENT);
  assert.equal((await h.inspect()).images.length, 1, 'only the unreferenced second image is removed');
});

test('failed transaction leaves history intact and does not poison the write queue', async () => {
  const h = harness();
  const client = h.client();
  await client.set({ [CAPTURED]: [record('a')] });
  await assert.rejects(h.run({ type: 'HISTORY_WRITE', patch: { [CAPTURED]: [record('b', { attachments: [`idb-image:${'a'.repeat(64)}`] })] }, epochs: { [CAPTURED]: 0 } }), /Missing stored image/);
  assert.equal((await client.get([CAPTURED]))[CAPTURED].length, 1);
  await client.set({ [CAPTURED]: [record('c')] });
  assert.equal((await client.get([CAPTURED]))[CAPTURED].length, 2);
});

test('exported hydrated history imports with working photos into a fresh database', async () => {
  const first = harness();
  const client = first.client();
  await client.set({ [UNSENT]: [record('a', { attachments: [IMAGE] })] });
  const backup = JSON.parse(JSON.stringify(await client.get([UNSENT])));
  const restored = harness().client();
  await restored.set(backup, { restore: true });
  assert.equal((await restored.get([UNSENT]))[UNSENT][0].attachments[0], IMAGE);
});

test('URL-to-image mapping replaces only the cached photo, preserving other album photos', async () => {
  const h = harness();
  const client = h.client();
  const remote = 'https://scontent.fbcdn.net/a.png';
  const other = 'https://scontent.fbcdn.net/b.png';
  await client.set({ [CAPTURED]: [record('a', { attachments: [remote, other] })] });
  await client.set({ [CAPTURED]: [record('a', { attachments: [IMAGE, other], imageSources: { [remote]: IMAGE } })] });
  const result = (await client.get([CAPTURED]))[CAPTURED][0];
  assert.deepEqual(new Set(result.attachments), new Set([IMAGE, other]));
  assert.equal(JSON.stringify((await h.inspect()).collections).includes('base64'), false);
});

test('migration rollback preserves legacy records and images when IDB runs out of space', async () => {
  const h = harness({ [UNSENT]: [record('old', { attachments: [IMAGE] })] });
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'collections') throw new DOMException('disk full', 'QuotaExceededError');
    return originalPut.apply(this, args);
  };
  try {
    await assert.rejects(h.run({ type: 'HISTORY_READ', keys: [UNSENT] }), /disk full/);
  } finally { IDBObjectStore.prototype.put = originalPut; }
  assert.equal(h.stored[UNSENT][0].attachments[0], IMAGE);
  const failed = await h.inspect();
  assert.equal(failed.collections.length, 0);
  assert.equal(failed.images.length, 0);
  assert.equal((await h.client().get([UNSENT]))[UNSENT][0].attachments[0], IMAGE);
});

test('change events preserve local captures not yet flushed and honor deletions', async () => {
  const client = harness().client();
  const incoming = [record('remote')];
  const local = [record('pending'), record('deleted')];
  assert.deepEqual(Array.from(client.store.mergeLocal(incoming, local, { deletedIds: ['deleted'] }), (item) => item.messageId).sort(), ['pending', 'remote']);
  assert.deepEqual(Array.from(client.store.mergeLocal(incoming, local, { cleared: true }), (item) => item.messageId), ['remote']);
});

test('history scripts load before their callers in both content and popup contexts', () => {
  const manifest = JSON.parse(source('manifest.json'));
  const scripts = manifest.content_scripts.find((entry) => entry.js.includes('content.js')).js;
  assert.ok(scripts.indexOf('history-model.js') < scripts.indexOf('history-client.js'));
  assert.ok(scripts.indexOf('history-client.js') < scripts.indexOf('content.js'));
  const popup = source('popup.html');
  assert.ok(popup.indexOf('src="history-model.js"') < popup.indexOf('src="history-client.js"'));
  assert.ok(popup.indexOf('src="history-client.js"') < popup.indexOf('src="popup.js"'));
});

test('unchanged snapshots stop producing change events after normalization', async () => {
  const h = harness();
  const client = h.client();
  const data = { [CAPTURED]: [record('a')] };
  await client.set(data);
  await client.set(data);
  const revision = h.stored.unsend_history_revision.token;
  await client.set(data);
  assert.equal(h.stored.unsend_history_revision.token, revision);
});

test('retention keeps 500 recent captures across tabs without deleting unsent history', async () => {
  const h = harness();
  const a = h.client();
  const b = h.client();
  await Promise.all([a.get([CAPTURED]), b.get([CAPTURED])]);
  await Promise.all([
    a.set({ [CAPTURED]: Array.from({ length: 300 }, (_, i) => record(`a${i}`, { timestamp: i + 1 })) }),
    b.set({ [CAPTURED]: Array.from({ length: 300 }, (_, i) => record(`b${i}`, { timestamp: i + 301 })), [UNSENT]: [record('a0', { isUnsent: true })] })
  ]);
  const result = await a.get([CAPTURED, UNSENT]);
  assert.equal(result[CAPTURED].length, 500);
  assert.equal(result[CAPTURED][0].timestamp, 101);
  assert.equal(result[CAPTURED].at(-1).timestamp, 600);
  assert.equal(result[UNSENT][0].messageId, 'a0');
});

test('late legacy snapshots merge without reintroducing deleted messages', async () => {
  const h = harness();
  const client = h.client();
  await client.set({ [UNSENT]: [record('a')] });
  await client.remove(UNSENT, ['a']);
  await h.run({ type: 'HISTORY_LEGACY', patch: { [UNSENT]: [record('a'), record('b')] } });
  assert.deepEqual(Array.from((await client.get([UNSENT]))[UNSENT], (item) => item.messageId), ['b']);
});

test('migration preserves numeric IDs and old records without IDs', async () => {
  const h = harness({ [UNSENT]: [record(123), { text: 'old message', attachments: [IMAGE] }] });
  const data = (await h.client().get([UNSENT]))[UNSENT];
  assert.equal(data.length, 2);
  assert.equal(data[0].messageId, '123');
  assert.match(data[1].messageId, /^legacy_[a-f0-9]{64}$/);
  assert.equal(data[1].attachments[0], IMAGE);
});

test('worker protocol permits reads from chat tabs and reserves delete/import for popup', async () => {
  let listener;
  const calls = [];
  const context = vm.createContext({
    HistoryRepository: { async run(message) { calls.push(message); return { epochs: { [UNSENT]: 0 } }; } },
    chrome: { runtime: {
      id: 'test-extension', getURL: (name) => `chrome-extension://test-extension/${name}`,
      onMessage: { addListener(callback) { listener = callback; } }
    } }
  });
  const background = source('background.js');
  vm.runInContext(background.slice(background.indexOf('chrome.runtime.onMessage.addListener(')), context);
  const invoke = (message, sender) => new Promise((resolve) => listener(message, sender, resolve));
  const page = { id: 'test-extension', url: 'https://www.messenger.com/t/1' };
  const popup = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' };
  assert.equal((await invoke({ type: 'HISTORY_READ', keys: [UNSENT] }, page)).ok, true);
  assert.equal((await invoke({ type: 'HISTORY_DELETE', key: UNSENT }, page)).ok, false);
  assert.equal((await invoke({ type: 'HISTORY_WRITE', restore: true }, page)).ok, false);
  assert.equal((await invoke({ type: 'HISTORY_DELETE', key: UNSENT }, popup)).ok, true);
  assert.equal((await invoke({ type: 'HISTORY_READ' }, { ...page, url: 'https://messenger.com.evil.example/' })).ok, false);
  assert.equal((await invoke({ type: 'HISTORY_READ' }, { ...page, id: 'other-extension' })).ok, false);
  assert.equal(calls.length, 2);
});
