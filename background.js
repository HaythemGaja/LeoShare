// LeoShare background service worker (v1.2).
// - Opens / focuses the transfer tab.
// - Opens it when a LeoShare notification is clicked.
// - Right-click "Send with LeoShare" menus (v1.2 feature 5): the worker
//   cannot do WebRTC itself, so a click stores a pending clipboard send
//   in chrome.storage.local and opens the transfer tab, which picks it
//   up, sends it to the chosen device, or queues it if that device is
//   offline. No file bytes pass through here — only text / a link URL.

chrome.action.onClicked.addListener(() => openTransferTab());

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'open-transfer') openTransferTab();
});

chrome.notifications.onClicked.addListener(() => {
  openTransferTab();
});

async function openTransferTab() {
  const url = chrome.runtime.getURL('transfer.html');
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

// ---------- Context menus ----------
async function rebuildMenus() {
  try {
    await chrome.contextMenus.removeAll();
    const data = await chrome.storage.local.get('leoShareContacts');
    const contacts = (Array.isArray(data.leoShareContacts) ? data.leoShareContacts : [])
      .filter((c) => c.trusted);
    chrome.contextMenus.create({
      id: 'leoshare-root',
      title: 'Send with LeoShare',
      contexts: ['selection', 'link', 'image', 'page']
    });
    chrome.contextMenus.create({ id: 'to:connected', parentId: 'leoshare-root', title: 'Send to connected device' });
    for (const c of contacts.slice(0, 10)) {
      chrome.contextMenus.create({
        id: 'to:' + c.code,
        parentId: 'leoshare-root',
        title: 'Send to ' + (c.name || c.code)
      });
    }
    chrome.contextMenus.create({ id: 'to:pick', parentId: 'leoshare-root', title: 'Choose device in LeoShare…' });
  } catch (e) { /* menus are best-effort */ }
}

chrome.runtime.onInstalled.addListener(rebuildMenus);
chrome.runtime.onStartup.addListener(rebuildMenus);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.leoShareContacts) rebuildMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!info.menuItemId || !String(info.menuItemId).startsWith('to:')) return;
  const target = String(info.menuItemId).slice(3); // 'connected' | 'pick' | leo-xxxxxx
  let pending = null;
  if (info.selectionText) {
    pending = { kind: 'text', text: info.selectionText, at: Date.now() };
  } else if (info.linkUrl) {
    pending = { kind: 'link', text: info.linkUrl, url: info.linkUrl, at: Date.now() };
  } else if (info.srcUrl) {
    pending = { kind: 'image', text: info.srcUrl, url: info.srcUrl, at: Date.now() };
  } else if (info.pageUrl) {
    pending = { kind: 'link', text: info.pageUrl, url: info.pageUrl, at: Date.now() };
  }
  if (!pending) return;
  pending.target = target;
  await chrome.storage.local.set({ leoSharePendingSend: pending });
  await openTransferTab();
});
