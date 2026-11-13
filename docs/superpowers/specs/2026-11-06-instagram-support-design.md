# Technical Design Spec: Multi-Platform Unsent Message Viewer (Facebook & Instagram)

**Author:** Antigravity (Senior Fullstack Developer & BA)  
**Role of User:** Product Owner (PO)  
**Date:** 2026-11-06  
**Status:** Approved by PO / Pending Spec Review  
**Target Repo:** `fb-unsend-viewer`  

---

## 1. Executive Summary & Goals

### 1.1 Context
`fb-unsend-viewer` is a Chrome Extension (Manifest V3) designed to silently intercept and restore unsent messages on Facebook Messenger. The PO requested adding full support for **Instagram Direct Web** (`https://www.instagram.com/direct/...`), retaining full parity with existing Facebook capabilities (real-time interception, in-place DOM chat bubble restoration with `[ĐÃ GỠ]`, multimedia recovery, toast notifications, and popup history).

### 1.2 Key Requirements
1. **Multi-Platform Support**: Work seamlessly on both `facebook.com` and `instagram.com` without requiring separate extensions.
2. **Zero Regressions**: Zero modifications that break or degrade existing Facebook Messenger Lightspeed & E2EE capabilities.
3. **Instagram Full Parity**:
   - Intercept standard Instagram Direct messages (text, photos, videos, audio clips, stickers, and view-once media).
   - Support End-to-End Encrypted (E2EE) Instagram chats where available.
   - Real-time detection of unsend events (via MQTT/WebSocket, REST API, or DOM disappearance).
   - In-place DOM restoration: Replace or render unsent bubbles directly inside Instagram's chat view styled to match Instagram's UI (`border-radius: 22px`, Light/Dark themes).
   - Toast notifications on unsend events.
4. **Isolated Storage & Context-Aware Popup**:
   - Separate storage partitions for Facebook and Instagram (`fb_*` vs `ig_*`).
   - When opened on an Instagram tab, Popup displays Instagram unsent messages with links to `instagram.com/{username}`.
   - When opened on a Facebook tab, Popup displays Facebook unsent messages.
   - When opened on any other tab, provide a tab toggle `[Facebook | Instagram]` to switch between views.

---

## 2. Architecture: Multi-Platform Adapter Pattern

To prevent code bloat and avoid regressions on Facebook, the codebase transitions to an **Adapter/Driver Pattern**:

```
                         ┌─────────────────────────────┐
                         │    Chrome Extension Host    │
                         │        (Manifest V3)        │
                         └──────────────┬──────────────┘
                                        │
                      ┌─────────────────┴─────────────────┐
                      ▼                                   ▼
             facebook.com/*                      instagram.com/*
       ┌───────────────────────────┐       ┌───────────────────────────┐
       │      Facebook Driver      │       │     Instagram Driver      │
       ├───────────────────────────┤       ├───────────────────────────┤
       │ MAIN:                     │       │ MAIN:                     │
       │ - window.__d hook         │       │ - fetch & XHR hook        │
       │ - Lightspeed procedures   │       │ - WebSocket (MQTT) hook   │
       │ - MAWVault / TextDecoder  │       │ - Armadillo E2EE hook     │
       │ ISOLATED:                 │       │ ISOLATED:                 │
       │ - messages_table selector │       │ - Instagram DM selectors  │
       │ - FB Context Anchoring    │       │ - Disappearance tracker   │
       │ - FB Bubble Styler        │       │ - IG Bubble Styler (22px) │
       └──────────────┬────────────┘       └──────────────┬────────────┘
                      │                                   │
                      └─────────────────┬─────────────────┘
                                        ▼
                      ┌───────────────────────────────────┐
                      │            Shared Core            │
                      ├───────────────────────────────────┤
                      │ - Canonical Message Schema        │
                      │ - Storage Partition Manager       │
                      │ - Toast Notification System       │
                      │ - Multimedia Helpers (Lightbox,   │
                      │   Audio, Video, WebP Compressor)  │
                      │ - Monotonic Timestamp Generator   │
                      └─────────────────┬─────────────────┘
                                        ▼
                      ┌───────────────────────────────────┐
                      │    Context-Aware Popup & SW       │
                      │ - Active tab detection (FB vs IG) │
                      │ - Segmented history views         │
                      │ - Unread badge management         │
                      └───────────────────────────────────┘
```

---

## 3. Data Schema: Canonical Message

All platform-specific messages are mapped into a standardized `CanonicalMessage` format:

```typescript
interface CanonicalMessage {
  platform: 'facebook' | 'instagram';
  messageId: string;           // FB: 'mid.$...' | IG: '34028...' or UUID
  threadId: string;            // Platform thread identifier
  senderId: string;            // User ID
  senderName: string;          // User display name or username
  senderAvatar: string;        // Profile picture URL
  text: string;                // Message text or placeholder
  attachments: string[];       // URLs of images, audio, video
  mediaType?: 'image' | 'video' | 'audio' | 'view_once' | 'none';
  timestamp: number;           // Unix timestamp (ms)
  isUnsent?: boolean;          // True when message has been unsent
  unsentAt?: number;           // Unix timestamp (ms) when unsend was detected
  source: string;              // E.g., 'IG_DIRECT_API' | 'IG_MQTT' | 'FB_LS'
}
```

---

## 4. Platform Drivers Detail

### 4.1 Instagram Main Driver (`injected.js`)

When `location.hostname.includes('instagram.com')`, `injected.js` activates `initInstagramMainDriver()`:

