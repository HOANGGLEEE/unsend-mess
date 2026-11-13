# Instagram Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend FB Unsend Viewer to support Instagram Direct Web with full feature parity (network interception, real-time unsend detection, in-place DOM restoration, multimedia recovery, toast notifications, and context-aware popup history), while guaranteeing zero regressions on Facebook.

**Architecture:** Adapter/Driver Pattern with Platform Dispatchers. `injected.js` and `content.js` branch by `location.hostname` to run either `FacebookDriver` (preserving 100% of existing Lightspeed logic) or `InstagramDriver` (HTTP Direct v2, MQTT WebSocket, and Instagram DOM/Fiber restoration). Storage is partitioned into `fb_*` and `ig_*`, and `popup.js` dynamically adapts to the active tab.

**Tech Stack:** JavaScript (ES6+ / Chromium Manifest V3), Chrome Storage API, WebSockets / MQTT, DOM MutationObserver, Node.js built-in test runner (`node --test`).

**Spec:** `docs/superpowers/specs/2026-11-06-instagram-support-design.md`

## Global Constraints

- No regressions on Facebook: Facebook Lightspeed/`__d`/`MAWVault` hooks must remain intact.
- 100% Local & Offline: No external servers or analytics.
- Storage keys must be isolated: `fb_*` for Facebook and `ig_*` for Instagram.
- Manifest V3 compliant: No eval, no remote scripts, valid CSP.
- Clean vanilla JS: No bundler required, runnable as unpacked extension.

---

### Task 1: Manifest & Platform Dispatcher Foundation

**Files:**
- Modify: `manifest.json`
- Modify: `injected.js`
- Modify: `content.js`
- Create: `tests/manifest.test.js`

**Interfaces:**
- Consumes: `location.hostname`
- Produces: Platform dispatcher branching in `injected.js` (`isInstagramPlatform`, `isFacebookPlatform`) and `content.js`

- [ ] **Step 1: Write the failing test for manifest & platform detection**

Create `tests/manifest.test.js`:
```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/manifest.test.js`
Expected: FAIL (host_permissions missing `instagram.com`).

- [ ] **Step 3: Update `manifest.json`**

Add `*://*.instagram.com/*` to `host_permissions` and `content_scripts.matches`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/manifest.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add manifest.json tests/manifest.test.js
git commit -m "feat(manifest): add instagram.com host permissions and content scripts"
```

---

### Task 2: Instagram Main Driver (`injected.js`) - Network Interception & Normalizer

**Files:**
- Modify: `injected.js`
- Create: `tests/instagram-normalizer.test.js`

**Interfaces:**
- Consumes: HTTP responses (`/api/v1/direct_v2/web/threads/...`), WebSocket MQTT frames
- Produces: `IG_MSG_CAPTURED` and `IG_MSG_UNSENT` messages via `window.postMessage`

- [ ] **Step 1: Write failing test for Instagram message normalization**

Create `tests/instagram-normalizer.test.js`:
```javascript
const test = require('node:test');
const assert = require('node:assert');

// Logic to extract & normalize Instagram items
function normalizeInstagramItem(item, threadId) {
  if (!item || !item.item_id) return null;
  let text = '';
  const attachments = [];
  let mediaType = 'none';

  if (item.item_type === 'text') {
    text = item.text || '';
  } else if (item.item_type === 'media' && item.media) {
    mediaType = item.media.media_type === 2 ? 'video' : 'image';
    if (item.media.image_versions2?.candidates?.[0]?.url) {
      attachments.push(item.media.image_versions2.candidates[0].url);
    }
    if (item.media.video_versions?.[0]?.url) {
      attachments.push(item.media.video_versions[0].url);
    }
  } else if (item.item_type === 'raven_media' && item.visual_media) {
    mediaType = 'view_once';
    text = '① Ảnh (Xem 1 lần)';
    const cand = item.visual_media.media?.image_versions2?.candidates?.[0]?.url;
    if (cand) attachments.push(cand);
  } else if (item.item_type === 'voice_media' && item.voice_media?.media?.audio) {
    mediaType = 'audio';
    text = '🎵 Tin nhắn thoại';
    attachments.push(item.voice_media.media.audio.audio_src);
  } else if (item.item_type === 'animated_media' && item.animated_media?.images?.fixed_height?.url) {
    mediaType = 'image';
    attachments.push(item.animated_media.images.fixed_height.url);
  }

  return {
    platform: 'instagram',
    messageId: String(item.item_id),
    threadId: String(threadId || item.thread_id || ''),
    senderId: String(item.user_id || ''),
    text,
    attachments,
    mediaType,
    timestamp: item.timestamp ? Math.floor(Number(item.timestamp) / 1000) : Date.now(),
    source: 'IG_DIRECT_API'
  };
}

