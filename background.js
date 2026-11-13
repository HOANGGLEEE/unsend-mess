/**
 * FB Unsend Message Viewer — background.js
 * Copyright (c) 2026 binhake (https://github.com/binhake/fb-unsend-viewer)
 * Licensed under the Non-Commercial & Strict Attribution License.
 * Removing author attribution ("binhake") or unauthorized commercial use is strictly prohibited.
 */
// background.js - Service Worker quản lý Badge thông báo tin nhắn thu hồi & kiểm tra bản phát hành mới trên GitHub Releases
importScripts('history-model.js', 'history-repository.js');

// Accept writes from tabs opened before the upgrade until they are reloaded.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const patch = Object.fromEntries(HistoryModel.keys.filter((key) => Array.isArray(changes[key]?.newValue))
    .map((key) => [key, changes[key].newValue]));
  if (Object.keys(patch).length) HistoryRepository.run({ type: 'HISTORY_LEGACY', patch }).catch(console.error);
});

const STORAGE_KEY_UNREAD_COUNT = 'fb_unread_unsent_count_v2';
const STORAGE_KEY_IG_UNREAD_COUNT = 'ig_unread_unsent_count_v2';
const STORAGE_KEY_UPDATE_INFO = 'fb_unsend_update_info_v1';
const GITHUB_LATEST_RELEASE_API =
  'https://api.github.com/repos/binhake/fb-unsend-viewer/releases/latest';
const GITHUB_RELEASES_PAGE_URL = 'https://github.com/binhake/fb-unsend-viewer/releases';
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 giờ

function isCacheableImageUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && !url.username && !url.password &&
      ['fbcdn.net', 'fbsbx.com'].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch (_) { return false; }
}

