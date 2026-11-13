const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('manifest.json includes instagram.com permissions and content scripts', () => {
  const manifestRaw = fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);

  assert.ok(manifest.host_permissions.includes('*://*.instagram.com/*'), 'host_permissions must include instagram.com');
  
  const mainScript = manifest.content_scripts.find(s => s.world === 'MAIN');
  assert.ok(mainScript.matches.includes('*://*.instagram.com/*'), 'MAIN world script must match instagram.com');

  const isolatedScript = manifest.content_scripts.find(s => !s.world || s.world === 'ISOLATED');
  assert.ok(isolatedScript.matches.includes('*://*.instagram.com/*'), 'ISOLATED script must match instagram.com');
});

