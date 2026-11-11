# LeoShare — your own TURN server

LeoShare tries a direct browser-to-browser path first. When both networks
block that, it needs a TURN relay. The two shared demo relays in the app
(Metered staticauth, freeturn.net) need no signup — but both have now
refused allocations from Haythem's networks (ICE 701, relay 0), so the
durable fix is your own TURN. Either route below is pasted into the
**Relay card** already in LeoShare (transfer tab, "Relay (TURN)"):
server URL, username, password — then **reload the tab**, on **both**
browsers. The relay only forwards DTLS-encrypted packets; it cannot
read your files. Credentials stay in that browser only, never in the repo.

Test any TURN before pasting it in: Metered's Trickle ICE tool at
https://www.metered.ca/turn-server-testing — enter the server +
username + password and launch. You want a `relay` candidate to appear.

## Route A — free Metered account (fastest, no server to run)

1. Go to https://www.metered.ca/tools/openrelay/ → **Signup for free
   account** (dashboard.metered.ca).
2. In the dashboard go to **TURN Servers** → generate your first
   credential. It gives you a username + password and servers such as
   `turn:global.relay.metered.ca:80` (the exact host is shown there).
3. In LeoShare's Relay card paste:
   - TURN server: the `turn:` URL Metered gave you (e.g.
     `turn:global.relay.metered.ca:80`)
   - Username / password: the ones Metered generated
   - Save, reload the tab. Do the same on the other browser.
4. Quota, honestly: the Open Relay page advertises 20 GB/month free,
   but Metered's pricing page lists the free plan as a 500 MB trial —
   the dashboard is the truth, check what it shows after signup. For
   sending PDFs between two browsers, even 500 MB goes a long way.

## Route B — self-hosted coturn on the Oracle Always Free VM (recommended own relay)

No quota, no third party, yours alone. Haythem's Oracle tenancy
`haythemga` is already Free Tier, home region US Midwest — no VM
created yet. Creating the VM needs his phone browser (FIDO sign-in),
then on the VM (Ubuntu 22.04/24.04, Always Free):

```bash
sudo apt update && sudo apt install -y coturn
```

`/etc/turnserver.conf` (replace `YOUR_VM_PUBLIC_IP` and choose a
password — never put the real one in chat or in the repo):

```
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
external-ip=YOUR_VM_PUBLIC_IP
min-port=49152
max-port=65535
lt-cred-mech
user=leoshare:CHOOSE_A_PASSWORD
realm=YOUR_VM_PUBLIC_IP
log-file=/var/log/turnserver.log
```

```bash
sudo systemctl enable --now coturn
sudo systemctl status coturn
```

Open the ports in **two** places: the Oracle Cloud security list for
the VM's subnet (ingress: 3478 TCP+UDP, 5349 TCP, 49152–65535 UDP)
and the VM's own firewall (`sudo ufw allow 3478/tcp && sudo ufw allow
3478/udp && sudo ufw allow 5349/tcp && sudo ufw allow 49152:65535/udp`,
or the equivalent iptables rules).

Then in LeoShare's Relay card on both browsers:

- TURN server: `turn:YOUR_VM_PUBLIC_IP:3478`
- Username: `leoshare`
- Password: the one you set in `turnserver.conf`
- Save, reload the tab.

## Route C — coturn on the OptiPlex (done 2026-11-11 — running)

Same software as Route B, on the home OptiPlex (192.168.1.7, Ubuntu
24.04), installed **without sudo** — the box's sudo needs a password,
so coturn runs as a user service from `~/coturn`:

```bash
# on the OptiPlex, as hay1 — noble's coturn is 4.6.1-1build4
# (-2build2 is for a newer Ubuntu and wants libraries noble lacks)
cd /tmp
curl -O http://archive.ubuntu.com/ubuntu/pool/universe/c/coturn/coturn_4.6.1-1build4_amd64.deb
for p in core extra openssl pthreads; do
  curl -O http://archive.ubuntu.com/ubuntu/pool/main/libe/libevent/libevent-$p-2.1-7t64_2.1.12-stable-10ubuntu0.2_amd64.deb
done
mkdir -p ~/coturn
dpkg-deb -x coturn_4.6.1-1build4_amd64.deb ~/coturn
for d in libevent-*.deb; do dpkg-deb -x "$d" ~/coturn; done
```

`~/.config/coturn/turnserver.conf` (chmod 600 — the password lives
only here, never in chat or the repo):

```
listening-port=3478
listening-ip=127.0.0.1
listening-ip=192.168.1.7
relay-ip=192.168.1.7
min-port=49152
max-port=65535
lt-cred-mech
user=leoshare:<password generated on the box with openssl rand -hex 16>
realm=leoshare.local
log-file=/home/hay1/coturn/turnserver.log
pidfile=/home/hay1/coturn/turnserver.pid
no-stdout-log
```

User service `~/.config/systemd/user/coturn-leoshare.service`
(enabled, Restart=always; linger is on so it survives reboots):

```
[Unit]
Description=LeoShare TURN server (coturn, user install)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/home/hay1/coturn/usr/bin/turnserver -c /home/hay1/.config/coturn/turnserver.conf
Environment=LD_LIBRARY_PATH=/home/hay1/coturn/usr/lib/x86_64-linux-gnu
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now coturn-leoshare.service
```

Open the port in the box firewall (needs the OptiPlex password,
typed on the box):

```bash
sudo ufw allow 3478/tcp && sudo ufw allow 3478/udp
```

Then in LeoShare's Relay card on both browsers (home Wi-Fi):

- TURN server: `turn:192.168.1.7:3478`
- Username: `leoshare`
- Password: the one in `~/.config/coturn/turnserver.conf`
  (read it on the box: `grep '^user=leoshare:' ~/.config/coturn/turnserver.conf`)
- Save, reload the tab.

Proved 2026-11-11: TURN allocate returns a relay candidate on both
127.0.0.1:3478 and 192.168.1.7:3478. Honest limits: the box must stay
on; this is LAN-first with no `external-ip`, so a browser off the
home network can't reach it — that needs a router port-forward of
3478 (TCP+UDP) and 49152–65535 (UDP) to 192.168.1.7 plus
`external-ip=<home public IP>` in the config, and the public IP can
change unless DDNS is set up. No TLS (`turns:`) yet — it needs a real
certificate; browsers reject self-signed ones. This replaces Metered
in the Relay card (one custom slot); Metered stays the fallback if
the box is off.

## If a relay still shows 701 / relay 0

- 701 after pasting your own TURN = wrong username/password, or the
  port is closed — re-check the credential in the dashboard/config
  and the firewall/security-list rules above, then test at the
  Trickle ICE link at the top before re-testing LeoShare.
- `relay 1` + `ICE: connected` in the LeoShare log = the relay works;
  queued files should then send on reconnect.
