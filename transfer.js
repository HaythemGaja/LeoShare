// LeoShare transfer page v1.2 — PeerJS (WebRTC DataChannel) file transfer.
// Protocol over one DataConnection (per peer; multiple peers at once):
//   {type:'hello', from, displayName}
//   {type:'folder-meta', folder, count, files:[{name,path,size}]}
//   {type:'file-meta', id, name, size, mime, path, folder, sha256, preview}
//   {type:'file-accept', id, resumeFrom} / {type:'file-decline', id}
//   {type:'file-cancel', id}
//   raw ArrayBuffer chunks (16 KB) in order, then {type:'file-end', id}
//   {type:'text', text} / {type:'clipboard', text, from, displayName, at}
//   {type:'missed-notice', from, displayName, items:[{name,size,queuedAt}]}
// Signalling only goes through PeerJS cloud. File bytes travel directly
// browser <-> browser over DTLS-encrypted WebRTC.
//
// v1.2: (1) folder send with paths + ZIP download, (2) pause/resume/
// cancel + SHA-256 verification, (3) multi-send to several contacts in turn, (4) cross-device clipboard, (5) right-click Send
// with LeoShare (via background pending send), (6) transfer history,
// (7) QR show/scan pairing, (8) preview before accepting.

const CHUNK = 16384;
const $ = (id) => document.getElementById(id);
const logEl = $('log'), sendList = $('sendList'), recvList = $('recvList');