test('normalizeInstagramItem handles text message', () => {
  const item = { item_id: '12345', item_type: 'text', text: 'Xin chao', user_id: '999', timestamp: '1700000000000000' };
  const res = normalizeInstagramItem(item, 'thread_1');
  assert.strictEqual(res.messageId, '12345');
  assert.strictEqual(res.text, 'Xin chao');
  assert.strictEqual(res.platform, 'instagram');
});

test('normalizeInstagramItem handles raven view once media', () => {
  const item = {
    item_id: '67890',
    item_type: 'raven_media',
    user_id: '999',
    visual_media: { media: { image_versions2: { candidates: [{ url: 'https://cdn.instagram.com/photo.jpg' }] } } }
  };
  const res = normalizeInstagramItem(item, 'thread_1');
  assert.strictEqual(res.mediaType, 'view_once');
  assert.strictEqual(res.attachments[0], 'https://cdn.instagram.com/photo.jpg');
});
```

- [ ] **Step 2: Run test to verify baseline logic**

Run: `node --test tests/instagram-normalizer.test.js`
Expected: PASS.

- [ ] **Step 3: Implement Instagram Network Interception in `injected.js`**

Implement `initInstagramMainDriver()` inside `injected.js`:
- Intercept `window.fetch` to parse response JSON from `/api/v1/direct_v2/web/threads/` and `/direct_v2/threads/broadcast/`.
- Intercept `window.WebSocket` for `edge-chat.instagram.com`:
  - Decode binary/text frames for MQTT publish packets.
  - Detect `action_type === 'item_removed'` or `"item_removed"` unsend commands.
- Dispatch `window.postMessage({ source: 'IG_UNSEND_EXTENSION_MAIN', type: 'IG_MSG_CAPTURED', payload: normalizedMsg })`.
- Dispatch `window.postMessage({ source: 'IG_UNSEND_EXTENSION_MAIN', type: 'IG_MSG_UNSENT', payload: { messageId, threadId } })`.

- [ ] **Step 4: Verify syntax and integration**

Run: `node -c injected.js`
Expected: Exit 0 (Valid JavaScript).

- [ ] **Step 5: Commit**

```bash
git add injected.js tests/instagram-normalizer.test.js
git commit -m "feat(instagram): implement network interception and normalizer in injected.js"
```

---

### Task 3: Instagram Content Driver (`content.js` & `styles.css`) - DOM Restorer

**Files:**
- Modify: `content.js`
- Modify: `styles.css`
- Create: `tests/instagram-dom.test.js`

**Interfaces:**
- Consumes: `IG_MSG_CAPTURED`, `IG_MSG_UNSENT`
- Produces: In-place DOM bubble restoration (`.ig-unsend-restored-bubble`), Toast notifications

- [ ] **Step 1: Write failing test for Instagram storage & unsend matching logic**

Create `tests/instagram-dom.test.js`:
```javascript
const test = require('node:test');
const assert = require('node:assert');

test('Instagram unsend matches cached item by messageId', () => {
  const cachedMessages = new Map();
  cachedMessages.set('msg_100', {
    platform: 'instagram',
    messageId: 'msg_100',
    text: 'Tin nhan quan trong',
    senderId: 'user_1'
  });

  const unsendEvent = { messageId: 'msg_100' };
  const matched = cachedMessages.get(unsendEvent.messageId);
  assert.ok(matched, 'Must find matched message');
  assert.strictEqual(matched.text, 'Tin nhan quan trong');
});
```

- [ ] **Step 2: Run test to verify logic**

Run: `node --test tests/instagram-dom.test.js`
Expected: PASS.

- [ ] **Step 3: Implement Instagram Content Driver in `content.js`**

- Add `initInstagramContentDriver()` in `content.js`:
  - Listen for `window.addEventListener('message')` with source `IG_UNSEND_EXTENSION_MAIN`.
  - Handle `IG_MSG_CAPTURED`: persist to `ig_captured_messages_v2`.
  - Handle `IG_MSG_UNSENT`: persist to `ig_unsent_messages_v2`, increment badge, trigger Toast.
  - Setup MutationObserver on Instagram chat containers:
    - Target message nodes in Instagram Direct.
    - Check for removed message nodes or unsend placeholders.
    - Insert `.ig-unsend-restored-bubble` with `[ĐÃ GỠ]`, restored text, Lightbox image preview, or Audio/Video player.
- Add CSS in `styles.css` for `.ig-unsend-restored-bubble` matching Instagram's 22px border radius, Dark mode (`#262626`) and Light mode (`#efefef`).

