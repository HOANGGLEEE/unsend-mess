const test = require('node:test');
const assert = require('node:assert');

// Logic to extract & normalize Instagram items
function normalizeInstagramItem(item, threadId, usersById = {}) {
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
    if (item.voice_media.media.audio.audio_src) {
      attachments.push(item.voice_media.media.audio.audio_src);
    }
  } else if (item.item_type === 'animated_media' && item.animated_media?.images?.fixed_height?.url) {
    mediaType = 'image';
    attachments.push(item.animated_media.images.fixed_height.url);
  } else if (item.item_type === 'like') {
    text = '👍';
  } else if (item.text) {
    text = item.text;
  }

  const senderId = String(item.user_id || '');
  const senderInfo = usersById[senderId] || {};

  return {
    platform: 'instagram',
    messageId: String(item.item_id),
    threadId: String(threadId || item.thread_id || ''),
    senderId,
    senderName: senderInfo.full_name || senderInfo.username || senderId,
    senderAvatar: senderInfo.profile_pic_url || '',
    text,
    attachments,
    mediaType,
    timestamp: item.timestamp ? Math.floor(Number(item.timestamp) / 1000) : Date.now(),
    source: 'IG_DIRECT_API'
  };
}

function parseInstagramUnsendPacket(packetStr) {
  if (typeof packetStr !== 'string') return null;
  if (!packetStr.includes('item_removed') && !packetStr.includes('item_remove')) return null;
  
  try {
    const data = JSON.parse(packetStr);
    const itemId = data.item_id || data.payload?.item_id || data.data?.item_id;
    const threadId = data.thread_id || data.payload?.thread_id || data.data?.thread_id;
    if (itemId) {
      return { messageId: String(itemId), threadId: String(threadId || '') };
    }
  } catch (_) {
    // Regex fallback for non-JSON or partial MQTT string
    const match = packetStr.match(/"item_id"\s*:\s*"?(\d+)"?/);
    if (match) {
      return { messageId: match[1] };
    }
  }
  return null;
}

test('normalizeInstagramItem handles text message with user info', () => {
  const users = { '999': { username: 'testuser', full_name: 'Test User', profile_pic_url: 'https://pic.jpg' } };
  const item = { item_id: '12345', item_type: 'text', text: 'Xin chào PO!', user_id: '999', timestamp: '1700000000000000' };
  const res = normalizeInstagramItem(item, 'thread_1', users);
  assert.strictEqual(res.messageId, '12345');
  assert.strictEqual(res.text, 'Xin chào PO!');
  assert.strictEqual(res.platform, 'instagram');
  assert.strictEqual(res.senderName, 'Test User');
  assert.strictEqual(res.senderAvatar, 'https://pic.jpg');
});

test('normalizeInstagramItem handles voice media', () => {
  const item = {
    item_id: 'voice_1',
    item_type: 'voice_media',
    user_id: '888',
    voice_media: { media: { audio: { audio_src: 'https://cdn.instagram.com/voice.mp4' } } }
  };
  const res = normalizeInstagramItem(item, 'thread_2');
  assert.strictEqual(res.mediaType, 'audio');
  assert.strictEqual(res.attachments[0], 'https://cdn.instagram.com/voice.mp4');
});

test('parseInstagramUnsendPacket detects unsend from JSON or string', () => {
  const jsonPacket = JSON.stringify({ action_type: 'item_removed', item_id: '3402823668417', thread_id: 'th_1' });
  const parsed = parseInstagramUnsendPacket(jsonPacket);
  assert.ok(parsed);
  assert.strictEqual(parsed.messageId, '3402823668417');

  const rawMqtt = 'some_mqtt_header{"action":"item_removed","item_id":"998877"}trailing';
  const parsedRaw = parseInstagramUnsendPacket(rawMqtt);
  assert.ok(parsedRaw);
  assert.strictEqual(parsedRaw.messageId, '998877');
});