let peer = null, conn = null, myId = null, myDisplayName = '';
const conns = new Map();       // code -> DataConnection (multi-peer)
let sendQueue = [];
let sending = false;
let incoming = new Map();      // fileId -> rec
let partials = new Map();      // fileId -> {meta, chunks, received} (resume)
let contacts = [];
let missed = [];
let history = [];
let clipHistory = [];
let lastConnectAttempt = null;
let connectionOpenedAt = 0;
let flushingFor = null;
const connectingPeers = new Set(); // codes with a connect attempt in flight
const lastConnectAttemptAt = {};   // code -> timestamp, connect cooldown
const flushRetryTimers = new Set();
const flushRetryCount = {};        // code -> retries used (cap ~60 s)
const iceStateByPeer = {};         // code -> last ICE connection state
const iceCandidatesByPeer = {};    // code -> {host, srflx, relay}
function isUsable(code) { const c = getConn(code); return !!(c && c.open); }
// Wait for a peer's data channel to actually open (up to ms). Returns true
// if it opened, false on timeout / close. This is the v1.2.1 fix: v1.2
// treated "connect() called" as connected, but PeerJS .open is false
// until the DataChannel opens, so files were queued as "offline" while
// the UI said Connected.
async function waitForOpen(code, ms) {
  const deadline = Date.now() + (ms || WAIT_OPEN_MS);
  while (Date.now() < deadline) {
    if (isUsable(code)) return true;
    if (!conns.has(code) && !connectingPeers.has(code)) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
  return isUsable(code);
}
let multiSendTargets = [];     // codes, in order, for feature 3
let multiSendTimer = null;
let pendingClipboard = null;   // {text, target} waiting for a connection
let pendingResendTarget = null;
let folderGroups = new Map();  // folder name -> {count, files:Map path->rec}
let receivedBlobs = new Map(); // fileId -> {url, name, mime}
let scanStream = null, scanTimer = null;

// ---------- Helpers ----------
// v1.4: suppress identical log lines repeated within 10 s — the v1.3
// field log was full of "Already connecting…" / "Waiting for the data
// channel…" repeated every few seconds, which hid the real signal.
const lastLogAt = {};
function log(msg, cls) {
  const now = Date.now();
  if (lastLogAt[msg] && now - lastLogAt[msg] < 10000) return;
  lastLogAt[msg] = now;
  const t = new Date().toLocaleTimeString();
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = `[${t}] ${msg}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}
// How long to wait for a data channel to open before treating the peer
// as offline. v1.3 used 8 s; TURN relay gathering can take longer.
const WAIT_OPEN_MS = 20000;
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}
function fmtSpeed(bps) { return fmtBytes(bps) + '/s'; }
function fmtTime(ts) { try { return new Date(ts).toLocaleString(); } catch (e) { return String(ts); } }
function makeId() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return 'leo-' + s;
}
function normaliseCode(raw) {
  let c = (raw || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!c) return '';
  if (!c.startsWith('leo-')) c = 'leo-' + c;
  return c;
}
async function getMyId() {
  const data = await chrome.storage.local.get('leoShareId');
  if (data.leoShareId) return data.leoShareId;
  const id = makeId();
  await chrome.storage.local.set({ leoShareId: id });
  return id;
}
function setStatus(text, on) {
  $('statusText').textContent = text;
  $('dot').className = 'status-dot' + (on === true ? ' on' : on === false ? ' off' : '');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function clearEmpty(list) { const e = list.querySelector('.empty'); if (e) e.remove(); }
function notify(title, message) {
  try {
    if (chrome && chrome.notifications && chrome.notifications.create) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'LeoShare — ' + title,
        message: String(message || '').slice(0, 200),
        priority: 1
      });
      return;
    }
  } catch (e) {}
  log('NOTIFY: ' + title + ' — ' + message);
}
function contactName(code) {
  const c = contacts.find((x) => x.code === code);
  return c ? (c.name || code) : code;
}
function getConn(code) { return conns.get(normaliseCode(code)); }
function sendTo(code, msg) {
  const c = getConn(code);
  if (c && c.open) { c.send(msg); return true; }
  return false;
}
async function sha256Hex(blob) {
  try {
    const buf = await blob.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (e) { return ''; }
}

// Preview before accepting (feature 8): a small thumbnail / text snippet
// made by the SENDER and sent inside file-meta, so the receiver can see
// what it is before tapping Accept. No file bytes are sent yet.
async function makePreview(file) {
  try {
    if (file.type && file.type.startsWith('image/')) {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 320 / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      return { kind: 'image', data: canvas.toDataURL('image/jpeg', 0.65) };
    }
    if (file.type && file.type.startsWith('video/')) {
      const url = URL.createObjectURL(file);
      try {
        const thumb = await new Promise((resolve) => {
          const v = document.createElement('video');
          v.muted = true; v.preload = 'metadata'; v.src = url;
          const done = (ok) => { try { URL.revokeObjectURL(url); } catch (e) {} resolve(ok); };
          const to = setTimeout(() => done(null), 3000);
          v.onloadeddata = () => { try { v.currentTime = Math.min(0.5, (v.duration || 1) / 3); } catch (e) { clearTimeout(to); done(null); } };
          v.onseeked = () => {
            clearTimeout(to);
            try {
              const canvas = document.createElement('canvas');
              const scale = Math.min(1, 320 / Math.max(v.videoWidth, 1));
              canvas.width = Math.max(1, Math.round(v.videoWidth * scale));
              canvas.height = Math.max(1, Math.round(v.videoHeight * scale));
              canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
              done({ kind: 'image', data: canvas.toDataURL('image/jpeg', 0.65) });
            } catch (e) { done(null); }
          };
          v.onerror = () => { clearTimeout(to); done(null); };
        });
        return thumb;
      } catch (e) { try { URL.revokeObjectURL(url); } catch (err) {} return null; }
    }
    if (file.type && (file.type.startsWith('text/') || file.type === 'application/json' || file.name.match(/\.(txt|md|csv|json|log)$/i))) {
      const text = await file.slice(0, 1500).text();
      return { kind: 'text', data: text };
    }
  } catch (e) {}
  return null;
}
function previewHtml(preview) {
  if (!preview) return '';
  if (preview.kind === 'image' && preview.data) return `<div class="preview"><img src="${preview.data}" alt="preview"></div>`;
  if (preview.kind === 'text' && preview.data) return `<div class="preview"><pre>${escapeHtml(preview.data)}</pre></div>`;
  return '';
}

// Folder traversal (feature 1): DataTransferItem -> files with relative paths.
async function filesFromDataTransfer(dt) {
  const out = [];
  const items = [...dt.items].filter((i) => i.kind === 'file');
  let usedEntry = false;
  for (const item of items) {
    const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
    if (entry) { usedEntry = true; await walkEntry(entry, '', out); }
  }
  if (!usedEntry) return [...dt.files].map((f) => ({ file: f, path: f.name, folder: '' }));
  return out;
}
async function walkEntry(entry, base, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    const path = (base ? base + '/' : '') + entry.name;
    const folder = base ? base.split('/')[0] : '';
    out.push({ file, path, folder });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let entries = [];
    let batch;
    do { batch = await new Promise((res, rej) => reader.readEntries(res, rej)); entries = entries.concat(batch); } while (batch.length);
    for (const child of entries) await walkEntry(child, (base ? base + '/' : '') + entry.name, out);
  }
}
async function filesFromFolderInput(input) {
  return [...input.files].map((f) => ({
    file: f, path: f.webkitRelativePath || f.name,
    folder: (f.webkitRelativePath || '').split('/')[0] || ''
  }));
}

// ---------- Contacts ----------
// v1.3: contacts are simple. Add a device once and it IS a contact —
// there is no separate "trusted" step, no Trust/Untrust, and no
// per-contact auto-accept toggle. Files from any contact auto-accept.
let selectedContact = null; // code of the contact you are chatting/sending to
async function loadContacts() {
  const data = await chrome.storage.local.get(['leoShareContacts', 'leoShareDisplayName', 'leoShareAutoAccept']);
  contacts = Array.isArray(data.leoShareContacts) ? data.leoShareContacts : [];
  // Migrate old contacts: drop the trusted flag, they are all trusted now.
  let migrated = false;
  for (const c of contacts) {
    if ('trusted' in c) { delete c.trusted; migrated = true; }
    if (!c.autoAccept) { c.autoAccept = true; migrated = true; }
  }
  myDisplayName = data.leoShareDisplayName || '';
  if (myDisplayName) $('displayName').value = myDisplayName;
  if (data.leoShareAutoAccept) $('autoAccept').checked = true;
  if (migrated) await chrome.storage.local.set({ leoShareContacts: contacts });
  renderContacts();
}
async function saveContacts() {
  await chrome.storage.local.set({ leoShareContacts: contacts });
  renderContacts();
}
function getContact(code) { return contacts.find((x) => x.code === normaliseCode(code)); }
async function upsertContact(code, patch) {
  code = normaliseCode(code);
  if (!code || code === myId) return null;
  let c = contacts.find((x) => x.code === code);
  if (!c) { c = { code, name: code, autoAccept: true, addedAt: Date.now(), lastSeen: 0 }; contacts.push(c); }
  Object.assign(c, patch || {});
  await saveContacts();
  return c;
}
async function removeContact(code) {
  contacts = contacts.filter((x) => x.code !== normaliseCode(code));
  await saveContacts();
  log('Removed contact ' + code);
}
function renderContacts() {
  const list = $('contactList');
  const sel = $('sendToSelect');
  sel.querySelectorAll('option[data-contact]').forEach((o) => o.remove());
  const multi = $('multiSendList');
  multi.innerHTML = '';
  const sorted = [...contacts].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  if (!sorted.length) {
    list.innerHTML = '<p class="empty">No contacts yet. Connect to a device once, or add one above.</p>';
    multi.innerHTML = '<span style="font-size:12px;color:#64748b">No contacts yet.</span>';
    return;
  }
  list.innerHTML = '';
  for (const c of sorted) {
    const opt = document.createElement('option');
    opt.value = c.code; opt.setAttribute('data-contact', '1');
    opt.textContent = (c.name || c.code) + ' (' + c.code + ')';
    sel.appendChild(opt);
    const lab = document.createElement('label');
    lab.innerHTML = `<input type="checkbox" value="${escapeHtml(c.code)}"> ${escapeHtml(c.name || c.code)}`;
    multi.appendChild(lab);
    const row = document.createElement('div');
    row.className = 'contact-row' + (selectedContact === c.code ? ' selected' : '');
    const online = isUsable(c.code);
    const lastSeen = online ? '● Online now' : (c.lastSeen ? 'Last seen ' + fmtTime(c.lastSeen) : 'Never connected yet');
    row.innerHTML = `<div class="top"><span><span class="name">${escapeHtml(c.name || c.code)}</span><br><span class="code">${escapeHtml(c.code)}</span></span></div>
      <div class="row-meta">${escapeHtml(lastSeen)}</div>
      <div class="row-actions"></div>`;
    // Tap the row itself to select this contact and start chatting/sending.
    row.addEventListener('click', () => selectContact(c.code));
    const actions = row.querySelector('.row-actions');
    const mk = (label, cls, fn) => {
      const b = document.createElement('button');
      b.className = 'small ' + (cls || 'ghost'); b.textContent = label;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); actions.appendChild(b); return b;
    };
    mk('Chat', '', () => selectContact(c.code, 'chat'));
    mk('Send file', '', () => selectContact(c.code, 'file'));
    mk('Rename', 'ghost', async () => {
      const name = prompt('Name for ' + c.code + ':', c.name || '');
      if (name && name.trim()) await upsertContact(c.code, { name: name.trim() });
    });
    mk('Remove', 'danger', async () => {
      if (confirm('Remove ' + (c.name || c.code) + ' from contacts?')) {
        if (selectedContact === c.code) { selectedContact = null; updateActiveBar(); }
        await removeContact(c.code);
      }
    });
    list.appendChild(row);
  }
  // Keep the Send-to select on the selected contact after a re-render.
  if (selectedContact) sel.value = selectedContact;
  updateActiveBar();
}

// Select a contact: they become the recipient for files, clipboard and
// chat, and LeoShare connects to them (once — v1.2.1's connect guard).
function selectContact(code, action) {
  code = normaliseCode(code);
  if (!code) return;
  selectedContact = code;
  $('sendToSelect').value = code;
  $('peerInput').value = code;
  renderContacts();
  if (!isUsable(code)) connectTo(code);
  else log('Selected ' + contactName(code) + ' — ready to chat and send.');
  if (action === 'chat') {
    $('msgInput').focus();
    $('msgInput').scrollIntoView({ block: 'center' });
  } else if (action === 'file') {
    $('fileInput').click();
  } else if (action === 'clip') {
    $('clipText').focus();
    $('clipText').scrollIntoView({ block: 'center' });
  }
}
function updateActiveBar() {
  const bar = $('activeBar');
  const hint = $('activeHint');
  const chatHint = $('chatHint');
  if (!selectedContact) {
    if (bar) bar.style.display = 'none';
    if (hint) hint.textContent = 'No contact selected yet — tap a contact above.';
    if (chatHint) chatHint.textContent = 'Pick a contact above first, then type here.';
    return;
  }
  const name = contactName(selectedContact);
  if (bar) {
    bar.style.display = 'flex';
    const t = $('activeBarText');
    // Show the ICE state here instead of repeating "connecting…" —
    // that is new information, not a repeat of the status line.
    if (t) t.innerHTML = 'Chatting with <b>' + escapeHtml(name) + '</b>' + (isUsable(selectedContact) ? ' ● connected' : ' — ICE: ' + (iceStateByPeer[selectedContact] || 'checking…'));
  }
  if (hint) hint.textContent = 'Sending to ' + name + '.';
  if (chatHint) chatHint.textContent = 'Messages go to ' + name + '.';
}

// ---------- Missed list ----------
async function loadMissed() {
  const data = await chrome.storage.local.get('leoShareMissed');
  missed = Array.isArray(data.leoShareMissed) ? data.leoShareMissed : [];
  renderMissed();
}
async function saveMissed() {
  await chrome.storage.local.set({ leoShareMissed: missed.slice(0, 50) });
  renderMissed();
}
function renderMissed() {
  const list = $('missedList');
  if (!missed.length) { list.innerHTML = '<p class="empty">No missed transfers.</p>'; return; }
  list.innerHTML = '';
  for (const m of [...missed].reverse()) {
    const row = document.createElement('div');
    row.className = 'missed-row';
    row.innerHTML = `<div class="top"><span><b>${escapeHtml(m.name)}</b> · ${fmtBytes(m.size)}</span><span class="badge queued">Missed</span></div>
      <div class="row-meta">From ${escapeHtml(m.fromName || m.from)} · tried ${fmtTime(m.at)} while this browser was offline / closed. The file itself is still on their device — it will arrive when you connect to them.</div>`;
    list.appendChild(row);
  }
}

// ---------- Transfer history (feature 6) ----------
async function loadHistory() {
  const data = await chrome.storage.local.get(['leoShareHistory', 'leoShareClipboard']);
  history = Array.isArray(data.leoShareHistory) ? data.leoShareHistory : [];
  clipHistory = Array.isArray(data.leoShareClipboard) ? data.leoShareClipboard : [];
  renderHistory();
  renderClipboard();
}
async function addHistory(entry) {
  history.unshift({ id: 'h-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), at: Date.now(), ...entry });
  history = history.slice(0, 200);
  await chrome.storage.local.set({ leoShareHistory: history });
  renderHistory();
}
function renderHistory() {
  const list = $('historyList');
  const q = ($('historySearch').value || '').toLowerCase();
  const f = $('historyFilter').value || 'all';
  const rows = history.filter((h) => (f === 'all' || h.direction === f) && (!q || (h.name + ' ' + (h.peerName || h.peer || '')).toLowerCase().includes(q)));
  if (!rows.length) { list.innerHTML = '<p class="empty">No transfers yet.</p>'; return; }
  list.innerHTML = '';
  for (const h of rows.slice(0, 60)) {
    const row = document.createElement('div');
    row.className = 'hist-row';
    const dir = h.direction === 'sent' ? '📤 Sent' : '📥 Received';
    const who = h.direction === 'sent' ? 'to ' + (h.peerName || h.peer) : 'from ' + (h.peerName || h.peer);
    const ver = h.shaVerified === true ? ' · ✓ verified' : h.shaVerified === false ? ' · ⚠ checksum mismatch' : '';
    row.innerHTML = `<div class="top"><span><b>${escapeHtml(h.name)}</b> · ${fmtBytes(h.size || 0)}</span><span class="badge ${h.status === 'complete' ? '' : 'offline'}">${escapeHtml(h.status || '')}</span></div>
      <div class="row-meta">${dir} ${escapeHtml(who)} · ${fmtTime(h.at)}${h.path && h.path !== h.name ? ' · ' + escapeHtml(h.path) : ''}${ver}</div>
      <div class="row-actions"></div>`;
    const actions = row.querySelector('.row-actions');
    if (h.direction === 'sent') {
      const b = document.createElement('button');
      b.className = 'small ghost'; b.textContent = 'Send again…';
      b.addEventListener('click', () => {
        pendingResendTarget = h.peer;
        $('fileInput').click();
        log('Choose the file to send again to ' + (h.peerName || h.peer));
      });
      actions.appendChild(b);
    }
    if (h.direction === 'received' && receivedBlobs.has(h.fileId)) {
      const b = document.createElement('button');
      b.className = 'small ghost'; b.textContent = 'Save again';
      b.addEventListener('click', () => {
        const r = receivedBlobs.get(h.fileId);
        const a = document.createElement('a'); a.href = r.url; a.download = r.name; a.click();
      });
      actions.appendChild(b);
    }
    list.appendChild(row);
  }
}

// ---------- Clipboard history (feature 4) ----------
async function addClipHistory(item) {
  clipHistory.unshift({ at: Date.now(), ...item });
  clipHistory = clipHistory.slice(0, 20);
  await chrome.storage.local.set({ leoShareClipboard: clipHistory });
  renderClipboard();
}
function renderClipboard() {
  const list = $('clipboardList');
  if (!clipHistory.length) { list.innerHTML = '<p class="empty">Nothing shared yet.</p>'; return; }
  list.innerHTML = '';
  for (const item of clipHistory) {
    const row = document.createElement('div');
    row.className = 'clip-row';
    const isUrl = /^https?:\/\//i.test(item.text || '');
    row.innerHTML = `<div style="font-size:14px;word-break:break-word">${escapeHtml((item.text || '').slice(0, 300))}</div>
      <div class="row-meta">${item.direction === 'sent' ? 'Sent to ' : 'From '}${escapeHtml(item.peerName || item.peer || '')} · ${fmtTime(item.at)}</div>
      <div class="row-actions"></div>`;
    const actions = row.querySelector('.row-actions');
    const copyBtn = document.createElement('button');
    copyBtn.className = 'small ghost'; copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => { await navigator.clipboard.writeText(item.text); copyBtn.textContent = 'Copied ✓'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500); });
    actions.appendChild(copyBtn);
    if (isUrl) {
      const openBtn = document.createElement('button');
      openBtn.className = 'small'; openBtn.textContent = 'Open link';
      openBtn.addEventListener('click', () => window.open(item.text, '_blank'));
      actions.appendChild(openBtn);
    }
    const sendBtn = document.createElement('button');
    sendBtn.className = 'small ghost'; sendBtn.textContent = 'Send again';
    sendBtn.addEventListener('click', () => { $('clipText').value = item.text; sendClipboardText(item.text); });
    actions.appendChild(sendBtn);
    list.appendChild(row);
  }
}

// ---------- Offline queue — IndexedDB ----------
let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('leoshare-db', 2);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('outbox')) req.result.createObjectStore('outbox', { keyPath: 'id' });
      if (!req.result.objectStoreNames.contains('partials')) req.result.createObjectStore('partials', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function idbTx(store, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const idbAdd = (rec) => idbTx('outbox', 'readwrite', (s) => s.add(rec));
const idbPut = (rec) => idbTx('outbox', 'readwrite', (s) => s.put(rec));
const idbDelete = (id) => idbTx('outbox', 'readwrite', (s) => s.delete(id));
const idbGetAll = () => idbTx('outbox', 'readonly', (s) => s.getAll());
const idbGet = (id) => idbTx('outbox', 'readonly', (s) => s.get(id));
const partialPut = (rec) => idbTx('partials', 'readwrite', (s) => s.put(rec));
const partialDelete = (id) => idbTx('partials', 'readwrite', (s) => s.delete(id));
const partialGetAll = () => idbTx('partials', 'readonly', (s) => s.getAll());

async function syncOutboxCount() {
  try {
    const all = await idbGetAll();
    const queued = all.filter((r) => r.status === 'queued' || r.status === 'sending').length;
    await chrome.storage.local.set({ leoShareOutboxCount: queued });
    $('queueCount').textContent = queued ? `(${queued} waiting)` : '';
  } catch (e) {}
}
async function loadPartials() {
  try {
    const all = await partialGetAll();
    for (const p of all) {
      if (p.received > 0 && p.received < p.meta.size) {
        partials.set(p.id, { meta: p.meta, chunks: p.chunks || [], received: p.received });
        log(`Resumable partial kept: ${p.meta.name} (${fmtBytes(p.received)} / ${fmtBytes(p.meta.size)})`);
      }
    }
  } catch (e) {}
}
async function savePartial(id) {
  const rec = incoming.get(id);
  if (!rec || rec.done) return;
  try { await partialPut({ id, meta: rec.meta, chunks: rec.chunks, received: rec.received }); } catch (e) {}
}

// ---------- Outbox rendering / queueing ----------
async function renderOutbox() {
  const list = $('outboxList');
  let all = [];
  try { all = await idbGetAll(); } catch (e) { all = []; }
  all.sort((a, b) => a.queuedAt - b.queuedAt);
  await syncOutboxCount();
  if (!all.length) { list.innerHTML = '<p class="empty">Queue is empty.</p>'; return; }
  list.innerHTML = '';
  for (const r of all) {
    const row = document.createElement('div');
    row.className = 'queue-row';
    const badge = r.status === 'delivered' ? '<span class="badge">Delivered ✓</span>'
      : r.status === 'declined' ? '<span class="badge offline">Declined</span>'
      : r.status === 'sending' ? '<span class="badge queued">Sending…</span>'
      : '<span class="badge queued">Queued</span>';
    row.innerHTML = `<div class="top"><span><b>${escapeHtml(r.name)}</b> · ${fmtBytes(r.size)}</span>${badge}</div>
      <div class="row-meta">To ${escapeHtml(r.toName || r.to)} · queued ${fmtTime(r.queuedAt)}${r.path && r.path !== r.name ? ' · ' + escapeHtml(r.path) : ''}${r.status === 'queued' ? ' · will send automatically when they come online' : ''}</div>
      <div class="row-actions"></div>`;
    const actions = row.querySelector('.row-actions');
    const mk = (label, cls, fn, disabled) => {
      const b = document.createElement('button');
      b.className = 'small ' + (cls || 'ghost'); b.textContent = label; b.disabled = !!disabled;
      b.addEventListener('click', fn); actions.appendChild(b);
    };
    mk('Send now', '', async () => {
      if (!getConn(r.to)) { log('Send now: connecting to ' + (r.toName || r.to) + '…'); connectTo(r.to); if (await waitForOpen(r.to, WAIT_OPEN_MS)) await flushOutbox(r.to); else await renderOutbox(); return; }
      if (!getConn(r.to).open) { alert('Still connecting to ' + (r.toName || r.to) + ' — the data channel isn’t open yet. Wait a few seconds; queued files send automatically when it opens.'); return; }
      await flushOutbox(r.to);
    }, r.status === 'delivered');
    mk('Remove', 'danger', async () => { await idbDelete(r.id); renderOutbox(); });
    list.appendChild(row);
  }
}

async function queueOffline(entries, targetCode) {
  const target = normaliseCode(targetCode);
  const toName = contactName(target);
  let queued = 0;
  // Dedupe: the same file (name + size) for the same peer, already
  // queued, is not queued a second time — v1.2 queued the same PDF twice.
  let existing = [];
  try { existing = await idbGetAll(); } catch (e) {}
  for (const e of entries) {
    const f = e.file;
    if (existing.some((r) => r.to === target && r.name === f.name && r.size === f.size && (r.status === 'queued' || r.status === 'sending'))) {
      log('Already queued: ' + f.name + ' for ' + toName + ' — not queueing it again.');
      continue;
    }
    const preview = await makePreview(f);
    const sha256 = await sha256Hex(f);
    const rec = {
      id: 'q-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      to: target, toName, name: f.name, size: f.size, mime: f.type || 'application/octet-stream',
      path: e.path || f.name, folder: e.folder || '', preview: preview || null, sha256: sha256 || '',
      blob: f, queuedAt: Date.now(), status: 'queued', wasOffline: true
    };
    try { await idbAdd(rec); } catch (err) { log('Could not save ' + f.name + ' to queue: ' + err, 'err'); continue; }
    queued++;
    log(`Queued ${f.name} (${fmtBytes(f.size)}) for ${toName} — they are offline.`, 'err');
  }
  await renderOutbox();
  if (queued) {
    notify(toName + ' is offline', queued === 1
      ? `1 file queued for ${toName}. It will send automatically when they come online.`
      : `${queued} files queued for ${toName}. They will send automatically when they come online.`);
  }
  return queued;
}

async function flushOutbox(peerCode) {
  if (flushingFor === peerCode) return;
  const c = getConn(peerCode);
  if (!c) return;
  if (!c.open) {
    // Data channel still opening — the open handler flushes when it
    // opens. Keep retrying every 5 s while it is still connecting
    // (up to ~60 s) in case that handler already ran.
    log('Waiting for the data channel to ' + contactName(peerCode) + ' to open before sending queued files…');
    if (!flushRetryTimers.has(peerCode)) {
      flushRetryTimers.add(peerCode);
      flushRetryCount[peerCode] = (flushRetryCount[peerCode] || 0) + 1;
      setTimeout(() => {
        flushRetryTimers.delete(peerCode);
        if (connectingPeers.has(peerCode) && flushRetryCount[peerCode] < 12) flushOutbox(peerCode);
        else flushRetryCount[peerCode] = 0;
      }, 5000);
    }
    return;
  }
  let all = [];
  try { all = await idbGetAll(); } catch (e) { return; }
  const mine = all.filter((r) => r.to === peerCode && r.status === 'queued').sort((a, b) => a.queuedAt - b.queuedAt);
  if (!mine.length) return;
  flushingFor = peerCode;
  try {
    const missedItems = mine.filter((r) => r.wasOffline || r.queuedAt < connectionOpenedAt)
      .map((r) => ({ name: r.name, size: r.size, queuedAt: r.queuedAt }));
    if (missedItems.length) {
      try { c.send({ type: 'missed-notice', from: myId, displayName: myDisplayName, items: missedItems }); } catch (e) {}
    }
    const folders = [...new Set(mine.map((r) => r.folder).filter(Boolean))];
    for (const folder of folders) {
      const files = mine.filter((r) => r.folder === folder);
      try { c.send({ type: 'folder-meta', folder, count: files.length, files: files.map((r) => ({ name: r.name, path: r.path, size: r.size })) }); } catch (e) {}
    }
    for (const rec of mine) {
      const blob = rec.blob;
      if (!blob) continue;
      await idbPut({ ...rec, status: 'sending' });
      await renderOutbox();
      clearEmpty(sendList);
      const el = document.createElement('div');
      el.className = 'file-item';
      el.innerHTML = `<div class="file-head"><span class="name">📤 ${escapeHtml(rec.path || rec.name)}</span><span class="meta">${fmtBytes(rec.size)} · queued ${fmtTime(rec.queuedAt)}</span></div>
        <div class="file-foot"><span class="st">Sending queued file… waiting for accept</span><span class="pct"></span></div>
        <div class="bar"><div></div></div>
        <div class="row-actions"></div>`;
      sendList.prepend(el);
      addSendControls(el, rec.id);
      const item = {
        id: rec.id, outboxId: rec.id, target: peerCode, file: blob, fileName: rec.name, path: rec.path, folder: rec.folder,
        preview: rec.preview, sha256: rec.sha256,
        el, bar: el.querySelector('.bar > div'), barWrap: el.querySelector('.bar'),
        statusEl: el.querySelector('.st'), pctEl: el.querySelector('.pct'),
        accepted: false, sent: 0, paused: false
      };
      sendQueue.push(item);
      c.send({ type: 'file-meta', id: rec.id, name: rec.name, size: rec.size, mime: rec.mime, path: rec.path, folder: rec.folder, sha256: rec.sha256, preview: rec.preview });
      log(`Sending queued file ${rec.name} to ${contactName(peerCode)}…`);
    }
    pumpSendQueue();
  } finally {
    flushingFor = null;
  }
}

// ---------- TURN relay (v1.5) ----------
// v1.4's TURN was dead: it used the static pair
// username openrelayproject / credential openrelayproject against
// openrelay.metered.ca. That pair is stale — Metered no longer accepts
// it — so every allocate failed with ICE error 701 and relay 0 in the
// field log. The no-signup mechanism Metered still documents is
// STATIC AUTH on staticauth.openrelay.metered.ca: the client computes
// a time-limited credential itself,
//   username = "<unix expiry>:leoshare"
//   credential = base64(HMAC-SHA1("openrelayprojectsecret", username))
// (the standard coturn TURN REST API scheme, same as Nextcloud Talk
// uses; the secret is Metered's own published shared value, not a
// private password). Credentials expire after 24 h, so they are
// computed fresh every time a Peer is created — never stored.
let turnMode = 'staticauth (shared demo relay)';
async function computeStaticAuthTurn() {
  const expiry = Math.floor(Date.now() / 1000) + 86400;
  const username = expiry + ':leoshare';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('openrelayprojectsecret'), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username));
  const credential = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return { username, credential };
}
async function buildIceServers() {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:openrelay.metered.ca:80' }
  ];
  // A custom TURN (your own Metered account, or coturn on the
  // OptiPlex) wins if one is saved in Settings — see the Relay card.
  let custom = null;
  try {
    const data = await chrome.storage.local.get('leoShareTurn');
    custom = data.leoShareTurn || null;
  } catch (e) {}
  if (custom && custom.url && custom.username) {
    turnMode = 'custom TURN (' + custom.url + ')';
    servers.push({ urls: custom.url, username: custom.username, credential: custom.password || '' });
  }
  try {
    const sa = await computeStaticAuthTurn();
    for (const urls of [
      'turn:staticauth.openrelay.metered.ca:80',
      'turn:staticauth.openrelay.metered.ca:443',
      'turn:staticauth.openrelay.metered.ca:443?transport=tcp',
      'turns:staticauth.openrelay.metered.ca:443'
    ]) servers.push({ urls, username: sa.username, credential: sa.credential });
    if (!custom) log('Relay: using the shared demo TURN (staticauth) — fresh credentials, valid 24 h.');
    else log('Relay: custom TURN set, shared demo TURN kept as fallback.');
  } catch (e) {
    log('Could not compute TURN credentials — direct connection only. (' + (e.message || e) + ')', 'err');
  }
  return servers;
}

// ---------- Peer setup (multi-connection) ----------
async function initPeer() {
  myId = await getMyId();
  $('myCode').textContent = myId;
  setStatus('Connecting to signalling server…');
  log('Your code is ' + myId + ' — share it with the other device.');
  await loadContacts();
  await loadMissed();
  await loadHistory();
  await loadPartials();
  await renderOutbox();
  await consumePendingSend();
  const iceServers = await buildIceServers();
  log('Relay in use: ' + turnMode);
  peer = new Peer(myId, { debug: 0, config: { iceServers } });
  peer.on('open', (id) => {
    setStatus('Online — ready. Paste the other device’s code to connect, or tap a contact.', true);
    log('Online as ' + id, 'ok');
  });
  peer.on('connection', (c) => {
    log('Incoming connection from ' + c.peer);
    attachConn(c);
  });
  peer.on('error', (err) => {
    console.error(err);
    if (err.type === 'unavailable-id') {
      log('Code already in use — generating a fresh one…', 'err');
      chrome.storage.local.remove('leoShareId').then(initPeer);
    } else if (err.type === 'peer-unavailable') {
      const target = lastConnectAttempt;
      if (target) connectingPeers.delete(target);
      setStatus('That device is not online. Files for them stay queued — they will send when they come online.', false);
      log('Peer unavailable: ' + (err.message || target), 'err');
      if (target) notify(contactName(target) + ' is offline', 'That device is not online right now. Anything you send them will be queued and delivered when they come online.');
      advanceMultiSend();
    } else {
      setStatus('Error: ' + err.type + ' — reload this tab to retry.', false);
      log('Peer error (' + err.type + '): ' + (err.message || ''), 'err');
    }
  });
  peer.on('disconnected', () => {
    setStatus('Disconnected from signalling — reconnecting…', false);
    log('Lost signalling connection, reconnecting…', 'err');
    peer.reconnect();
  });
}

function attachConn(c) {
  // v1.2.1: ONE connection per peer, kept from the first attempt — even
  // while it is still connecting. v1.2 only rejected a duplicate when the
  // existing conn was already .open, so a second connect (or an incoming
  // conn while our outgoing one was still opening) overwrote the map and
  // orphaned the first conn. Its close handler then deleted the live one.
  if (conns.has(c.peer)) {
    log('Already have a connection to ' + c.peer + ' — ignoring this duplicate.');
    try { c.close(); } catch (e) {}
    return;
  }
  conns.set(c.peer, c);
  connectingPeers.add(c.peer);
  conn = c; // primary = most recent, for the Disconnect button / messages
  $('connectBtn').disabled = true;
  $('disconnectBtn').disabled = false;
  $('peerInput').value = c.peer;
  // Do NOT say "Connected" here — the data channel is not open yet.
  setStatus('Connecting to ' + contactName(c.peer) + '… (opening data channel)', false);
  log('Connecting to ' + c.peer + '… (waiting for data channel to open)');
  // v1.4 ICE diagnostics: watch the real connection underneath, so the
  // log says WHERE it stops — checking, failed, disconnected, or no
  // relay candidate at all — instead of just "waiting…".
  try {
    const pc = c.peerConnection;
    if (pc) {
      iceCandidatesByPeer[c.peer] = { host: 0, srflx: 0, relay: 0 };
      pc.onicecandidate = (e) => {
        if (!e || !e.candidate) return;
        const cand = String(e.candidate.candidate || '');
        const m = cand.match(/ typ (\w+)/);
        const type = m ? m[1] : 'unknown';
        const counts = iceCandidatesByPeer[c.peer] || (iceCandidatesByPeer[c.peer] = { host: 0, srflx: 0, relay: 0 });
        if (counts[type] !== undefined) counts[type]++;
      };
      pc.onicecandidateerror = (e) => {
        // Chrome's 701 = TURN allocation failed: the relay refused the
        // credentials, or is unreachable. 401/403 are the same story.
        const code = e.errorCode || e.errorText || 'unknown';
        const meaning = code === 701 ? 'TURN allocation failed (relay refused / unreachable)'
          : code === 401 || code === 403 ? 'TURN credentials rejected'
          : 'TURN/STUN error';
        log('ICE candidate error for ' + contactName(c.peer) + ': ' + code + ' — ' + meaning + '. Relay in use: ' + turnMode + '.', 'err');
      };
      pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState;
        iceStateByPeer[c.peer] = s;
        log('ICE to ' + contactName(c.peer) + ': ' + s);
        if (s === 'failed' || s === 'disconnected') {
          setStatus('Connection to ' + contactName(c.peer) + ' failed at the network step (ICE ' + s + '). Try again, or check whether the network blocks WebRTC.', false);
        }
        updateActiveBar();
      };
      pc.onconnectionstatechange = () => log('Connection state to ' + contactName(c.peer) + ': ' + pc.connectionState);
    }
  } catch (e) {}
  // 30 s watchdog: if the channel still isn't open, say so once, with
  // the ICE state and candidate census — that is the diagnosis.
  setTimeout(() => {
    if (getConn(c.peer) === c && !c.open) {
      const counts = iceCandidatesByPeer[c.peer] || { host: 0, srflx: 0, relay: 0 };
      let gathering = '';
      try { gathering = c.peerConnection ? ', gathering: ' + c.peerConnection.iceGatheringState : ''; } catch (e) {}
      log('Still no data channel to ' + contactName(c.peer) + ' after 30 s — ICE: ' + (iceStateByPeer[c.peer] || 'no state change yet') + gathering + ', candidates: host ' + counts.host + ' / server-reflexive ' + counts.srflx + ' / relay ' + counts.relay + '. Relay 0 means the TURN relay did not answer either. Relay in use: ' + turnMode + '.', 'err');
      setStatus('Still connecting to ' + contactName(c.peer) + '… ICE: ' + (iceStateByPeer[c.peer] || 'no state change yet') + ' — see the Activity log.', false);
    }
  }, 30000);
  c.on('data', (data) => onData(data, c));
  c.on('close', async () => {
    log('Connection to ' + c.peer + ' closed. Queued files stay queued.');
    connectingPeers.delete(c.peer);
    // Persist any partial downloads from this peer for resume.
    for (const rec of incoming.values()) {
      if (rec.fromPeer === c.peer && rec.accepted && !rec.done && rec.received > 0) await savePartial(rec.meta.id);
    }
    // Only delete the map entry if it is still THIS conn — a stale close
    // must never delete a newer live connection (v1.2 bug).
    if (conns.get(c.peer) === c) conns.delete(c.peer);
    if (conn === c) conn = [...conns.values()].pop() || null;
    if (!conns.size) {
      $('connectBtn').disabled = false;
      $('disconnectBtn').disabled = true;
      setStatus('Online — ready. Paste the other device’s code to connect, or tap a contact.', true);
    }
    renderOutbox();
    updateActiveBar();
    advanceMultiSend();
  });
  c.on('error', (e) => {
    connectingPeers.delete(c.peer);
    log('Connection error: ' + (e.message || e), 'err');
  });
  c.on('open', async () => {
    connectingPeers.delete(c.peer);
    connectionOpenedAt = Date.now();
    const counts = iceCandidatesByPeer[c.peer] || { host: 0, srflx: 0, relay: 0 };
    setStatus('Connected to ' + contactName(c.peer) + ' ✓ — data channel open, you can send files now.', true);
    log('Data channel open to ' + c.peer + ' — ready to send. ICE: ' + (iceStateByPeer[c.peer] || 'connected') + ', relay candidates: ' + counts.relay + (counts.relay ? ' (via TURN relay)' : ' (direct)'), 'ok');
    await upsertContact(c.peer, { lastSeen: Date.now() });
    try { c.send({ type: 'hello', from: myId, displayName: myDisplayName }); } catch (e) {}
    if (pendingClipboard && (pendingClipboard.target === 'connected' || pendingClipboard.target === c.peer)) {
      const text = pendingClipboard.text;
      pendingClipboard = null;
      sendClipboardText(text, c.peer);
    }
    flushOutbox(c.peer);
    updateActiveBar();
  });
}

function connectTo(code) {
  code = normaliseCode(code);
  if (!code) { alert('Paste the other device’s code first.'); return; }
  if (code === myId) { alert('That is your own code — you need the other device’s code.'); return; }
  if (!peer || peer.disconnected) { alert('Not online yet — wait a second and try again.'); return; }
  // v1.2.1: never start a second connect while one is in flight or a
  // connection already exists, and cool down repeats (4 s). Tapping
  // Connect twice, or the multi-send timer firing, used to spawn a new
  // DataConnection every time — the other side saw 5 incoming connects
  // in 2 seconds.
  if (conns.has(code)) {
    if (isUsable(code)) alert('Already connected to ' + code + '.');
    else log('Already connecting to ' + code + ' — waiting for the data channel…');
    return;
  }
  if (connectingPeers.has(code)) { log('Already connecting to ' + code + ' — waiting…'); return; }
  if (Date.now() - (lastConnectAttemptAt[code] || 0) < 4000) { log('Connect to ' + code + ' tried moments ago — waiting before retrying.'); return; }
  lastConnectAttempt = code;
  lastConnectAttemptAt[code] = Date.now();
  connectingPeers.add(code);
  log('Connecting to ' + code + '…');
  setStatus('Connecting to ' + code + '…');
  const c = peer.connect(code, { reliable: true });
  attachConn(c);
}

// Multi-send (feature 3): send to several contacts in turn.
// Live if a peer is online, queued if not; auto-advances to the next.
function startMultiSend(targets) {
  multiSendTargets = [...targets];
  if (multiSendTimer) clearInterval(multiSendTimer);
  multiSendTimer = setInterval(() => {
    if (!multiSendTargets.length) { clearInterval(multiSendTimer); multiSendTimer = null; return; }
    advanceMultiSend();
  }, 3000);
  advanceMultiSend();
}
async function advanceMultiSend() {
  if (!multiSendTargets.length) return;
  const next = multiSendTargets[0];
  const c = getConn(next);
  if (c && c.open) {
    // Still sending to this peer? Check its outbox + live queue.
    const live = sendQueue.some((x) => x.target === next);
    let queued = 0;
    try { queued = (await idbGetAll()).filter((r) => r.to === next && (r.status === 'queued' || r.status === 'sending')).length; } catch (e) {}
    if (live || queued) { flushOutbox(next); return; }
    // Done with this peer — move on.
    multiSendTargets.shift();
    try { c.close(); } catch (e) {}
    log('Multi-send: finished ' + contactName(next) + ', moving to next…');
  }
  if (!multiSendTargets.length) return;
  const target = multiSendTargets[0];
  if (!getConn(target) || !getConn(target).open) {
    log('Multi-send: connecting to ' + contactName(target) + '…');
    connectTo(target);
  }
}

// ---------- Receiving ----------
function onData(data, c) {
  if (data instanceof ArrayBuffer || (data && data.constructor === ArrayBuffer)) { onChunk(data, c); return; }
  if (data && data.byteLength !== undefined && typeof data !== 'string') { onChunk(data, c); return; }
  let msg = null;
  try { msg = typeof data === 'string' ? JSON.parse(data) : data; } catch (e) { return; }
  if (!msg || !msg.type) return;
  if (msg.type === 'folder-meta') onFolderMeta(msg, c);
  else if (msg.type === 'file-meta') onFileMeta(msg, c);
  else if (msg.type === 'file-accept') onFileAccepted(msg.id, msg.resumeFrom);
  else if (msg.type === 'file-decline') onFileDeclined(msg.id);
  else if (msg.type === 'file-cancel') onFileCancelled(msg.id);
  else if (msg.type === 'file-end') onFileEnd(msg.id, c);
  else if (msg.type === 'text') addMessage(msg.text, 'them');
  else if (msg.type === 'clipboard') onClipboard(msg, c);
  else if (msg.type === 'hello') onHello(msg);
  else if (msg.type === 'missed-notice') onMissedNotice(msg);
}

async function onHello(msg) {
  if (!msg.from) return;
  await upsertContact(msg.from, { lastSeen: Date.now() });
  log('Hello from ' + (msg.displayName || msg.from));
}

async function onMissedNotice(msg) {
  if (!msg.items || !msg.items.length) return;
  const fromName = msg.displayName || contactName(msg.from) || msg.from;
  for (const it of msg.items) missed.push({ from: msg.from, fromName, name: it.name, size: it.size, at: it.queuedAt || Date.now() });
  await saveMissed();
  const names = msg.items.map((i) => i.name).join(', ');
  log(`Missed while you were offline: ${fromName} tried to send ${names}`, 'err');
  notify('Missed while you were offline', `${fromName} tried to send you: ${names}. ${msg.items.length === 1 ? 'It is' : 'They are'} sending now.`);
}

function onFolderMeta(msg, c) {
  if (!msg.folder) return;
  if (!folderGroups.has(msg.folder)) {
    folderGroups.set(msg.folder, { count: msg.count || 0, files: new Map(), el: null });
  }
  const g = folderGroups.get(msg.folder);
  g.count = msg.count || g.count;
  renderFolderGroup(msg.folder);
  log(`Incoming folder “${msg.folder}” — ${g.count} file(s)`);
}

function renderFolderGroup(folder) {
  const g = folderGroups.get(folder);
  if (!g) return;
  const list = $('folderList');
  clearEmpty(list);
  if (!g.el) {
    g.el = document.createElement('div');
    g.el.className = 'file-item';
    list.prepend(g.el);
  }
  const done = [...g.files.values()].filter((f) => f.done).length;
  g.el.innerHTML = `<div class="file-head"><span class="name">📁 ${escapeHtml(folder)}/</span><span class="meta">${done} / ${g.count || g.files.size} files</span></div>
    <div class="row-meta">${[...g.files.values()].map((f) => escapeHtml(f.path || f.name)).join('<br>') || 'Waiting for files…'}</div>
    <div class="row-actions"></div>`;
  const actions = g.el.querySelector('.row-actions');
  if (done > 0 && done === (g.count || done)) {
    const zipBtn = document.createElement('button');
    zipBtn.className = 'small'; zipBtn.textContent = 'Download folder as ZIP';
    zipBtn.addEventListener('click', async () => {
      try {
        const zip = new JSZip();
        for (const f of g.files.values()) if (f.blob) zip.file(f.path || f.name, f.blob);
        const blob = await zip.generateAsync({ type: 'blob' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = folder + '.zip'; a.click();
        log('Downloaded folder ' + folder + ' as ZIP', 'ok');
      } catch (e) { alert('Could not make the ZIP: ' + e.message); }
    });
    actions.appendChild(zipBtn);
  }
}

function onFileMeta(meta, c) {
  clearEmpty(recvList);
  const el = document.createElement('div');
  el.className = 'file-item offer';
  const pathLabel = meta.path && meta.path !== meta.name ? meta.path : meta.name;
  el.innerHTML = `<div class="file-head"><span class="name">📥 ${escapeHtml(pathLabel)}</span><span class="meta">${fmtBytes(meta.size)}</span></div>
    ${previewHtml(meta.preview)}
    <div class="file-foot"><span class="st">Incoming file — preview above, then Accept to download</span><span class="pct"></span></div>
    <div class="bar"><div></div></div>
    <div style="margin-top:10px;display:flex;gap:8px">
      <button class="small accept">Accept &amp; download</button>
      <button class="small ghost decline">Decline</button>
    </div>`;
  recvList.prepend(el);
  const partial = partials.get(meta.id);
  const rec = {
    meta, chunks: partial ? partial.chunks : [], received: partial ? partial.received : 0,
    el, bar: el.querySelector('.bar > div'), barWrap: el.querySelector('.bar'),
    statusEl: el.querySelector('.st'), pctEl: el.querySelector('.pct'),
    accepted: false, done: false, fromPeer: c ? c.peer : '', lastSaved: partial ? partial.received : 0
  };
  if (partial) {
    rec.bar.style.width = Math.min(100, (rec.received / meta.size) * 100).toFixed(1) + '%';
    rec.pctEl.textContent = `Resumable — ${fmtBytes(rec.received)} / ${fmtBytes(meta.size)} already received`;
    rec.statusEl.textContent = 'Accept to resume from where it stopped';
  }
  incoming.set(meta.id, rec);
  if (meta.folder) {
    if (!folderGroups.has(meta.folder)) folderGroups.set(meta.folder, { count: 0, files: new Map(), el: null });
    folderGroups.get(meta.folder).files.set(meta.path || meta.name, { name: meta.name, path: meta.path, done: false, blob: null });
    renderFolderGroup(meta.folder);
  }
  log(`Incoming file: ${meta.name} (${fmtBytes(meta.size)})${partial ? ' — resumable from ' + fmtBytes(partial.received) : ''}`);
  el.querySelector('.accept').addEventListener('click', () => acceptFile(meta.id));
  el.querySelector('.decline').addEventListener('click', () => {
    const peerCode = rec.fromPeer;
    if (peerCode) sendTo(peerCode, { type: 'file-decline', id: meta.id });
    partials.delete(meta.id);
    incoming.delete(meta.id);
    el.remove();
    log('Declined ' + meta.name);
    addHistory({ direction: 'received', name: meta.name, size: meta.size, peer: peerCode, peerName: contactName(peerCode), status: 'declined', fileId: meta.id, path: meta.path });
  });
  // v1.3: any contact is trusted, so files from a contact always
  // auto-accept. The checkbox only covers devices that aren't contacts.
  const sender = c ? getContact(c.peer) : null;
  if ($('autoAccept').checked || sender) acceptFile(meta.id);
}

function acceptFile(id) {
  const rec = incoming.get(id);
  if (!rec || rec.accepted) return;
  rec.accepted = true;
  rec.el.classList.remove('offer');
  const acc = rec.el.querySelector('.accept'); if (acc) acc.remove();
  const dec = rec.el.querySelector('.decline'); if (dec) dec.remove();
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'small danger'; cancelBtn.textContent = 'Cancel';
  cancelBtn.style.marginTop = '10px';
  cancelBtn.addEventListener('click', () => {
    if (rec.fromPeer) sendTo(rec.fromPeer, { type: 'file-cancel', id });
    partials.delete(id);
    incoming.delete(id);
    rec.el.remove();
    log('Cancelled download of ' + rec.meta.name);
  });
  rec.el.appendChild(cancelBtn);
  rec.statusEl.textContent = rec.received > 0 ? `Resuming… ${fmtBytes(rec.received)} already here` : 'Downloading… keep this tab open';
  if (rec.fromPeer) sendTo(rec.fromPeer, { type: 'file-accept', id, resumeFrom: rec.received || 0 });
  log('Accepted ' + rec.meta.name + (rec.received ? ' — resuming from ' + fmtBytes(rec.received) : ''));
}

function onChunk(buf, c) {
  let rec = null;
  for (const r of incoming.values()) { if (r.accepted && !r.done && (!c || r.fromPeer === c.peer)) { rec = r; break; } }
  if (!rec) return;
  const bytes = buf instanceof ArrayBuffer ? buf : buf.buffer ? buf.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf;
  rec.chunks.push(bytes);
  rec.received += bytes.byteLength;
  const pct = Math.min(100, (rec.received / rec.meta.size) * 100);
  rec.bar.style.width = pct.toFixed(1) + '%';
  rec.pctEl.textContent = pct.toFixed(0) + '% · ' + fmtBytes(rec.received) + ' / ' + fmtBytes(rec.meta.size);
  if (rec.received - (rec.lastSaved || 0) >= 1024 * 1024) { rec.lastSaved = rec.received; savePartial(rec.meta.id); }
}

async function onFileEnd(id, c) {
  const rec = incoming.get(id);
  if (!rec) return;
  rec.done = true;
  const blob = new Blob(rec.chunks, { type: rec.meta.mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  receivedBlobs.set(id, { url, name: rec.meta.name, mime: rec.meta.mime });
  partials.delete(id);
  try { await partialDelete(id); } catch (e) {}
  // SHA-256 verification (feature 2)
  let verified = null;
  if (rec.meta.sha256) {
    const actual = await sha256Hex(blob);
    verified = actual && actual.toLowerCase() === String(rec.meta.sha256).toLowerCase();
  }
  rec.bar.style.width = '100%';
  rec.barWrap.classList.add('done');
  rec.statusEl.textContent = 'Complete ✓ — downloaded' + (verified === true ? ' · checksum verified' : verified === false ? ' · ⚠ checksum mismatch — re-send it' : '');
  rec.pctEl.textContent = fmtBytes(rec.meta.size);
  const btn = document.createElement('button');
  btn.className = 'small'; btn.textContent = 'Save again'; btn.style.marginTop = '10px';
  btn.addEventListener('click', () => { const a = document.createElement('a'); a.href = url; a.download = rec.meta.name; a.click(); });
  rec.el.appendChild(btn);
  // In-place preview after download (feature 8)
  const prev = document.createElement('div');
  prev.className = 'preview';
  if (rec.meta.mime && rec.meta.mime.startsWith('image/')) prev.innerHTML = `<img src="${url}" alt="received image">`;
  else if (rec.meta.mime && rec.meta.mime.startsWith('video/')) prev.innerHTML = `<video controls src="${url}"></video>`;
  else if (rec.meta.mime && rec.meta.mime.startsWith('audio/')) prev.innerHTML = `<audio controls src="${url}"></audio>`;
  else if (rec.meta.mime && rec.meta.mime.startsWith('text/')) {
    try { const t = await blob.slice(0, 2000).text(); prev.innerHTML = `<pre>${escapeHtml(t)}</pre>`; } catch (e) {}
  }
  if (prev.innerHTML) rec.el.appendChild(prev);
  if (rec.meta.folder && folderGroups.has(rec.meta.folder)) {
    const g = folderGroups.get(rec.meta.folder);
    const f = g.files.get(rec.meta.path || rec.meta.name);
    if (f) { f.done = true; f.blob = blob; }
    renderFolderGroup(rec.meta.folder);
  }
  const a = document.createElement('a');
  a.href = url; a.download = rec.meta.name;
  document.body.appendChild(a); a.click(); a.remove();
  log(`Received complete: ${rec.meta.name} (${fmtBytes(rec.meta.size)})${verified === true ? ' · checksum verified' : verified === false ? ' · CHECKSUM MISMATCH' : ''}`, verified === false ? 'err' : 'ok');
  const fromName = rec.fromPeer ? contactName(rec.fromPeer) : 'LeoShare';
  notify('File received', `${rec.meta.name} (${fmtBytes(rec.meta.size)}) from ${fromName} — downloaded${verified === true ? ' · verified' : ''}.`);
  addHistory({ direction: 'received', name: rec.meta.name, size: rec.meta.size, peer: rec.fromPeer, peerName: fromName, status: 'complete', fileId: id, path: rec.meta.path, shaVerified: verified });
  renderHistory();
}

// ---------- Sending ----------
function addSendControls(el, itemId) {
  const wrap = el.querySelector('.row-actions') || (() => { const d = document.createElement('div'); d.className = 'row-actions'; el.appendChild(d); return d; })();
  const pauseBtn = document.createElement('button');
  pauseBtn.className = 'small ghost'; pauseBtn.textContent = 'Pause';
  pauseBtn.addEventListener('click', () => {
    const item = sendQueue.find((x) => x.id === itemId);
    if (!item) return;
    item.paused = !item.paused;
    pauseBtn.textContent = item.paused ? 'Resume' : 'Pause';
    item.statusEl.textContent = item.paused ? 'Paused — tap Resume to continue' : 'Sending…';
    log((item.paused ? 'Paused ' : 'Resumed ') + (item.fileName || item.file.name));
    if (!item.paused) pumpSendQueue();
  });
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'small danger'; cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', async () => { await cancelSend(itemId, true); });
  wrap.appendChild(pauseBtn);
  wrap.appendChild(cancelBtn);
}

async function cancelSend(itemId, byUser) {
  const item = sendQueue.find((x) => x.id === itemId);
  if (!item) return;
  item.cancelled = true;
  if (item.target) sendTo(item.target, { type: 'file-cancel', id: itemId });
  item.statusEl.textContent = 'Cancelled.';
  if (item.outboxId) { try { await idbDelete(item.outboxId); } catch (e) {} renderOutbox(); }
  sendQueue = sendQueue.filter((x) => x.id !== itemId);
  addHistory({ direction: 'sent', name: item.fileName || item.file.name, size: item.file.size, peer: item.target, peerName: contactName(item.target), status: 'cancelled', fileId: itemId, path: item.path });
  log('Cancelled send of ' + (item.fileName || item.file.name));
  if (byUser) notify('Send cancelled', (item.fileName || item.file.name) + ' was cancelled.');
  pumpSendQueue();
}

function onFileCancelled(id) {
  const item = sendQueue.find((x) => x.id === id);
  if (!item) return;
  item.statusEl.textContent = 'Cancelled by the other device.';
  log('Other side cancelled ' + (item.fileName || item.file.name), 'err');
  if (item.outboxId) { idbDelete(item.outboxId).then(() => renderOutbox()).catch(() => {}); }
  sendQueue = sendQueue.filter((x) => x.id !== id);
  sending = false;
  pumpSendQueue();
}

async function queueFiles(entries) {
  // entries: [{file, path, folder}]
  const multi = [...document.querySelectorAll('#multiSendList input:checked')].map((i) => normaliseCode(i.value)).filter(Boolean);
  const selected = ($('sendToSelect').value || '').trim();
  const typed = normaliseCode($('peerInput').value);
  const livePeers = [...conns.keys()].filter((k) => conns.get(k).open);
  let targets = [];
  if (multi.length) targets = multi;
  else if (selected) targets = [normaliseCode(selected)];
  else if (typed) targets = [typed];
  else if (pendingResendTarget) { targets = [normaliseCode(pendingResendTarget)]; pendingResendTarget = null; }
  else if (livePeers.length === 1) targets = livePeers;
  else if (livePeers.length > 1) targets = livePeers.slice(0, 1);

  if (!targets.length) {
    alert('Pick a recipient first — enter their code above, tick a contact in “Send to” / multi-send, or connect to a device, then drop the file again.');
    return;
  }
  // Folder announcement for the receiver (feature 1)
  const folders = [...new Set(entries.map((e) => e.folder).filter(Boolean))];
  for (const target of targets) {
    // v1.2.1: if a connection is in flight, WAIT for its data channel
    // to open before deciding the peer is "offline". v1.2 queued the
    // file immediately when .open was still false, even though the UI
    // already said Connected.
    let isLive = isUsable(target);
    if (!isLive && (conns.has(target) || connectingPeers.has(target))) {
      log('Waiting for the data channel to ' + contactName(target) + ' to open…');
      isLive = await waitForOpen(target, WAIT_OPEN_MS);
    }
    if (!isLive && !conns.has(target) && !connectingPeers.has(target)) {
      log('Connecting to ' + contactName(target) + ' to deliver…');
      connectTo(target);
      isLive = await waitForOpen(target, WAIT_OPEN_MS);
    }
    if (isLive) {
      const c = getConn(target);
      if (folders.length) {
        for (const folder of folders) {
          const files = entries.filter((e) => e.folder === folder);
          try { c.send({ type: 'folder-meta', folder, count: files.length, files: files.map((e) => ({ name: e.file.name, path: e.path, size: e.file.size })) }); } catch (e) {}
        }
      }
      await sendLive(entries, target);
    } else {
      await queueOffline(entries, target);
    }
  }
  if (multi.length > 1) startMultiSend(multi);
}

async function sendLive(entries, target) {
  const c = getConn(target);
  if (!c || !c.open) { await queueOffline(entries, target); return; }
  clearEmpty(sendList);
  for (const e of entries) {
    const f = e.file;
    const id = 'f-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const preview = await makePreview(f);
    const sha256 = await sha256Hex(f);
    const el = document.createElement('div');
    el.className = 'file-item';
    const label = e.path && e.path !== f.name ? e.path : f.name;
    el.innerHTML = `<div class="file-head"><span class="name">📤 ${escapeHtml(label)}</span><span class="meta">${fmtBytes(f.size)}</span></div>
      <div class="file-foot"><span class="st">Hashing &amp; preparing…</span><span class="pct"></span></div>
      <div class="bar"><div></div></div>
      <div class="row-actions"></div>`;
    sendList.prepend(el);
    addSendControls(el, id);
    const item = {
      id, target, file: f, fileName: f.name, path: e.path || f.name, folder: e.folder || '',
      preview, sha256,
      el, bar: el.querySelector('.bar > div'), barWrap: el.querySelector('.bar'),
      statusEl: el.querySelector('.st'), pctEl: el.querySelector('.pct'),
      accepted: false, sent: 0, paused: false
    };
    sendQueue.push(item);
    item.statusEl.textContent = 'Waiting for the other side to accept…';
    c.send({ type: 'file-meta', id, name: f.name, size: f.size, mime: f.type || 'application/octet-stream', path: item.path, folder: item.folder, sha256, preview });
    log(`Offered ${f.name} (${fmtBytes(f.size)}) to ${contactName(target)} — waiting for accept…`);
  }
  pumpSendQueue();
}

function onFileAccepted(id, resumeFrom) {
  const item = sendQueue.find((x) => x.id === id);
  if (!item) return;
  item.accepted = true;
  if (resumeFrom && resumeFrom > 0 && resumeFrom < item.file.size) {
    item.sent = resumeFrom;
    log('Resuming ' + (item.fileName || item.file.name) + ' from ' + fmtBytes(resumeFrom));
  }
  item.statusEl.textContent = 'Sending…';
  log('Other side accepted ' + (item.fileName || item.file.name));
  pumpSendQueue();
}
async function onFileDeclined(id) {
  const item = sendQueue.find((x) => x.id === id);
  if (!item) return;
  item.statusEl.textContent = 'Declined by the other device.';
  log('Other side declined ' + (item.fileName || item.file.name), 'err');
  notify('File declined', (item.fileName || item.file.name) + ' was declined by the other device.');
  addHistory({ direction: 'sent', name: item.fileName || item.file.name, size: item.file.size, peer: item.target, peerName: contactName(item.target), status: 'declined', fileId: id, path: item.path });
  if (item.outboxId) {
    try { const rec = await idbGet(item.outboxId); if (rec) await idbPut({ ...rec, status: 'declined' }); } catch (e) {}
    renderOutbox();
  }
  sendQueue = sendQueue.filter((x) => x.id !== id);
  sending = false;
  pumpSendQueue();
}

async function pumpSendQueue() {
  if (sending) return;
  const item = sendQueue.find((x) => x.accepted && !x.paused && !x.cancelled && getConn(x.target) && getConn(x.target).open);
  if (!item) return;
  sending = true;
  const c = getConn(item.target);
  const f = item.file;
  const displayName = item.fileName || f.name;
  const start = Date.now();
  let ok = false;
  try {
    for (let offset = item.sent; offset < f.size; offset += CHUNK) {
      if (item.paused || item.cancelled) break;
      if (!getConn(item.target) || !getConn(item.target).open) throw new Error('Connection lost');
      const slice = f.slice(offset, offset + CHUNK);
      const buf = await slice.arrayBuffer();
      let waited = 0;
      const dc = getConn(item.target).dataChannel;
      while (dc && dc.bufferedAmount > 1024 * 1024 && waited < 30000) {
        await new Promise((r) => setTimeout(r, 50));
        waited += 50;
      }
      if (item.paused || item.cancelled) break;
      getConn(item.target).send(buf);
      item.sent += buf.byteLength;
      const pct = (item.sent / f.size) * 100;
      item.bar.style.width = pct.toFixed(1) + '%';
      const elapsed = (Date.now() - start) / 1000;
      const speed = elapsed > 0 ? item.sent / elapsed : 0;
      item.pctEl.textContent = `${pct.toFixed(0)}% · ${fmtBytes(item.sent)} / ${fmtBytes(f.size)} · ${fmtSpeed(speed)}`;
      if (offset % (CHUNK * 20) === 0) await new Promise((r) => setTimeout(r, 0));
    }
    if (item.paused) { item.statusEl.textContent = 'Paused — tap Resume to continue'; return; }
    if (item.cancelled) return;
    if (item.sent < f.size) throw new Error('Connection lost');
    getConn(item.target).send({ type: 'file-end', id: item.id });
    item.bar.style.width = '100%';
    item.barWrap.classList.add('done');
    item.statusEl.textContent = 'Sent ✓';
    item.pctEl.textContent = fmtBytes(f.size);
    log(`Sent complete: ${displayName} (${fmtBytes(f.size)})`, 'ok');
    ok = true;
    addHistory({ direction: 'sent', name: displayName, size: f.size, peer: item.target, peerName: contactName(item.target), status: 'complete', fileId: item.id, path: item.path });
    if (item.outboxId) {
      await idbDelete(item.outboxId);
      await renderOutbox();
      notify('Delivered to ' + contactName(item.target), `${displayName} (${fmtBytes(f.size)}) was delivered.`);
    }
  } catch (e) {
    if (item.paused || item.cancelled) return;
    item.statusEl.textContent = 'Failed: ' + (e.message || e) + (item.outboxId ? ' — back in queue, will retry when they come online.' : ' — accept again to resume from ' + fmtBytes(item.sent));
    log('Send failed for ' + displayName + ': ' + (e.message || e), 'err');
    addHistory({ direction: 'sent', name: displayName, size: f.size, peer: item.target, peerName: contactName(item.target), status: 'failed', fileId: item.id, path: item.path });
    if (item.outboxId) {
      try { const rec = await idbGet(item.outboxId); if (rec) await idbPut({ ...rec, status: 'queued' }); } catch (err) {}
      await renderOutbox();
      notify('Send paused', displayName + ' is back in the queue — it will retry when the other device comes online.');
    }
  } finally {
    if (ok || item.cancelled || !item.paused) {
      // Only remove completed / cancelled / failed items; paused items stay.
      if (ok || item.cancelled || item.statusEl.textContent.startsWith('Failed')) {
        sendQueue = sendQueue.filter((x) => x.id !== item.id);
      }
    }
    sending = false;
    if (!item.paused) pumpSendQueue();
    advanceMultiSend();
  }
}

// ---------- Clipboard (feature 4) ----------
async function sendClipboardText(text, target) {
  text = (text || '').trim();
  if (!text) { alert('Type some text or a link first.'); return; }
  const targetCode = target ? normaliseCode(target) : ($('sendToSelect').value ? normaliseCode($('sendToSelect').value) : (conn ? conn.peer : ''));
  if (!targetCode) { alert('Not connected — connect to a device first, or the text will be kept in the box.'); return; }
  // v1.2.1: same wait-for-open as files — a connecting peer is not offline.
  let c = getConn(targetCode);
  if (c && !c.open) {
    log('Waiting for the data channel to ' + contactName(targetCode) + ' to open for clipboard…');
    if (await waitForOpen(targetCode, WAIT_OPEN_MS)) c = getConn(targetCode);
  }
  if (!c) {
    log('Connecting to ' + contactName(targetCode) + ' to send clipboard…');
    connectTo(targetCode);
    if (await waitForOpen(targetCode, WAIT_OPEN_MS)) c = getConn(targetCode);
  }
  if (!c || !c.open) {
    pendingClipboard = { text, target: targetCode };
    notify(contactName(targetCode) + ' is offline', 'Your text will send when they come online.');
    log('Clipboard text held for ' + contactName(targetCode) + ' (offline).');
    return;
  }
  c.send({ type: 'clipboard', text, from: myId, displayName: myDisplayName, at: Date.now() });
  await addClipHistory({ direction: 'sent', text, peer: targetCode, peerName: contactName(targetCode) });
  log('Sent clipboard text to ' + contactName(targetCode), 'ok');
  notify('Clipboard sent', 'Text sent to ' + contactName(targetCode) + '.');
}

async function onClipboard(msg, c) {
  const text = msg.text || '';
  if (!text) return;
  const fromName = msg.displayName || contactName(msg.from) || (c ? c.peer : '');
  await addClipHistory({ direction: 'received', text, peer: msg.from || (c ? c.peer : ''), peerName: fromName });
  $('clipText').value = text;
  log('Clipboard received from ' + fromName + ': ' + text.slice(0, 80), 'ok');
  notify('Clipboard from ' + fromName, text.slice(0, 120));
  try { await navigator.clipboard.writeText(text); log('Copied received text to this clipboard.'); } catch (e) { /* needs a gesture — the Copy button covers it */ }
}

async function consumePendingSend() {
  try {
    const data = await chrome.storage.local.get('leoSharePendingSend');
    const p = data.leoSharePendingSend;
    if (!p) return;
    await chrome.storage.local.remove('leoSharePendingSend');
    if (p.text) {
      $('clipText').value = p.text;
      log('Right-click send received: ' + p.kind + ' — ' + String(p.text).slice(0, 80));
      const target = p.target && p.target !== 'pick' && p.target !== 'connected' ? p.target : '';
      if (target) {
        pendingClipboard = { text: p.text, target };
        connectTo(target);
      } else if (conn) {
        sendClipboardText(p.text, conn.peer);
      } else {
        pendingClipboard = { text: p.text, target: 'connected' };
        alert('Right-click content is in the Clipboard box below — connect to a device, then tap “Send clipboard to device”.');
      }
    }
  } catch (e) {}
}

// ---------- Messages ----------
function addMessage(text, who) {
  const div = document.createElement('div');
  div.className = who;
  div.textContent = (who === 'me' ? 'You: ' : 'Them: ') + text;
  $('messages').appendChild(div);
}
function sendText() {
  const v = $('msgInput').value.trim();
  if (!v) return;
  // Chat goes to the selected contact when connected to them.
  const targetConn = (selectedContact && getConn(selectedContact) && getConn(selectedContact).open)
    ? getConn(selectedContact) : conn;
  if (!targetConn || !targetConn.open) { alert('Not connected yet — tap a contact above first.'); return; }
  targetConn.send({ type: 'text', text: v });
  addMessage(v, 'me');
  $('msgInput').value = '';
}

// ---------- QR (feature 7) ----------
function showQr() {
  try {
    const box = $('qrBox');
    const payload = 'leoshare://' + myId + (myDisplayName ? '?name=' + encodeURIComponent(myDisplayName) : '');
    const qr = qrcode(0, 'M');
    qr.addData(payload);
    qr.make();
    box.innerHTML = qr.createImgTag(5, 8);
    box.style.display = 'block';
    $('qrHint').style.display = 'block';
    $('qrHint').textContent = 'Point the other device’s camera at this QR, or scan their QR with “Scan QR” — it fills in their code. QR contains: ' + payload;
    log('QR shown for ' + myId);
  } catch (e) { alert('Could not make the QR code: ' + e.message); }
}
async function startScan() {
  try {
    const video = $('scanVideo');
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = scanStream;
    await video.play();
    video.style.display = 'block';
    $('scanActions').style.display = 'flex';
    const canvas = document.createElement('canvas');
    scanTimer = setInterval(() => {
      if (!video.videoWidth) return;
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(img.data, img.width, img.height);
      if (code && code.data) {
        const m = String(code.data).match(/leo-[a-z0-9]{6}/i);
        if (m) {
          stopScan();
          $('peerInput').value = m[0].toLowerCase();
          log('QR scanned: ' + m[0], 'ok');
          notify('QR scanned', 'Found device ' + m[0] + ' — tap Connect.');
        }
      }
    }, 300);
  } catch (e) { alert('Camera scan needs camera permission — allow it, or type the code instead. (' + e.message + ')'); }
}
function stopScan() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
  $('scanVideo').style.display = 'none';
  $('scanActions').style.display = 'none';
}

// ---------- Wiring ----------
document.addEventListener('DOMContentLoaded', () => {
  initPeer();

  $('connectBtn').addEventListener('click', () => connectTo($('peerInput').value));
  $('peerInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') connectTo($('peerInput').value); });
  $('disconnectBtn').addEventListener('click', () => {
    if (conn) conn.close();
    // If other peers are still connected, primary switches in the close handler.
    if (!conns.size) {
      $('connectBtn').disabled = false;
      $('disconnectBtn').disabled = true;
      setStatus('Online — ready. Paste the other device’s code to connect, or tap a contact.', true);
    }
  });
  $('copyBtn').addEventListener('click', async () => {
    await navigator.clipboard.writeText(myId);
    $('copyBtn').textContent = 'Copied ✓';
    setTimeout(() => { $('copyBtn').textContent = 'Copy code'; }, 2000);
  });
  $('newIdBtn').addEventListener('click', async () => {
    if (!confirm('Get a fresh device code? The old code will stop working — update it in your contacts.')) return;
    if (peer) peer.destroy();
    await chrome.storage.local.remove('leoShareId');
    location.reload();
  });
  $('showQrBtn').addEventListener('click', showQr);
  $('scanQrBtn').addEventListener('click', startScan);
  $('stopScanBtn').addEventListener('click', stopScan);
  $('displayName').addEventListener('change', async () => {
    myDisplayName = $('displayName').value.trim();
    await chrome.storage.local.set({ leoShareDisplayName: myDisplayName });
  });
  $('autoAccept').addEventListener('change', async () => {
    await chrome.storage.local.set({ leoShareAutoAccept: $('autoAccept').checked });
  });

  $('addContactBtn').addEventListener('click', async () => {
    const code = normaliseCode($('newContactCode').value);
    if (!code) { alert('Enter a device code first, e.g. leo-abc123.'); return; }
    if (code === myId) { alert('That is your own code.'); return; }
    const name = $('newContactName').value.trim() || code;
    await upsertContact(code, { name });
    $('newContactCode').value = ''; $('newContactName').value = '';
    log('Added contact ' + name + ' (' + code + ').');
    selectContact(code);
  });
  $('activeChatBtn').addEventListener('click', () => { if (selectedContact) selectContact(selectedContact, 'chat'); });
  $('activeFileBtn').addEventListener('click', () => { if (selectedContact) selectContact(selectedContact, 'file'); });
  $('activeClipBtn').addEventListener('click', () => { if (selectedContact) selectContact(selectedContact, 'clip'); });

  // Relay (TURN) settings — saved only on this browser. A change needs
  // a reload to take effect, because the Peer is built once at startup.
  (async () => {
    try {
      const data = await chrome.storage.local.get('leoShareTurn');
      const t = data.leoShareTurn;
      if (t) {
        $('turnUrl').value = t.url || '';
        $('turnUser').value = t.username || '';
        $('turnPass').value = t.password || '';
        $('turnStatus').textContent = 'Relay: custom TURN (' + (t.url || '') + ')';
      }
    } catch (e) {}
  })();
  $('saveTurnBtn').addEventListener('click', async () => {
    const url = $('turnUrl').value.trim();
    const username = $('turnUser').value.trim();
    const password = $('turnPass').value;
    if (!url || !username) { alert('Enter the TURN server and username first — e.g. turn:global.relay.metered.ca:80 and the username Metered gave you.'); return; }
    await chrome.storage.local.set({ leoShareTurn: { url, username, password } });
    $('turnStatus').textContent = 'Relay: custom TURN saved — reload this tab to use it.';
    log('Custom TURN saved (' + url + '). Reload the tab for it to take effect.');
  });
  $('clearTurnBtn').addEventListener('click', async () => {
    await chrome.storage.local.remove('leoShareTurn');
    $('turnUrl').value = ''; $('turnUser').value = ''; $('turnPass').value = '';
    $('turnStatus').textContent = 'Relay: shared demo TURN — reload this tab to use it.';
    log('Custom TURN cleared — back to the shared demo relay. Reload the tab.');
  });

  $('flushBtn').addEventListener('click', async () => {
    if (!conn || !conn.open) { alert('Not connected — connect to the recipient first, then queued files send automatically.'); return; }
    await flushOutbox(conn.peer);
  });
  $('clearDeliveredBtn').addEventListener('click', async () => {
    const all = await idbGetAll();
    for (const r of all) if (r.status === 'delivered' || r.status === 'declined') await idbDelete(r.id);
    await renderOutbox();
  });
  $('clearMissedBtn').addEventListener('click', async () => { missed = []; await saveMissed(); });
  $('clearHistoryBtn').addEventListener('click', async () => {
    history = []; await chrome.storage.local.set({ leoShareHistory: [] }); renderHistory();
  });
  $('historySearch').addEventListener('input', renderHistory);
  $('historyFilter').addEventListener('change', renderHistory);

  const dz = $('dropZone'), fi = $('fileInput'), fo = $('folderInput');
  $('chooseFilesBtn').addEventListener('click', () => fi.click());
  $('chooseFolderBtn').addEventListener('click', () => fo.click());
  dz.addEventListener('click', () => fi.click());
  fi.addEventListener('change', async () => {
    if (fi.files.length) {
      const entries = [...fi.files].map((f) => ({ file: f, path: f.name, folder: '' }));
      await queueFiles(entries);
    }
    fi.value = '';
  });
  fo.addEventListener('change', async () => {
    if (fo.files.length) await queueFiles(await filesFromFolderInput(fo));
    fo.value = '';
  });
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', async (e) => {
    e.preventDefault(); dz.classList.remove('over');
    if (e.dataTransfer.files.length) await queueFiles(await filesFromDataTransfer(e.dataTransfer));
  });

  $('sendClipBtn').addEventListener('click', () => sendClipboardText($('clipText').value));
  $('pasteClipBtn').addEventListener('click', async () => {
    try { $('clipText').value = await navigator.clipboard.readText(); }
    catch (e) { alert('Chrome blocked reading the clipboard here — paste into the box with Ctrl+V instead.'); }
  });
  $('sendTabBtn').addEventListener('click', async () => {
    try {
      const tabs = await chrome.tabs.query({});
      const other = tabs.filter((t) => t.url && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('chrome://'))
        .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
      if (!other) { alert('No other tab found to send.'); return; }
      $('clipText').value = other.url;
      await sendClipboardText(other.url);
    } catch (e) { alert('Could not read tabs: ' + e.message); }
  });

  $('sendMsgBtn').addEventListener('click', sendText);
  $('msgInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendText(); });

        log('LeoShare v1.5 ready. TURN now uses staticauth (fresh HMAC credentials) — plus your own TURN in the Relay card if the demo relay refuses.');
});