async function downloadImageForCache(rawUrl, senderUrl) {
  const sender = new URL(senderUrl);
  if (!/^https?:$/.test(sender.protocol) ||
      !['facebook.com', 'messenger.com'].some((host) => sender.hostname === host || sender.hostname.endsWith(`.${host}`)) ||
      !isCacheableImageUrl(rawUrl)) {
    throw new Error('Image cache request is not allowed');
  }
  const response = await fetch(rawUrl, {
    credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Image HTTP ${response.status}`);
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(mime)) throw new Error('Unsupported image type');
  const maxBytes = 5 * 1024 * 1024;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error('Image exceeds 5 MB cache limit');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally { reader.releaseLock(); }
  if (!size) throw new Error('Empty image');
  let binary = '';
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 32768) {
      binary += String.fromCharCode(...chunk.subarray(i, i + 32768));
    }
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function parseSemVer(verStr) {
  const clean = String(verStr || '')
    .trim()
    .replace(/^[vV]+/, '')
    .split('-')[0];
  if (!/^\d+(\.\d+)*$/.test(clean)) return null;
  return clean.split('.').map((n) => parseInt(n, 10) || 0);
}

function isNewerVersion(remoteVer, localVer) {
  const r = parseSemVer(remoteVer);
  const l = parseSemVer(localVer);
  if (!r || !l) return false;
  const maxLen = Math.max(r.length, l.length);
  for (let i = 0; i < maxLen; i++) {
    const rv = r[i] || 0;
    const lv = l[i] || 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

function refreshBadgeFromStorage() {
  chrome.storage.local.get(
    [STORAGE_KEY_UNREAD_COUNT, STORAGE_KEY_IG_UNREAD_COUNT, STORAGE_KEY_UPDATE_INFO],
    (res) => {
      const fbUnread = Number(res[STORAGE_KEY_UNREAD_COUNT]) || 0;
      const igUnread = Number(res[STORAGE_KEY_IG_UNREAD_COUNT]) || 0;
      const unreadNum = fbUnread + igUnread;

      if (unreadNum > 0) {
        const text = unreadNum > 99 ? '99+' : String(unreadNum);
        chrome.action.setBadgeText({ text });
        chrome.action.setBadgeBackgroundColor({ color: '#ff4d4f' });
        return;
      }

      const updateInfo = res[STORAGE_KEY_UPDATE_INFO];
      const currentVer = chrome.runtime.getManifest().version;
      if (
        updateInfo &&
        updateInfo.latestVersion &&
        isNewerVersion(updateInfo.latestVersion, currentVer) &&
        updateInfo.dismissedVersion !== updateInfo.latestVersion
      ) {
        chrome.action.setBadgeText({ text: 'NEW' });
        chrome.action.setBadgeBackgroundColor({ color: '#0866ff' });
      } else {
        chrome.action.setBadgeText({ text: '' });
      }
    }
  );
}

async function checkForGithubReleaseUpdate(force = false) {
  try {
    const currentVer = chrome.runtime.getManifest().version;
    const stored = await chrome.storage.local.get([STORAGE_KEY_UPDATE_INFO]);
    const prevInfo = stored[STORAGE_KEY_UPDATE_INFO] || {};

    if (
      !force &&
      prevInfo.checkedAt &&
      Date.now() - Number(prevInfo.checkedAt) < UPDATE_CHECK_INTERVAL_MS
    ) {
      refreshBadgeFromStorage();
      return prevInfo;
    }

    const resp = await fetch(GITHUB_LATEST_RELEASE_API, {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store'
    });

    if (resp.status === 404) {
      const info = {
        checkedAt: Date.now(),
        latestVersion: currentVer,
        hasUpdate: false,
        releaseUrl: GITHUB_RELEASES_PAGE_URL,
        dismissedVersion: prevInfo.dismissedVersion || ''
      };
      await chrome.storage.local.set({ [STORAGE_KEY_UPDATE_INFO]: info });
      refreshBadgeFromStorage();
      return info;
    }

    if (!resp.ok) {
      return prevInfo;
    }

    const data = await resp.json();
    const rawTag = String(data?.tag_name || data?.name || '').trim();
    const cleanLatest = rawTag.replace(/^[vV]+/, '');
    const hasUpdate = isNewerVersion(cleanLatest, currentVer);
    const releaseUrl =
      typeof data?.html_url === 'string' && data.html_url.startsWith('https://github.com/')
        ? data.html_url
        : GITHUB_RELEASES_PAGE_URL;

    const info = {
      checkedAt: Date.now(),
      latestVersion: cleanLatest || currentVer,
      hasUpdate,
      releaseUrl,
      releaseName: String(data?.name || rawTag || '').trim(),
      dismissedVersion: prevInfo.dismissedVersion || ''
    };
    await chrome.storage.local.set({ [STORAGE_KEY_UPDATE_INFO]: info });
    refreshBadgeFromStorage();
    return info;
  } catch (_) {
    refreshBadgeFromStorage();
    return null;
  }
}

refreshBadgeFromStorage();
checkForGithubReleaseUpdate(false);

chrome.runtime.onInstalled.addListener(() => {
  checkForGithubReleaseUpdate(true);
});

chrome.runtime.onStartup.addListener(() => {
  checkForGithubReleaseUpdate(false);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === 'local' &&
    (changes[STORAGE_KEY_UNREAD_COUNT] ||
      changes[STORAGE_KEY_IG_UNREAD_COUNT] ||
      changes[STORAGE_KEY_UPDATE_INFO])
  ) {
    refreshBadgeFromStorage();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (['HISTORY_READ', 'HISTORY_IMAGES', 'HISTORY_WRITE', 'HISTORY_DELETE'].includes(message.type)) {
    const isPopup = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html');
    const isPage = sender.id === chrome.runtime.id && /^https?:\/\/([a-z0-9-]+\.)*(facebook|messenger|instagram)\.com\//i.test(sender.url || '');
    if ((!isPopup && !isPage) || ((message.type === 'HISTORY_DELETE' || message.restore) && !isPopup)) {
      sendResponse({ ok: false, error: 'History operation is not allowed' });
      return;
    }
    HistoryRepository.run(message).then(
      (result) => sendResponse({ ok: true, ...result }),
      (error) => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }

  if (message.type === 'CACHE_MESSAGE_IMAGE') {
    downloadImageForCache(message.url, sender.url || '').then(
      (dataUrl) => sendResponse({ ok: true, dataUrl }),
      (error) => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }

  if (message.type === 'INCREMENT_UNREAD_BADGE') {
    const key =
      message.platform === 'instagram'
        ? STORAGE_KEY_IG_UNREAD_COUNT
        : STORAGE_KEY_UNREAD_COUNT;
    chrome.storage.local.get([key], (res) => {
      const nextCount = (Number(res[key]) || 0) + 1;
      chrome.storage.local.set({ [key]: nextCount }, () => {
        refreshBadgeFromStorage();
        sendResponse({ ok: true, count: nextCount });
      });
    });
    return true;
  }

  if (message.type === 'CLEAR_UNREAD_BADGE') {
    const patch = {};
    if (message.platform === 'instagram') {
      patch[STORAGE_KEY_IG_UNREAD_COUNT] = 0;
    } else if (message.platform === 'facebook') {
      patch[STORAGE_KEY_UNREAD_COUNT] = 0;
    } else {
      patch[STORAGE_KEY_UNREAD_COUNT] = 0;
      patch[STORAGE_KEY_IG_UNREAD_COUNT] = 0;
    }
    chrome.storage.local.set(patch, () => {
      refreshBadgeFromStorage();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === 'CHECK_GITHUB_RELEASE_UPDATE') {
    checkForGithubReleaseUpdate(Boolean(message.force)).then((info) => {
      sendResponse({ ok: true, info });
    });
    return true;
  }
});
