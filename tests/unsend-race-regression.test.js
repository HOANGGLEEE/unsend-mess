const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const injected = fs.readFileSync(path.join(root, 'injected.js'), 'utf8');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');

test('MAIN world retains unsend signals until the original message is captured', () => {
  assert.match(injected, /function rememberPendingUnsendSignal\(/);
  assert.match(injected, /function takePendingUnsendSignal\(/);
  assert.match(injected, /UNSENT-PENDING-RESOLVED/);
  assert.match(injected, /pendingUnsendSignals/);
});

test('content world replays pending unsend events after a late capture', () => {
  assert.match(content, /function rememberPendingUnsentEvent\(/);
  assert.match(content, /function takePendingUnsentEvent\(/);
  assert.match(content, /UNSENT-PENDING-REPLAY/);
  assert.match(content, /pendingUnsentEvents/);
});

test('debug export waits for the MAIN-world dump before using fallback data', () => {
  assert.match(content, /within 8000ms/);
  assert.match(content, /}, 8000\);/);
  assert.match(content, /FB_MAIN_DEBUG_DUMP/);
});
