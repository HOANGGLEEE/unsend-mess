const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const persistence = source.slice(
  source.indexOf('  function loadFromStorage()'),
  source.indexOf('  function requestMainWorldFiberScan()')
);

function createHarness(stored = {}, bridge = new Map()) {
  const timers = new Map();
  let clock = 0;
  let nextTimer = 0;
  const writes = [];
  const context = vm.createContext({
    STORAGE_KEY_MESSAGES: 'fb_captured_messages_v2',
    STORAGE_KEY_UNSENT: 'fb_unsent_messages_v2',
    STORAGE_KEY_CLEANED_FLAG: 'fb_unsend_schema_v4_cleaned',
    STORAGE_KEY_TOAST_ENABLED: 'fb_unsend_toast_enabled',
    STORAGE_KEY_ORPHANED_BRIDGE: 'fb_unsend_orphaned_bridge_v1',
    MAX_STORED_MESSAGES: 500,
    recentMessagesList: [], unsentMessagesList: [], messagesById: new Map(),
    currentUserId: '', currentUserFullName: '', isToastEnabled: true,
    valid: true,
    isExtensionContextValid: () => context.valid,
    detectCurrentUserIdentity() {}, scheduleDomScan() {}, dlog() {},
    queueImageCache() {},
    sanitizeStoredRecord: (record) => ({ ...record }),
    stripDomReferences: ({ rowEl, chatContainer, ...record }) => record,
    isTempDomId: (id) => id.startsWith('dom_'),
    repairPollutedIdsAndAvatarsInLists: () => false,
    window: { localStorage: {
      getItem: (key) => bridge.get(key) ?? null,
      setItem: (key, value) => bridge.set(key, value),
      removeItem: (key) => bridge.delete(key)
    } },
    chrome: { runtime: {}, storage: { local: {
      remove() {},
      get: (_keys, callback) => callback(structuredClone(stored)),
      set(patch, callback) {
        writes.push(structuredClone(patch));
        Object.assign(stored, structuredClone(patch));
        callback?.();
      }
    } } },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, due: clock + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id)
  });
  vm.runInContext(persistence, context);
  return { context, stored, bridge, writes, advance(ms) {
    clock += ms;
    for (const [id, timer] of timers) {
      if (timer.due <= clock) {
        timers.delete(id);
        timer.callback();
      }
    }
  } };
}

test('continuous captures persist latest text and unsent images within 300ms', () => {
  const h = createHarness();
  h.context.unsentMessagesList.push({ messageId: 'image_1', attachments: ['https://example.com/photo.jpg'] });
  for (let i = 0; i < 3; i++) {
    h.context.recentMessagesList.push({ messageId: `text_${i}`, text: `Message ${i}` });
    h.context.saveToStorage();
    h.advance(100);
  }
  assert.equal(h.writes.length, 1);
  assert.equal(h.stored.fb_captured_messages_v2.length, 3);
  assert.equal(h.stored.fb_unsent_messages_v2[0].attachments.length, 1);
  h.context.saveToStorage();
  h.advance(300);
  assert.equal(h.writes.length, 2, 'later captures can schedule another write');
});

test('startup without the schema flag preserves stored and orphaned history', () => {
  const h = createHarness({
    fb_captured_messages_v2: [{ messageId: 'text_1', text: 'Original text' }],
    fb_unsent_messages_v2: [{ messageId: 'image_1', attachments: ['https://example.com/photo.jpg'] }]
  }, new Map([['fb_unsend_orphaned_bridge_v1', JSON.stringify({
    unsent: [{ messageId: 'text_2', text: 'Recovered text' }]
  })]]));
  h.context.loadFromStorage();
  h.advance(300);
  assert.equal(h.stored.fb_unsend_schema_v4_cleaned, true);
  assert.equal(h.stored.fb_captured_messages_v2.length, 1);
  assert.equal(h.stored.fb_unsent_messages_v2.length, 2);
  const reloaded = createHarness(h.stored);
  reloaded.context.loadFromStorage();
  assert.equal(reloaded.context.unsentMessagesList.length, 2);
});

test('pending save falls back to the bridge when the extension context expires', () => {
  const h = createHarness();
  h.context.unsentMessagesList.push({ messageId: 'text_1', text: 'Keep this message' });
  h.context.saveToStorage();
  h.context.valid = false;
  h.advance(300);
  assert.equal(h.writes.length, 0);
  const recovered = JSON.parse(h.bridge.get('fb_unsend_orphaned_bridge_v1'));
  assert.equal(recovered.unsent[0].text, 'Keep this message');
});

test('hiding a tab flushes pending messages before the debounce expires', () => {
  const h = createHarness();
  h.context.recentMessagesList.push({ messageId: 'image_1', attachments: ['data:image/png;base64,AQID'] });
  h.context.saveToStorage();
  h.context.flushPendingStorage();
  assert.equal(h.writes.length, 1);
  assert.equal(h.stored.fb_captured_messages_v2[0].attachments[0], 'data:image/png;base64,AQID');
  h.advance(300);
  assert.equal(h.writes.length, 1, 'cancels the scheduled write');
});
