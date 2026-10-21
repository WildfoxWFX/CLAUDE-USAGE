# Step by step: from nothing to one dashboard for every PC

Time: about 15 minutes for the VPS, 3 minutes per PC.

## A. What you need

1. A VPS running Ubuntu or Debian that you can reach over SSH with sudo.
2. Optional but recommended: a domain or subdomain (for example `usage.yourcompany.com`) with an A record pointing at the VPS's IP. With it you get HTTPS automatically. Without it, the collector runs on plain HTTP on port 4318.
3. On each PC: Claude Code, and Node.js LTS from https://nodejs.org (the install command tells you if it is missing).

## B. The VPS

Either paste the prompt in `docs/deploy.md` into Claude Code on the VPS and let it do B1 to B8, or run these yourself.

**B1. Log in and install Node.js and git**

```
ssh root@YOUR-VPS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
node --version      # must print v18 or newer
```

**B2. Get the code**

```
sudo git clone -b claude/claude-usage-report-78adzh https://github.com/WildfoxWFX/CLAUDE-USAGE /opt/claude-usage
```

**B3. Make two keys and keep them**

```
openssl rand -hex 24    # this is INGEST_KEY: every PC sends it
openssl rand -hex 24    # this is READ_KEY: opens the dashboard
```

**B4. Write the settings file**

```
sudo tee /etc/claude-usage.env >/dev/null <<'END'
INGEST_KEY=paste-the-first-key
READ_KEY=paste-the-second-key
REPORT_TZ=Asia/Kolkata
PORT=4318
DATA_DIR=/var/lib/claude-usage
END
sudo chmod 600 /etc/claude-usage.env
```

`REPORT_TZ` decides which day a request belongs to. Use your office's time zone.

**B5. Create the service**

```
sudo useradd -r -s /usr/sbin/nologin claude-usage
sudo mkdir -p /var/lib/claude-usage && sudo chown claude-usage: /var/lib/claude-usage
sudo tee /etc/systemd/system/claude-usage.service >/dev/null <<END
[Unit]
Description=Claude usage collector
After=network.target

[Service]
User=claude-usage
WorkingDirectory=/opt/claude-usage
EnvironmentFile=/etc/claude-usage.env
ExecStart=$(command -v node) collector/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
END
sudo systemctl daemon-reload
sudo systemctl enable --now claude-usage
curl -s http://127.0.0.1:4318/healthz
```

The last line must print `{"ok":true,...}`. If not: `journalctl -u claude-usage -n 30`.

**B6. Make it reachable**

With a domain (HTTPS, recommended):

```
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'END'
usage.yourcompany.com {
    reverse_proxy 127.0.0.1:4318
}
END
sudo systemctl reload caddy
sudo ufw allow 80,443/tcp
```

Caddy fetches the certificate itself. Your address is `https://usage.yourcompany.com`.

Without a domain (plain HTTP):

```
sudo ufw allow 4318/tcp
```

Your address is `http://YOUR-VPS-IP:4318`. Keys travel unencrypted on this path, so use a domain when you can.

**B7. Check from your own browser**

Open `ADDRESS/?key=READ_KEY`. You should see the ledger with "no PC has reported yet". Opening `ADDRESS/` without the key shows "Read key needed", which is correct.

**B8. Note down three things**

The address, `READ_KEY`, `INGEST_KEY`. Everything below uses them.

## C. Each PC (repeat for all seven)

Either paste the per-PC prompt from `docs/deploy.md` (section 2) into Claude Code on that PC with the address, the ingest key and the person's name filled in, and let it do C1 to C5, or do it by hand:

**C1.** In a browser, open `ADDRESS/setup?key=READ_KEY`.

**C2.** Type who uses the PC (for example `harsh`), paste `INGEST_KEY`, click **Make the commands**.

**C3.** Copy the command under **Usage agent, Windows** (or **macOS or Linux**).

**C4.** On that PC, open PowerShell (a normal window, not administrator), paste, press Enter. Expected last lines:

```
Scanned 12 log files, 840 new API calls. Sent 31 day-and-model rows and 9 sessions (everything this PC has) to ADDRESS as “harsh · DESKTOP-I981MMD”.
Installed. Every new Claude Code session on this PC now reports its usage.
```

If it prints "Node.js was not found", install Node.js LTS from https://nodejs.org, open a new PowerShell window, paste again.

**C5.** Close Claude Code on that PC completely and start it again. Type `/mcp`: `claude-usage` is listed as connected.

**C6.** Refresh the dashboard: the PC is there, with its history. From now on it reports by itself: when a session starts, every minute while it runs, and when it ends.

## D. Using it

- Dashboard: `ADDRESS/?key=READ_KEY`. Pick a PC in the filter, hover the daily chart, see the largest sessions.
- In Claude Code on any set-up PC, ask "how much did the team use Claude this week?" Claude calls `usage_summary` and answers with cost and tokens by PC and by model. "Is usage reporting working?" calls `usage_status`.
- claude.ai artifact: in "Live usage from every PC", paste the address and `READ_KEY`, click Connect. Every device that opens the artifact then shows the same PCs.

## E. Keeping it running

- Update the collector: `cd /opt/claude-usage && sudo git pull && sudo systemctl restart claude-usage`.
- Update an agent: run the PC command from the setup page again on that PC.
- Logs on the VPS: `journalctl -u claude-usage -f`.
- Backup: `/var/lib/claude-usage/store.json` is everything.
- Change the time zone: edit `REPORT_TZ` in `/etc/claude-usage.env`, restart the service; the agents recount on their own.
- Change keys: edit the env file, restart, then run the PC command again with the new `INGEST_KEY`.

## F. If something does not work

| Symptom | Where to look |
| --- | --- |
| `/healthz` does not answer from outside | Firewall (`sudo ufw status`), Caddy (`journalctl -u caddy -n 30`), DNS of the domain |
| Dashboard says "Read key needed" | Add `?key=READ_KEY` to the address |
| A PC does not appear | In Claude Code on that PC ask Claude to run `usage_status`: it shows the last error. `401` means the key differs from `INGEST_KEY`; `fetch failed` means the address is wrong or blocked |
| `claude-usage` missing in `/mcp` | Run `claude mcp list` in a terminal on that PC; re-run the install command |
| Two rows for one person | Same person on two PCs: that is intended (name · PC). A renamed person leaves the old row behind: remove it with `curl -X DELETE 'ADDRESS/api/members/<old-id>?key=READ_KEY'` (the id is shown in `usage_status`, URL-encoded like `harsh%40desktop-1`) |
| "another installation already reports as ..." | Two PCs use the same name and PC name, or the PC was reinstalled from scratch. Use a different name, or remove the member on the collector as above and run the install command again |