- [ ] **Step 4: Verify syntax**

Run: `node -c content.js`
Expected: Exit 0.

- [ ] **Step 5: Commit**

```bash
git add content.js styles.css tests/instagram-dom.test.js
git commit -m "feat(instagram): implement DOM observer, unsend restorer, and styling in content.js"
```

---

### Task 4: Storage Partitioning & Shared Core

**Files:**
- Modify: `content.js`
- Create: `tests/storage-partition.test.js`

**Interfaces:**
- Consumes: Platform identifier (`facebook` vs `instagram`)
- Produces: Isolated storage keys (`fb_*` vs `ig_*`)

- [ ] **Step 1: Write test for storage keys isolation**

Create `tests/storage-partition.test.js`:
```javascript
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

test('Storage keys for Facebook and Instagram are isolated', () => {
  const fbKeys = getStorageKeys('facebook');
  const igKeys = getStorageKeys('instagram');
  assert.notStrictEqual(fbKeys.MESSAGES, igKeys.MESSAGES);
  assert.notStrictEqual(fbKeys.UNSENT, igKeys.UNSENT);
  assert.notStrictEqual(fbKeys.UNREAD_COUNT, igKeys.UNREAD_COUNT);
});
```

- [ ] **Step 2: Run test**

Run: `node --test tests/storage-partition.test.js`
Expected: PASS.

- [ ] **Step 3: Integrate Storage Partition in `content.js`**

Ensure all storage operations for Instagram use `ig_*` and Facebook operations use `fb_*`.

- [ ] **Step 4: Commit**

```bash
git add content.js tests/storage-partition.test.js
git commit -m "feat: enforce storage isolation between Facebook and Instagram"
```

---

### Task 5: Context-Aware Popup Dashboard (`popup.html`, `popup.js`, `popup.css`)

**Files:**
- Modify: `popup.html`
- Modify: `popup.js`
- Modify: `popup.css`
- Create: `tests/popup-platform.test.js`

**Interfaces:**
- Consumes: Active Chrome tab URL
- Produces: Dynamic platform view (`facebook` vs `instagram`), platform tabs switcher, profile links

- [ ] **Step 1: Write test for popup active platform detection**

Create `tests/popup-platform.test.js`:
```javascript
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
```

- [ ] **Step 2: Run test**

Run: `node --test tests/popup-platform.test.js`
Expected: PASS.

- [ ] **Step 3: Update `popup.html`, `popup.js`, and `popup.css`**

- In `popup.html`: Add a platform tab toggle bar:
  ```html
  <div class="platform-tabs" id="platformTabs">
    <button class="platform-tab active" data-platform="facebook">Facebook</button>
    <button class="platform-tab" data-platform="instagram">Instagram</button>
  </div>
  ```
- In `popup.js`:
  - Detect current tab on open; activate either Facebook or Instagram tab.
  - Bind click on `.platform-tab` to switch active platform and load corresponding storage partition (`fb_*` vs `ig_*`).
  - Render profile links using `getProfileUrl(activePlatform, senderId)`.
  - Update export/import logic to handle the active platform.
- In `popup.css`: Style `.platform-tabs` with clean modern pill buttons matching the extension's theme.

- [ ] **Step 4: Verify syntax**

Run: `node -c popup.js`
Expected: Exit 0.

- [ ] **Step 5: Commit**

```bash
git add popup.html popup.js popup.css tests/popup-platform.test.js
git commit -m "feat(popup): add context-aware active tab detection and platform switcher"
```

---

### Task 6: Service Worker Badge & Full System Verification

**Files:**
- Modify: `background.js`
- Create: `tests/full-suite.test.js`

**Interfaces:**
- Consumes: Storage changes on `fb_unread_unsent_count_v2` and `ig_unread_unsent_count_v2`
- Produces: Action badge count update

- [ ] **Step 1: Write test for badge aggregation**

Create `tests/full-suite.test.js`:
```javascript
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
});
```

- [ ] **Step 2: Run test**

Run: `node --test tests/full-suite.test.js`
Expected: PASS.

- [ ] **Step 3: Update `background.js`**

- Track changes for both `fb_unread_unsent_count_v2` and `ig_unread_unsent_count_v2`.
- Update badge text accordingly.

- [ ] **Step 4: Run all tests in repository**

Run: `node --test tests/*.test.js`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add background.js tests/full-suite.test.js
git commit -m "feat(background): support badge updates for both platforms and complete verification"
```

