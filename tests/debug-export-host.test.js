const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const popup = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
const contentScript = fs.readFileSync(path.join(root, 'content.js'), 'utf8');

test('popup debug export searches Facebook and Messenger tabs', () => {
  assert.match(popup, /\*:\/\/\*\.facebook\.com\/\*/);
  assert.match(popup, /\*:\/\/\*\.messenger\.com\/\*/);
  assert.match(popup, /active-tab-content-script-unavailable/);
  assert.match(popup, /no-matching-facebook-messenger-tab/);
});

test('fallback debug JSON explains why content-world logs are unavailable', () => {
  assert.match(popup, /fallbackReason/);
  assert.match(popup, /contentScriptReachable: false/);
  assert.match(popup, /manifest: manifestCoverage/);
});

test('content debug JSON reports host and MAIN-world dump status', () => {
  assert.match(contentScript, /isMessengerHost/);
  assert.match(contentScript, /mainWorldDumpReceived/);
  assert.match(contentScript, /mainWorldDumpKeys/);
});
