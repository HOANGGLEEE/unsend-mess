const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const url = 'https://scontent.example.fbcdn.net/photo.png';
const cached = 'data:image/png;base64,AQID';

function worker(fetch) {
  const context = vm.createContext({ URL, fetch, AbortSignal, btoa });
  vm.runInContext(background.slice(background.indexOf('function isCacheableImageUrl('),
    background.indexOf('function parseSemVer(')), context);
  return context;
}

test('image downloader restricts URLs and senders before making requests', async () => {
  const context = worker(() => assert.fail('Must not fetch rejected URLs'));
  for (const target of ['https://evil.example/x', 'https://fbcdn.net.evil.example/x',
    'http://scontent.fbcdn.net/x', 'file:///photo.png', 'https://user:pass@fbcdn.net/x']) {
    await assert.rejects(context.downloadImageForCache(target, 'https://www.messenger.com/'));
  }
  await assert.rejects(context.downloadImageForCache(url, 'https://messenger.com.evil.example/'));
  await assert.rejects(context.downloadImageForCache(url, ''));
});

test('image downloader saves bytes with no credentials and rejects redirects', async () => {
  const context = worker(async (target, options) => {
    assert.equal(target, url);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
  });
  assert.equal(await context.downloadImageForCache(url, 'https://www.messenger.com/t/1'), cached);
});

test('image downloader rejects HTTP errors, non-images, empty and oversized bodies', async () => {
  for (const response of [
    new Response('', { status: 403 }),
    new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    new Response('', { headers: { 'content-type': 'image/png' } }),
    new Response(new Uint8Array(5 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } })
  ]) {
    const context = worker(async () => response);
    await assert.rejects(context.downloadImageForCache(url, 'https://www.facebook.com/'));
  }
});

function cacheHarness() {
  const requests = [];
  const timers = [];
  let clock = 0;
  let saves = 0;
  const record = { messageId: 'image_1', attachments: [url, 'https://scontent.fbcdn.net/other.png'] };
  const unsent = { ...record, isUnsent: true, attachments: [...record.attachments] };
  const row = {};
  const context = vm.createContext({
    recentMessagesList: [record], unsentMessagesList: [unsent],
    messagesById: new Map([[record.messageId, record]]),
    visibleMessagesSnapshot: new Map([[record.messageId, record]]),
    domRowMessages: new WeakMap([[row, record]]),
    getActualChatRows: () => [row],
    isExtensionContextValid: () => true,
    isDashMpdXmlString: () => false,
    scheduleDomScan() {}, dlog() {},
    saveToStorage() { saves++; },
    Date: { now: () => clock },
    setTimeout(callback, delay) { timers.push({ callback, due: clock + delay }); },
    chrome: { runtime: { sendMessage(message, callback) { requests.push({ message, callback }); } } }
  });
  vm.runInContext(content.slice(content.indexOf('  function getAttachmentMediaType('),
    content.indexOf('  function isExtensionContextValid(')), context);
  vm.runInContext(content.slice(content.indexOf('  const cachedImageMap ='),
    content.indexOf('  function getActualChatRows(')), context);
  return { context, requests, record, unsent, get saves() { return saves; }, advance(ms) {
    clock += ms;
    for (const timer of timers.splice(0)) {
      if (timer.due <= clock) timer.callback();
      else timers.push(timer);
    }
  } };
}

test('album retains both a local image and other uncached images', () => {
  const h = cacheHarness();
  assert.deepEqual(Array.from(h.context.sanitizeAttachmentsList([cached, url])), [cached, url]);
});

test('download completion after unsend updates captured and unsent history without dropping album photos', () => {
  const h = cacheHarness();
  h.context.queueImageCache(url);
  h.context.queueImageCache(url);
  assert.equal(h.requests.length, 1, 'one pending request per URL');
  h.requests[0].callback({ ok: true, dataUrl: cached });
  assert.deepEqual(Array.from(h.record.attachments), [cached, 'https://scontent.fbcdn.net/other.png']);
  assert.deepEqual(Array.from(h.unsent.attachments), Array.from(h.record.attachments));
  assert.equal(h.saves, 1);
  assert.deepEqual(Array.from(h.context.sanitizeAttachmentsList([url, cached])), [cached]);
});

