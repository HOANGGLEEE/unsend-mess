const test = require('node:test');
const assert = require('node:assert');

// Deep scanner that traverses any Instagram payload (REST, GraphQL, WebSocket)
function deepScanForInstagramMessages(obj, capturedList = [], unsendList = []) {
  if (!obj || typeof obj !== 'object') return { capturedList, unsendList };

  // Check if current object is an unsend event
  if (
    obj.action_type === 'item_removed' ||
    obj.action === 'item_removed' ||
    obj.event === 'item_removed' ||
    obj.status === 'item_removed' ||
    (typeof obj.item_type === 'string' && obj.item_type === 'placeholder' && /unsent/i.test(obj.text || ''))
  ) {
    const itemId = String(obj.item_id || obj.payload?.item_id || '');
    if (itemId) {
      unsendList.push({ messageId: itemId, threadId: String(obj.thread_id || '') });
    }
  }

  // Check if current object is an Instagram message item
  if (obj.item_id && (obj.text !== undefined || obj.item_type || obj.media || obj.visual_media || obj.voice_media)) {
    let text = '';
    const attachments = [];
    let mediaType = 'none';

    if (obj.item_type === 'text' || (typeof obj.text === 'string' && !obj.item_type)) {
      text = obj.text || '';
    } else if (obj.item_type === 'media' && obj.media) {
      mediaType = obj.media.media_type === 2 ? 'video' : 'image';
      if (obj.media.image_versions2?.candidates?.[0]?.url) {
        attachments.push(obj.media.image_versions2.candidates[0].url);
      }
      if (obj.media.video_versions?.[0]?.url) {
        attachments.push(obj.media.video_versions[0].url);
      }
    } else if (obj.item_type === 'raven_media' && obj.visual_media) {
      mediaType = 'view_once';
      text = '① Ảnh (Xem 1 lần)';
      const cand = obj.visual_media.media?.image_versions2?.candidates?.[0]?.url;
      if (cand) attachments.push(cand);
    } else if (obj.item_type === 'voice_media' && obj.voice_media?.media?.audio) {
      mediaType = 'audio';
      text = '🎵 Tin nhắn thoại';
      if (obj.voice_media.media.audio.audio_src) {
        attachments.push(obj.voice_media.media.audio.audio_src);
      }
    } else if (obj.text) {
      text = obj.text;
    }

    capturedList.push({
      platform: 'instagram',
      messageId: String(obj.item_id),
      senderId: String(obj.user_id || ''),
      text,
      attachments,
      mediaType,
      timestamp: obj.timestamp ? Math.floor(Number(obj.timestamp) / 1000) : Date.now()
    });
  }

  // Traverse children
  if (Array.isArray(obj)) {
    for (const item of obj) {
      deepScanForInstagramMessages(item, capturedList, unsendList);
    }
  } else {
    for (const key of Object.keys(obj)) {
      if (key !== 'users' && typeof obj[key] === 'object') {
        deepScanForInstagramMessages(obj[key], capturedList, unsendList);
      }
    }
  }

  return { capturedList, unsendList };
}

test('deepScanForInstagramMessages finds nested messages in GraphQL responses', () => {
  const graphqlResponse = {
    data: {
      fetch__XDTDirectThread: {
        thread: {
          thread_id: 'th_graphql_1',
          items: [
            { item_id: 'msg_g1', item_type: 'text', text: 'Tin qua GraphQL', user_id: '123' },
            { item_id: 'msg_g2', item_type: 'media', media: { media_type: 1, image_versions2: { candidates: [{ url: 'https://cdn.jpg' }] } } }
          ]
        }
      }
    }
  };

  const { capturedList } = deepScanForInstagramMessages(graphqlResponse);
  assert.strictEqual(capturedList.length, 2);
  assert.strictEqual(capturedList[0].messageId, 'msg_g1');
  assert.strictEqual(capturedList[0].text, 'Tin qua GraphQL');
  assert.strictEqual(capturedList[1].messageId, 'msg_g2');
  assert.strictEqual(capturedList[1].attachments[0], 'https://cdn.jpg');
});

test('deepScanForInstagramMessages handles prefix for (;;); stripping', () => {
  const rawWithPrefix = 'for (;;);{"data":{"message":{"item_id":"msg_p1","text":"Prefix test"}}}';
  const clean = rawWithPrefix.replace(/^for\s*\(\s*;\s*;\s*\);/, '').trim();
  const json = JSON.parse(clean);
  const { capturedList } = deepScanForInstagramMessages(json);
  assert.strictEqual(capturedList.length, 1);
  assert.strictEqual(capturedList[0].messageId, 'msg_p1');
  assert.strictEqual(capturedList[0].text, 'Prefix test');
});

