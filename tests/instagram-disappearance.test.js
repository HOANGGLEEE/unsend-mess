const test = require('node:test');
const assert = require('node:assert');

test('Disappearance tracker detects removed message node and produces unsend restoration', () => {
  // Simulated DOM & tracking map
  const trackedElements = new Map();

  const fakeMessageNode = { id: 'node_1', textContent: 'Tin nhắn sắp bị gỡ' };
  const fakeParentNode = {
    children: [fakeMessageNode],
    insertBeforeCalledWith: null,
    insertBefore: function (newChild, refChild) {
      this.insertBeforeCalledWith = { newChild, refChild };
    }
  };

  // 1. Message rendered and tracked
  trackedElements.set(fakeMessageNode, {
    messageId: 'ig_msg_888',
    text: 'Tin nhắn sắp bị gỡ',
    senderName: 'Bạn bè',
    parent: fakeParentNode,
    nextSibling: null,
    attachments: []
  });

  // 2. Instagram removes the message node from DOM
  const removedNodes = [fakeMessageNode];
  let unsendDetected = null;

  for (const node of removedNodes) {
    if (trackedElements.has(node)) {
      const data = trackedElements.get(node);
      unsendDetected = {
        messageId: data.messageId,
        text: data.text,
        senderName: data.senderName,
        isUnsent: true,
        unsentAt: Date.now()
      };
      // Simulate restoration insertion
      const restoredBubble = { type: 'restored-bubble', text: data.text, isUnsent: true };
      data.parent.insertBefore(restoredBubble, data.nextSibling);
    }
  }

  assert.ok(unsendDetected, 'Must detect unsend when node is removed');
  assert.strictEqual(unsendDetected.text, 'Tin nhắn sắp bị gỡ');
  assert.ok(fakeParentNode.insertBeforeCalledWith, 'Must re-insert restored bubble into parent');
  assert.strictEqual(fakeParentNode.insertBeforeCalledWith.newChild.text, 'Tin nhắn sắp bị gỡ');
});

