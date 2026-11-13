const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'history-client.js'), 'utf8');
const UNSENT = 'fb_unsent_messages_v2';
const imageRef = `idb-image:${'a'.repeat(64)}`;
const imageData = 'data:image/png;base64,AQID';

function createHarness() {
  const calls = [];
  let storageChangedListener = null;
  const collection = {
    epoch: 7,
    deletedIds: [],
    records: [{
      messageId: 'message-1',
      text: 'saved message',
      attachments: [imageRef],
      imageSources: {},
      avatarUrl: '',
      senderAvatar: ''
    }]
  };
  const context = vm.createContext({
    HistoryModel: {
      keys: ['fb_captured_messages_v2', UNSENT, 'ig_captured_messages_v2', 'ig_unsent_messages_v2'],
      isImageRef: (value) => typeof value === 'string' && /^idb-image:[a-f0-9]{64}$/.test(value)
    },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          calls.push(message);
          if (message.type === 'HISTORY_READ') {
            callback({ ok: true, collections: { [UNSENT]: collection } });
          } else if (message.type === 'HISTORY_IMAGES') {
            callback({ ok: true, images: { [imageRef]: imageData } });
          } else {
            callback({ ok: false, error: 'Unexpected message type' });
          }
        }
      },
      storage: {
        local: {
          async get() { return {}; },
          async set() {}
        },
        onChanged: {
          addListener(listener) { storageChangedListener = listener; }
        }
      }
    },
    window: { dispatchEvent() {} },
    CustomEvent: class CustomEvent {},
    console
  });
  vm.runInContext(source, context);
  return {
    store: context.HistoryStore,
    calls,
    emitStorageChange(changes, area = 'local') {
      storageChangedListener?.(changes, area);
    }
  };
}

function get(store, keys, options) {
  return new Promise((resolve) => store.get(keys, resolve, options));
}

test('content can read message metadata without eagerly decoding every stored image', async () => {
  const h = createHarness();
  const result = await get(h.store, [UNSENT], { hydrateImages: false });
  assert.equal(result[UNSENT][0].attachments[0], imageRef);
  assert.deepEqual(h.calls.map((call) => call.type), ['HISTORY_READ']);
});

test('stored image blobs are fetched only when a visible message needs them and then cached', async () => {
  const h = createHarness();
  await get(h.store, [UNSENT], { hydrateImages: false });
  const images = await h.store.getImages([imageRef]);
  assert.equal(images[imageRef], imageData);
  const hydrated = await get(h.store, [UNSENT]);
  assert.equal(hydrated[UNSENT][0].attachments[0], imageData);
  assert.equal(h.calls.filter((call) => call.type === 'HISTORY_IMAGES').length, 1);
});

test('history change notifications stay metadata-only instead of hydrating all photos', async () => {
  const h = createHarness();
  let emitted = null;
  h.store.onChanged.addListener((changes) => { emitted = changes; });
  h.emitStorageChange({
    unsend_history_revision: { newValue: { keys: [UNSENT], token: 'revision-1' } }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(emitted);
  assert.equal(emitted[UNSENT].newValue[0].attachments[0], imageRef);
  assert.equal(h.calls.filter((call) => call.type === 'HISTORY_IMAGES').length, 0);
});