test('image queue runs three requests at a time and continues after failure', () => {
  const h = cacheHarness();
  for (let i = 0; i < 5; i++) h.context.queueImageCache(`${url}?image=${i}`);
  assert.equal(h.requests.length, 3);
  h.requests[0].callback({ ok: false, error: 'offline' });
  assert.equal(h.requests.length, 4);
  h.requests[1].callback({ ok: true, dataUrl: cached });
  assert.equal(h.requests.length, 5);
});

test('failed downloads retry twice then stop and retain the original URL', () => {
  const h = cacheHarness();
  h.context.queueImageCache(url);
  h.requests[0].callback({ ok: false, error: 'offline' });
  h.advance(2000);
  h.requests[1].callback({ ok: false, error: 'offline' });
  h.advance(4000);
  h.requests[2].callback({ ok: false, error: 'offline' });
  h.advance(100000);
  h.context.queueImageCache(url);
  assert.equal(h.requests.length, 3);
  assert.equal(h.record.attachments[0], url);
  assert.equal(h.saves, 0);
});

test('local, blob, video and foreign URLs do not enter the download queue', () => {
  const h = cacheHarness();
  for (const target of [cached, 'blob:photo', 'https://example.com/x.png',
    'https://scontent.fbcdn.net/video.mp4', 'https://fbcdn.net.evil.example/x']) {
    h.context.queueImageCache(target);
  }
  assert.equal(h.requests.length, 0);
});

test('complete content script starts on Messenger and watches lazy image changes', () => {
  const timers = new Map();
  const documentEvents = {};
  let observerCallback;
  let observerOptions;
  let timerId = 0;
  const context = vm.createContext({
    location: { hostname: 'www.messenger.com', href: 'https://www.messenger.com/t/1', pathname: '/t/1' },
    document: {
      body: {}, cookie: '', visibilityState: 'visible',
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener(type, callback) { documentEvents[type] = callback; }
    },
    window: { addEventListener() {}, postMessage() {}, localStorage: { getItem: () => null } },
    chrome: {
      runtime: { id: 'test-extension', onMessage: { addListener() {} } },
      storage: {
        local: { remove() {}, get(_keys, callback) { callback({ fb_unsend_schema_v4_cleaned: true }); } },
        onChanged: { addListener() {} }
      }
    },
    MutationObserver: class {
      constructor(callback) { observerCallback = callback; }
      observe(_target, options) { observerOptions = options; }
    },
    setInterval() {},
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); }
  });
  context.HistoryStore = { ...context.chrome.storage.local, onChanged: context.chrome.storage.onChanged };
  vm.runInContext(fs.readFileSync(path.join(root, 'history-model.js'), 'utf8'), context);
  context.HistoryStore.mergeLocal = (incoming, local) => context.HistoryModel.merge(incoming, local);
  vm.runInContext(content, context);
  const startup = Array.from(timers.values()).find((timer) => timer.delay === 1000);
  assert.ok(startup, 'full content script reaches observer startup');
  startup.callback();
  assert.deepEqual(Array.from(observerOptions.attributeFilter), ['src', 'srcset']);
  function finishScan() {
    for (const [id, timer] of timers) {
      if (timer.delay === 60) { timers.delete(id); timer.callback(); }
    }
  }
  finishScan();
  observerCallback([{ type: 'attributes', attributeName: 'src' }]);
  assert.ok(Array.from(timers.values()).some((timer) => timer.delay === 60));
  finishScan();
  documentEvents.load({ target: { tagName: 'IMG' } });
  assert.ok(Array.from(timers.values()).some((timer) => timer.delay === 60));
});