1. **HTTP (Fetch & XHR) Hook**:
   - Intercepts requests matching `/api/v1/direct_v2/web/threads/` (thread history):
     - Parses JSON response containing `thread.items`.
     - Normalizes each item:
       - `item_type === 'text'`: extracts `item.text`.
       - `item_type === 'media'`: extracts highest resolution image or video URL.
       - `item_type === 'raven_media'`: extracts view-once media and labels `① Ảnh (Xem 1 lần)`.
       - `item_type === 'voice_media'`: extracts audio URL (`audio.audio_src`).
       - `item_type === 'animated_media'`: extracts GIF URL.
     - Registers captured items into the Instagram in-memory registry and dispatches `IG_MSG_CAPTURED` to `content.js`.
   - Intercepts `/api/v1/direct_v2/threads/broadcast/` for outgoing messages.

2. **WebSocket & MQTT Hook**:
   - Hooks `window.WebSocket` instances connecting to `wss://edge-chat.instagram.com/chat`.
   - Listens to incoming frames (MQTT Publish messages):
     - New message frames: parses incoming direct message items and emits `IG_MSG_CAPTURED`.
     - Unsend action frames: detects payloads containing `action_type: "item_removed"` or `item_removed` with target `item_id` and `thread_id`. Emits `IG_MSG_UNSENT` immediately.

3. **E2EE / Armadillo Support on Instagram**:
   - Hooks `TextDecoder.prototype.decode` to capture plain-text buffers decoded during Armadillo E2EE sessions.
   - Binds to any Meta module definitions (`__d`) matching Armadillo transforms on Instagram Web.

### 4.2 Instagram Content Driver (`content.js` + `styles.css`)

When `location.hostname.includes('instagram.com')`, `content.js` activates `initInstagramContentDriver()`:

1. **DOM Observation & Message Row Identification**:
   - Targets Instagram Direct message container within `div[role="main"]`.
   - Scans message bubble elements and their corresponding React Fiber nodes (`__reactFiber$`) to associate DOM nodes with Instagram `item_id`.
2. **Three-Tier Unsend Detection**:
   - **Tier 1 (Real-Time Network Event)**: Triggered immediately when `IG_MSG_UNSENT` arrives from the WebSocket or API hook.
   - **Tier 2 (DOM Disappearance Tracking)**: If a rendered message row whose `item_id` is cached disappears while the user is still on the same thread, an unsend is inferred.
   - **Tier 3 (Placeholder Mutation)**: Detects if Instagram replaces a bubble with an unsent placeholder.
3. **In-Place Chat DOM Restoration**:
   - Constructs an Instagram-tailored restored bubble:
     - Border radius: `22px`.
     - Colors:
       - Light mode: background `#efefef`, text `#262626`.
       - Dark mode: background `#262626`, text `#f5f5f5`.
     - Badges: `[ĐÃ GỠ]` pill tag.
     - Media previews: WebP cached images with click-to-enlarge Lightbox, HTML5 `<audio controls>` player, or HTML5 `<video controls>` player.
   - Fires the on-screen Toast notification.

---

## 5. Storage Partitioning & Popup Management

### 5.1 Storage Keys
- **Facebook**:
  - `fb_captured_messages_v2`
  - `fb_unsent_messages_v2`
  - `fb_unread_unsent_count_v2`
- **Instagram**:
  - `ig_captured_messages_v2`
  - `ig_unsent_messages_v2`
  - `ig_unread_unsent_count_v2`

### 5.2 Context-Aware Popup (`popup.js` / `popup.html`)
1. On popup open, query `chrome.tabs.query({ active: true, currentWindow: true })`:
   - If active tab is `*.instagram.com/*`: set active platform to `instagram`.
   - If active tab is `*.facebook.com/*`: set active platform to `facebook`.
   - Otherwise: default to last used platform or `instagram` if `facebook` is empty.
2. Render platform header and segment switcher tab (`[Facebook] [Instagram]`) so users can switch at any time.
3. Profile links:
   - Facebook: `https://www.facebook.com/${id}`
   - Instagram: `https://www.instagram.com/${username}/`

### 5.3 Service Worker (`background.js`)
- Listens to unread count increments from both platforms and combines or selects badge numbers based on the active tab context.

---

## 6. Manifest & Configuration Updates

`manifest.json`:
- `host_permissions`: Add `*://*.instagram.com/*`.
- `content_scripts`: Add `*://*.instagram.com/*` to both `injected.js` (world: MAIN) and `content.js` (world: ISOLATED).

---

## 7. Edge Cases & Resilience

1. **Instagram Dynamic SPA Navigation**:
   Instagram uses client-side routing (`window.history.pushState`). The content driver monitors URL changes (`/direct/t/{thread_id}/`) to flush active thread state and reload thread cache.
2. **Deduplication**:
   Messages received via both HTTP history fetching and WebSocket push are deduplicated by `item_id`.
3. **CDN Media Expiration**:
   Instagram CDN URLs (`scontent.cdninstagram.com`) expire over time. Captured media is converted to local WebP data URLs where possible (same as Facebook driver).

---

## 8. Verification Plan

1. **Code Validation**:
   - Verify `manifest.json` syntax and permissions.
   - Run linter / syntax checks on JavaScript files.
2. **Facebook Regression Test**:
   - Ensure all Facebook hooks, selectors, and Lightspeed listeners remain 100% functional.
3. **Instagram Functionality Test**:
   - Verify network interception on Instagram Direct HTTP and WebSocket.
   - Verify message caching and unsend event handling.
   - Verify in-place chat restoration and styling.
   - Verify Popup context detection, tab switching, and media playback.

