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

## Route C — coturn on the OptiPlex (same software, more moving parts)

Same install and config as Route B, on the OptiPlex (192.168.1.7),
with `external-ip` set to the home public IP. Extra steps: forward
3478 (TCP+UDP) and 49152–65535 (UDP) on the router (192.168.1.1) to
192.168.1.7, the box must stay on, and the home public IP changes
unless DDNS is set up — so the Relay card value can go stale. Only
pick this if you prefer the relay at home over the Oracle VM.

## If a relay still shows 701 / relay 0

- 701 after pasting your own TURN = wrong username/password, or the
  port is closed — re-check the credential in the dashboard/config
  and the firewall/security-list rules above, then test at the
  Trickle ICE link at the top before re-testing LeoShare.
- `relay 1` + `ICE: connected` in the LeoShare log = the relay works;
  queued files should then send on reconnect.
