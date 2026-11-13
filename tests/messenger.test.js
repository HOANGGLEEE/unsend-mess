const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const popup = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
const exportDebug = popup.slice(
  popup.indexOf('function exportDebugReport()'),
  popup.indexOf('function isTempId(')
);

test('Facebook and Messenger load both drivers and the stylesheet', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  for (const host of ['facebook', 'messenger']) {
    const pattern = `*://*.${host}.com/*`;
    assert.ok(manifest.host_permissions.includes(pattern));
    for (const script of ['injected.js', 'content.js']) {
      const entry = manifest.content_scripts.find((entry) => entry.js.includes(script));
      assert.ok(entry.matches.includes(pattern));
      if (script === 'injected.js') assert.equal(entry.world, 'MAIN');
      else assert.ok(entry.css.includes('styles.css'));
    }
  }
});

function runExport(platform, activeUrl, fallbackTabs = [], failedIds = []) {
  const queries = [];
  const sent = [];
  let fallback;
  const context = {
    currentPlatform: platform,
    downloadFallbackDebugJson(diagnostics) { fallback = diagnostics; },
    showStatus() {},
    chrome: {
      runtime: {},
      tabs: {
        query(query, callback) {
          queries.push(query);
          const previousError = context.chrome.runtime.lastError;
          context.chrome.runtime.lastError = undefined;
          callback(query.active ? [{ id: 1, url: activeUrl }] : fallbackTabs);
          context.chrome.runtime.lastError = previousError;
        },
        sendMessage(id, message, callback) {
          sent.push({ id, message });
          const previousError = context.chrome.runtime.lastError;
          context.chrome.runtime.lastError = failedIds.includes(id) ? { message: 'Receiving end does not exist.' } : undefined;
          callback(failedIds.includes(id) ? undefined : { ok: true });
          context.chrome.runtime.lastError = previousError;
        }
      }
    }
  };
  vm.runInNewContext(`${exportDebug}\nexportDebugReport();`, context);
  return { queries, sent, fallback };
}

test('Debug export uses the active Messenger tab', () => {
  const result = runExport('facebook', 'https://www.messenger.com/t/123');
  assert.equal(result.queries.length, 1);
  assert.equal(result.sent[0].id, 1);
  assert.equal(result.sent[0].message.type, 'TRIGGER_DEBUG_EXPORT');
  assert.equal(result.fallback, undefined);
});

test('Debug export searches Messenger when a different site is active', () => {
  const result = runExport('facebook', 'https://example.com/', [{ id: 2 }]);
  assert.deepEqual(Array.from(result.queries[1].url), [
    '*://*.facebook.com/*', '*://*.messenger.com/*'
  ]);
  assert.equal(result.sent[0].id, 2);
  assert.equal(result.fallback, undefined);
});

test('Instagram Debug export keeps its own tab filter', () => {
  const result = runExport('instagram', 'https://www.messenger.com/', [{ id: 3 }]);
  assert.deepEqual(Array.from(result.queries[1].url), ['*://*.instagram.com/*']);
  assert.equal(result.sent[0].id, 3);
  assert.equal(result.fallback, undefined);
});

test('Debug export skips unreachable tabs and reaches the next matching tab', () => {
  const result = runExport('facebook', 'https://www.messenger.com/t/1',
    [{ id: 1 }, { id: 2 }, { id: 3 }], [1, 2]);
  assert.deepEqual(result.sent.map((attempt) => attempt.id), [1, 2, 3]);
  assert.equal(result.fallback, undefined);
});

test('unreachable content script produces a diagnostic error instead of silent storage fallback', () => {
  const result = runExport('facebook', 'https://www.messenger.com/t/1', [{ id: 1 }], [1]);
  assert.equal(result.fallback.reason, 'content-script-unreachable');
  assert.equal(result.fallback.activeTabUrl, 'https://www.messenger.com/t/1');
  assert.equal(result.fallback.attempts.length, 1);
  assert.equal(result.fallback.attempts[0].error, 'Receiving end does not exist.');
});

test('Debug export distinguishes no matching tab from a broken content script', () => {
  const result = runExport('facebook', 'https://example.com/');
  assert.equal(result.fallback.reason, 'no-matching-tab');
  assert.equal(result.fallback.attempts.length, 0);
});
