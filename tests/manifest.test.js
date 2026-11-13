const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('manifest injects MAIN and isolated scripts on Facebook and Messenger domains', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const expectedHosts = ['*://*.facebook.com/*', '*://*.messenger.com/*'];

  for (const host of expectedHosts) {
    assert.ok(manifest.host_permissions.includes(host), 'host_permissions must include ' + host);
  }

  const mainScript = manifest.content_scripts.find((script) => script.world === 'MAIN');
  const isolatedScript = manifest.content_scripts.find((script) => !script.world || script.world === 'ISOLATED');
  assert.ok(mainScript, 'MAIN world script must exist');
  assert.ok(isolatedScript, 'ISOLATED content script must exist');

  for (const host of expectedHosts) {
    assert.ok(mainScript.matches.includes(host), 'MAIN world must match ' + host);
    assert.ok(isolatedScript.matches.includes(host), 'ISOLATED world must match ' + host);
  }
});

test('Facebook-only scope does not activate Instagram host permissions', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.ok(!manifest.host_permissions.some((host) => host.includes('instagram.com')));
});
