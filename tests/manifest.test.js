const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('manifest.json enables Facebook content scripts for the Facebook-only build', () => {
  const manifestRaw = fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);

  assert.ok(
    manifest.host_permissions.includes('*://*.facebook.com/*'),
    'host_permissions must include facebook.com'
  );

  const mainScript = manifest.content_scripts.find(s => s.world === 'MAIN');
  assert.ok(mainScript, 'MAIN world script must exist');
  assert.ok(
    mainScript.matches.includes('*://*.facebook.com/*'),
    'MAIN world script must match facebook.com'
  );

  const isolatedScript = manifest.content_scripts.find(s => !s.world || s.world === 'ISOLATED');
  assert.ok(isolatedScript, 'ISOLATED content script must exist');
  assert.ok(
    isolatedScript.matches.includes('*://*.facebook.com/*'),
    'ISOLATED script must match facebook.com'
  );
});
