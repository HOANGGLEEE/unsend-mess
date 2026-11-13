const test = require('node:test');
const assert = require('node:assert');

function detectPlatformFromUrl(url) {
  if (!url || typeof url !== 'string') return 'facebook';
  if (/instagram\.com/i.test(url)) return 'instagram';
  return 'facebook';
}

function getProfileUrl(platform, identifier) {
  if (platform === 'instagram') {
    return `https://www.instagram.com/${identifier}/`;
  }
  return `https://www.facebook.com/${identifier}`;
}

test('detectPlatformFromUrl detects instagram from tab URL', () => {
  assert.strictEqual(detectPlatformFromUrl('https://www.instagram.com/direct/t/123/'), 'instagram');
  assert.strictEqual(detectPlatformFromUrl('https://www.facebook.com/messages/t/456/'), 'facebook');
  assert.strictEqual(detectPlatformFromUrl('chrome://extensions/'), 'facebook');
});

test('getProfileUrl builds correct URLs', () => {
  assert.strictEqual(getProfileUrl('instagram', 'john_doe'), 'https://www.instagram.com/john_doe/');
  assert.strictEqual(getProfileUrl('facebook', '100012345'), 'https://www.facebook.com/100012345');
});

