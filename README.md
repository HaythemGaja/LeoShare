# LeoShare — Send Files Between Browsers

Send a file from Chrome on one device straight to Chrome on another device.
No email. No Google Drive. Nothing is uploaded to any server.

## How it works

- Each browser gets a short code, like `leo-abc123`.
- You paste the other device's code and hit **Connect** — or tap a saved
  contact, or scan its QR code.
- Files travel **directly browser → browser** over an encrypted WebRTC
  DataChannel (DTLS). PeerJS cloud (`0.peerjs.com`) is used only for
  signalling — to introduce the two browsers. It never sees your files.
- Files are sent in 16 KB pieces with progress, speed, and Accept/Decline
  on the receiving side. Received files download automatically.

## What's new in v1.4 (TURN relay + ICE diagnostics)

The v1.3 field log showed the real problem: signalling worked on both
sides, but the data channel **never opened** — 30+ seconds of
"waiting for data channel to open", then the file queued as offline.
v1.0–1.3 used PeerJS's default ICE (STUN only), so when both browsers
sit behind symmetric NAT / a corporate firewall that blocks UDP, there
is no path at all.

- **TURN relay added** (Metered Open Relay, public demo credentials,
  UDP + TCP + TLS on port 443). When a direct path fails, the browsers
  can now connect through the relay. The relay only forwards
  DTLS-encrypted packets — it cannot read your files. Honest limit:
  those demo credentials are shared and may be rate-limited or
  revoked by the provider; if they don't work, the next step is your
  own TURN server (e.g. coturn on the OptiPlex).
- **ICE diagnostics in the Activity log.** The log now shows the real
  connection state underneath: `ICE: checking / connected / failed /
  disconnected`, candidate errors, and after 30 s a census —
  `host n / server-reflexive n / relay n`. Relay 0 means the TURN
  relay didn't answer either. The "Chatting with …" bar shows the
  ICE state instead of repeating "connecting…".
- **Less repetition.** Identical log lines are shown once per 10 s,
  and the wait for a channel to open is now 20 s (TURN gathering
  takes longer than a direct attempt).

Still untested live: no Chrome on this VM, so whether the relay
actually gets through your two networks is for your next test — the
new ICE lines will say exactly where it stops.

## What's new in v1.3 (simpler contacts, contact-first chat)

- **Contacts are simple now.** Add a device once and it IS a contact —
  there is no separate "trusted" step, no Trust/Untrust buttons, no
  "Save as trusted" button, and no per-contact auto-accept toggle.
  Connecting to a new device adds it as a contact automatically.
  Old contacts are migrated on first run (the trusted flag is dropped).
- **Files from any contact auto-accept.** The checkbox now only covers
  devices that aren't contacts.
- **Tap a contact to start.** Tapping a contact (or its Chat / Send
  file buttons) selects it, connects to it, and makes it the recipient
  for files, clipboard and chat. A "Chatting with …" bar shows who
  you're talking to, with Chat / Send file / Clipboard shortcuts.
  The selected contact stays highlighted, with ● Online now when
  its data channel is open.

## What's new in v1.2.1 (connection fix)

v1.2 said "Connected" as soon as `connect()` was called, but PeerJS
`.open` is false until the DataChannel actually opens — so files dropped
in that window were queued as "offline" while the UI said Connected, and
tapping Connect twice (or both sides connecting at once) created
duplicate connections that overwrote each other in the map, with a stale
close then deleting the live one. That is the 5-incoming-connections-in-
2-seconds loop from the field log.

- **One connection per peer**, kept from the first attempt — duplicates
  are closed immediately, even while connecting.
- **"Connected ✓" only when the data channel opens.** Until then the
  status says "Connecting… (opening data channel)".
- **Wait-for-open:** dropping a file or sending clipboard while a
  connection is opening waits up to 8 seconds for the channel before
  deciding the peer is offline and queueing.
- **Connect guard + 4 s cooldown:** tapping Connect again, or the
  multi-send timer firing, cannot spawn another connection while one
  is in flight.
- **Stale close cannot delete a live connection:** a close only removes
  the map entry if it is still that same connection object.
- **Queue dedupe:** the same file (name + size) for the same peer,
  already queued, is not queued a second time.
- **"Send now" tells the truth:** if the channel is still opening it
  says so, instead of "Connect to … first".

## What's new in v1.2 (features 1–8)

### 1. Folder send
- Drop a whole folder (or Choose a folder…). Files keep their paths,
  e.g. `Photos/IMG_01.jpg`, shown on both sides.
- The receiver sees the folder as a group and can **Download folder as ZIP**
  (JSZip, bundled locally) or download files one by one.

### 2. Resume / pause / cancel + checksum
- Every send has **Pause / Resume / Cancel** buttons.
- If a connection drops, the receiver keeps the partial download (in
  memory, saved to IndexedDB on disconnect). Accept the same file again
  and it **resumes from where it stopped** — the sender gets
  `resumeFrom` and seeks there instead of starting over.
- Every file is **SHA-256 hashed** before sending; the receiver verifies
  the hash on completion and shows “checksum verified” or a mismatch
  warning. History records the result.

