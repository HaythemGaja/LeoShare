// Popup: shows your persistent device code and opens the transfer tab.
function makeId() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return 'leo-' + s;
}

async function getMyId() {
  const data = await chrome.storage.local.get('leoShareId');
  if (data.leoShareId) return data.leoShareId;
  const id = makeId();
  await chrome.storage.local.set({ leoShareId: id });
  return id;
}

document.addEventListener('DOMContentLoaded', async () => {
  const myId = await getMyId();
  document.getElementById('myCode').textContent = myId;
  const data = await chrome.storage.local.get(['leoShareContacts', 'leoShareOutboxCount', 'leoShareMissed']);
  const contacts = Array.isArray(data.leoShareContacts) ? data.leoShareContacts.filter((c) => c.trusted).length : 0;
  const queued = data.leoShareOutboxCount || 0;
  const missed = Array.isArray(data.leoShareMissed) ? data.leoShareMissed.length : 0;
  const bits = [];
  if (contacts) bits.push(contacts + ' trusted contact' + (contacts === 1 ? '' : 's'));
  if (queued) bits.push(queued + ' file' + (queued === 1 ? '' : 's') + ' queued');
  if (missed) bits.push(missed + ' missed');
  document.getElementById('counts').textContent = bits.join(' · ');

  document.getElementById('copyBtn').addEventListener('click', async () => {
    await navigator.clipboard.writeText(myId);
    document.getElementById('status').textContent = 'Code copied ✓';
    setTimeout(() => { document.getElementById('status').textContent = ''; }, 2000);
  });

  document.getElementById('openBtn').addEventListener('click', async () => {
    const url = chrome.runtime.getURL('transfer.html');
    const tabs = await chrome.tabs.query({ url });
    if (tabs.length) {
      await chrome.tabs.update(tabs[0].id, { active: true });
    } else {
      await chrome.tabs.create({ url });
    }
    window.close();
  });
});
