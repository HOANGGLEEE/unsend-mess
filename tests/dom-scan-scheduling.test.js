const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const start = source.indexOf('  let domScanTimer = null;');
const end = source.indexOf('  const EXTENSION_OWNED_MUTATION_SELECTOR', start);
const schedulerSource = source.slice(start, end);

function createHarness(historyReady = true) {
  let now = 10000;
  let nextId = 0;
  let fiberScans = 0;
  const domScans = [];
  const timers = new Map();
  const fakeSetTimeout = (callback, delay = 0) => {
    const id = ++nextId;
    timers.set(id, { callback, due: now + delay });
    return id;
  };
  class FakeDate extends Date {
    static now() { return now; }
  }
  const context = vm.createContext({
    historyReady,
    Date: FakeDate,
    setTimeout: fakeSetTimeout,
    requestMainWorldFiberScan() { fiberScans++; },
    scanChatMessagesInDom(record) { domScans.push(record || null); }
  });
  vm.runInContext(schedulerSource, context);
  function advance(ms) {
    const target = now + ms;
    while (true) {
      let next = null;
      for (const [id, timer] of timers) {
        if (timer.due <= target && (!next || timer.due < next.timer.due)) next = { id, timer };
      }
      if (!next) break;
      timers.delete(next.id);
      now = next.timer.due;
      next.timer.callback();
    }
    now = target;
  }
  return {
    schedule: context.scheduleDomScan,
    advance,
    get fiberScans() { return fiberScans; },
    get domScans() { return domScans; },
    get pendingTimers() { return timers.size; }
  };
}

test('DOM scan scheduler coalesces bursts and requests Fiber only when needed', () => {
  const h = createHarness();
  h.schedule();
  for (let i = 0; i < 20; i++) h.schedule(i === 19);
  h.advance(119);
  assert.equal(h.domScans.length, 0);
  h.advance(1);
  assert.equal(h.fiberScans, 1);
  assert.equal(h.domScans.length, 0);
  h.advance(80);
  assert.equal(h.domScans.length, 1);
});

test('DOM scans are rate-limited even when repeated changes keep arriving', () => {
  const h = createHarness();
  h.schedule();
  h.advance(120);
  assert.equal(h.domScans.length, 1);
  h.schedule();
  h.schedule();
  h.advance(449);
  assert.equal(h.domScans.length, 1);
  h.advance(1);
  assert.equal(h.domScans.length, 2);
});

test('DOM restoration stays idle until history metadata is ready', () => {
  const h = createHarness(false);
  h.schedule(true);
  h.advance(5000);
  assert.equal(h.fiberScans, 0);
  assert.equal(h.domScans.length, 0);
  assert.equal(h.pendingTimers, 0);
});

test('the old unconditional 1.5-second full-row scan fallback is removed', () => {
  assert.ok(!source.includes('div[data-scope="messages_table"]:not([data-fb-unsend-restored="true"])'));
  assert.match(source, /function mutationTouchesChat\(mutation\)/);
});