### 3. Send to several contacts at once
- Tick several contacts in the multi-send list, drop files once.
- LeoShare sends to each in turn — live if they're online, queued if
  not — and auto-advances to the next contact. One peer connection at a
  time under the hood; the queue makes the offline ones wait their turn.

### 4. Cross-device clipboard
- Type text / a link in the Clipboard box and send it to the connected
  device. **Paste from my clipboard** and **Send current tab URL** are
  one tap. Received text lands in the same box with Copy / Open / Send
  again, and a short history (last 20) is kept.

### 5. Right-click Send with LeoShare
- Right-click selected text, a link, an image, or a page → **Send with
  LeoShare** → pick a contact (or the connected device).
- The background worker stores that as a pending send and opens LeoShare;
  the tab sends it, or holds it for that device if they're offline.

### 6. Transfer history
- Every send / receive / decline / failure / cancel is logged (last 200),
  with device, time, path, and checksum result. Search it, filter
  Sent / Received, **Send again…** (pick the file, same recipient), and
  **Save again** for files received in this session. Clear anytime.

### 7. QR-code pairing
- **Show QR** displays a QR for your code (`leoshare://leo-xxxxxx`).
- **Scan QR** opens the camera and decodes the other device's QR with
  jsQR (bundled locally) — it fills in their code, then tap Connect.
  Needs camera permission; typing the code still works.

### 8. Preview before accepting
- The sender makes a small preview and sends it inside the file offer:
  a thumbnail for images / video first frame, the first ~1,500
  characters for text files. You see it **before** you tap Accept.
- After download, images / video / audio / text preview in place in the
  Received list too.

## v1.1 features (still in)

- **Contacts** — saved in `chrome.storage.local`, rename /
  per-contact auto-accept / one-tap Connect, last seen.
- **Offline queue** — files for an offline peer are stored in this
  browser's IndexedDB, survive tab close / Chrome restart, and auto-send
  when that peer connects.
- **Missed notifications** — system notifications on queue, delivery,
  receipt, and a `missed-notice` on reconnect, plus a Missed list.

## Install (do this on BOTH devices)

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `LeoShare` folder (the one containing `manifest.json`)
5. Pin the LeoShare icon in the toolbar if you want quick access

> Upgrading from v1.0 / v1.1: remove the old unpacked extension (or reload
> it in `chrome://extensions`) and Load unpacked again from the new folder.
> Your device code is kept. Contacts / queue / history carry over
> on that browser (they live in that browser's storage).

> The same folder works on Brave / Edge (both Chromium) too.

## Use it

1. Click the LeoShare icon → **Open LeoShare** (a tab opens).
   Your code is shown at the top, e.g. `leo-abc123`. Set a display name
   so the other side sees e.g. “Haythem's laptop” in notifications.
2. Connect by code, QR, or a contact.
3. Drag files / a folder into the Send box, or use Choose files / folder.
4. On the receiving device, check the preview, then tap **Accept & download**.
   Or tick "Auto-accept files" / per-contact auto-accept to skip that step.

Keep the LeoShare tab open on both sides until a live transfer finishes.
Queued files wait safely on the sender — closing the tab does not lose them.

## Privacy / limits — read this

- No account, no login, no file storage on any server.
- Multi-send is sequential (one peer at a time, auto-advancing), not
  simultaneous — the WebRTC connections are one at a time per send.
- Resume works when the same file is offered again with the same id
  (queued files, or a re-send after a drop). A brand-new offer of the
  same file starts from 0.
- The queue lives on the *sender's* device only — a file can only
  actually arrive when **both** browsers are open at the same time.
- "New code" gives you a fresh device code; the old one stops working —
  update it in your contacts on the other device.

## What was actually tested here

- All JS passes `node --check` (background, popup, transfer, and all
  bundled libs). Manifest is v1.2.0. Every element id the code uses was
  verified present in transfer.html. All script sources are local files
  that exist — no remote/CDN scripts.
- JSZip and the QR generator were run for real in Node: a ZIP with a
  folder structure was created and re-opened, a QR for
  `leoshare://leo-abc123` was generated, and SHA-256("hello") matched
  the known hash `2cf24dba…`.
- **Not tested here:** there is no Chrome/Chromium on this VM, so the
  live two-browser flow — connecting, folder send, resume after a drop,
  multi-send, clipboard, right-click, QR scan with a camera — has **not**
  been run end-to-end. That is the device-confirmation step: install on
  two browsers and try it, and tell me what breaks.

## Files

- `manifest.json` — Chrome extension manifest (Manifest V3)
- `popup.html` / `popup.js` — toolbar popup, shows your code + counts
- `transfer.html` / `transfer.js` — the transfer tab (the real app)
- `background.js` — opens/focuses the transfer tab, notification clicks, context menus
- `lib/peerjs.min.js` — PeerJS 1.5.4, bundled locally (no CDN, MV3-safe)
- `lib/jszip.min.js` — JSZip 3.10.1, for folder ZIP download
- `lib/qrcode.min.js` — qrcode-generator 1.4.4, for Show QR
- `lib/jsqr.js` — jsQR 1.4.0, for Scan QR
- `icons/` — extension icons

Version 1.4 — built 2026-11-10.
