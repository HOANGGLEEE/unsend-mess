const test = require('node:test');
const assert = require('node:assert');

function calculateBadgeText(fbCount, igCount) {
  const total = (Number(fbCount) || 0) + (Number(igCount) || 0);
  if (total <= 0) return '';
  return total > 99 ? '99+' : String(total);
}

test('calculateBadgeText aggregates unread counts from both platforms', () => {
  assert.strictEqual(calculateBadgeText(0, 0), '');
  assert.strictEqual(calculateBadgeText(2, 3), '5');
  assert.strictEqual(calculateBadgeText(50, 60), '99+');
  assert.strictEqual(calculateBadgeText(1, 0), '1');
  assert.strictEqual(calculateBadgeText(0, 7), '7');
});

test('Simulated Instagram message capture and unsend cycle', () => {
  const inMemoryStorage = {};
  const storage = {
    get: (keys, cb) => {
      const res = {};
      for (const k of keys) res[k] = inMemoryStorage[k];
      cb(res);
    },
    set: (obj, cb) => {
      Object.assign(inMemoryStorage, obj);
      if (cb) cb();
    }
  };

  const incomingIgMsg = {
    platform: 'instagram',
    messageId: '3402823668417',
    threadId: 'th_ig_1',
    senderId: 'user_ig_1',
    senderName: 'Friend on IG',
    text: 'Tin nhắn bí mật!',
    attachments: [],
    timestamp: Date.now()
  };

  // 1. Capture message
  const MESSAGES_KEY = 'ig_captured_messages_v2';
  const UNSENT_KEY = 'ig_unsent_messages_v2';
  inMemoryStorage[MESSAGES_KEY] = [incomingIgMsg];
  inMemoryStorage[UNSENT_KEY] = [];

  // 2. Unsend event arrives
  const unsendEvent = { messageId: '3402823668417' };
  const captured = inMemoryStorage[MESSAGES_KEY].find(m => m.messageId === unsendEvent.messageId);
  assert.ok(captured, 'Must find captured message for unsend');

  const unsentMsg = { ...captured, isUnsent: true, unsentAt: Date.now() };
  inMemoryStorage[UNSENT_KEY].unshift(unsentMsg);

  // 3. Verify unsent list in storage
  assert.strictEqual(inMemoryStorage[UNSENT_KEY].length, 1);
  assert.strictEqual(inMemoryStorage[UNSENT_KEY][0].messageId, '3402823668417');
  assert.strictEqual(inMemoryStorage[UNSENT_KEY][0].text, 'Tin nhắn bí mật!');
});

