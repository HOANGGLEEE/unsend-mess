/* Shared history merge rules. Images are resolved by history-client.js. */
globalThis.HistoryModel = (() => {
  const keys = ['fb_captured_messages_v2', 'fb_unsent_messages_v2', 'ig_captured_messages_v2', 'ig_unsent_messages_v2'];
  const isImageRef = (value) => typeof value === 'string' && /^idb-image:[a-f0-9]{64}$/.test(value);
  function mergeRecord(previous, incoming) {
    const newer = Number(incoming.updatedAt || incoming.unsentAt || incoming.timestamp || 0) >=
      Number(previous.updatedAt || previous.unsentAt || previous.timestamp || 0);
    const result = newer ? { ...previous, ...incoming } : { ...incoming, ...previous };
    for (const field of ['text', 'senderName', 'personName', 'threadName', 'senderId', 'threadId', 'avatarUrl']) {
      result[field] = result[field] || previous[field] || incoming[field] || '';
    }
    result.attachments = [...new Set([...(previous.attachments || []), ...(incoming.attachments || [])])];
    result.imageSources = { ...previous.imageSources, ...incoming.imageSources };
    result.attachments = result.attachments.filter((url) => !result.imageSources[url] || !result.attachments.includes(result.imageSources[url]));
    result.isUnsent = Boolean(previous.isUnsent || incoming.isUnsent);
    const timestamps = [previous.timestamp, incoming.timestamp].filter((value) => Number(value) > 0);
    if (timestamps.length) result.timestamp = Math.min(...timestamps);
    return result;
  }
  function merge(records, incoming, deletedIds = []) {
    const deleted = new Set(deletedIds);
    const byId = new Map();
    for (const record of [...records, ...incoming]) {
      if (!record || !['string', 'number'].includes(typeof record.messageId) || !String(record.messageId) || deleted.has(String(record.messageId))) continue;
      const { rowEl, chatContainer, ...clean } = record;
      clean.messageId = String(clean.messageId);
      clean.attachments = Array.isArray(clean.attachments) ? clean.attachments.filter((url) => typeof url === 'string') : [];
      byId.set(clean.messageId, byId.has(clean.messageId) ? mergeRecord(byId.get(clean.messageId), clean) : clean);
    }
    return [...byId.values()];
  }
  return { keys, isImageRef, merge };
})();
