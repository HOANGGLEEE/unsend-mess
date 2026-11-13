const test = require('node:test');
const assert = require('node:assert');

function getStorageKeys(platform) {
  if (platform === 'instagram') {
    return {
      MESSAGES: 'ig_captured_messages_v2',
      UNSENT: 'ig_unsent_messages_v2',
      UNREAD_COUNT: 'ig_unread_unsent_count_v2'
    };
  }
  return {
    MESSAGES: 'fb_captured_messages_v2',
    UNSENT: 'fb_unsent_messages_v2',
    UNREAD_COUNT: 'fb_unread_unsent_count_v2'
  };
}

test('Storage keys for Facebook and Instagram are strictly isolated', () => {
  const fbKeys = getStorageKeys('facebook');
  const igKeys = getStorageKeys('instagram');
  assert.notStrictEqual(fbKeys.MESSAGES, igKeys.MESSAGES);
  assert.notStrictEqual(fbKeys.UNSENT, igKeys.UNSENT);
  assert.notStrictEqual(fbKeys.UNREAD_COUNT, igKeys.UNREAD_COUNT);
  assert.strictEqual(fbKeys.MESSAGES, 'fb_captured_messages_v2');
  assert.strictEqual(igKeys.MESSAGES, 'ig_captured_messages_v2');
  assert.strictEqual(fbKeys.UNSENT, 'fb_unsent_messages_v2');
  assert.strictEqual(igKeys.UNSENT, 'ig_unsent_messages_v2');
});

