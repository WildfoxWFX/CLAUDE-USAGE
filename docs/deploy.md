# Deploying: the VPS first, then each PC

Two pastes. The first goes to Claude Code running on your VPS and sets up the collector. The second goes into PowerShell on each PC and installs the local MCP agent that reports to it.

## 1. Prompt for Claude Code on the VPS

Log in to the VPS, start `claude` in any folder, and paste this. Replace the two values in angle brackets first.

```
Set up the Claude usage collector on this server. Run the commands yourself, check each step, and show me the final addresses at the end.

Facts:
- Repository: https://github.com/WildfoxWFX/CLAUDE-USAGE, branch claude/claude-usage-report-78adzh. The collector is collector/server.js: Node.js 18 or newer, no npm dependencies. README.md lists its environment variables.
- Public address of this server: <DOMAIN-OR-IP>. If that is a domain name pointing here, serve HTTPS through Caddy. If it is only an IP address, serve plain HTTP on port 4318.
- Time zone for the daily totals: <TIME-ZONE, for example Asia/Kolkata>

Steps:
1. Node.js: if `node --version` is missing or below 18, install the current LTS (NodeSource repository or the distribution package). Confirm `node --version` and `git --version`.
2. Clone the repository into /opt/claude-usage with `git clone -b claude/claude-usage-report-78adzh https://github.com/WildfoxWFX/CLAUDE-USAGE /opt/claude-usage`. If the clone asks for credentials, stop and ask me for a GitHub token; do not guess.
3. Secrets: generate INGEST_KEY and READ_KEY with `openssl rand -hex 24` each. Write /etc/claude-usage.env, owned by root, mode 600, with these lines: INGEST_KEY=..., READ_KEY=..., REPORT_TZ=<the time zone above>, PORT=4318, DATA_DIR=/var/lib/claude-usage.
4. Service: create a system user `claude-usage` (no login shell), create /var/lib/claude-usage owned by it, and a systemd unit /etc/systemd/system/claude-usage.service with User=claude-usage, WorkingDirectory=/opt/claude-usage, EnvironmentFile=/etc/claude-usage.env, ExecStart=<full path of node> collector/server.js, Restart=always, RestartSec=3. Enable and start it. Confirm `curl -s http://127.0.0.1:4318/healthz` answers with "ok":true and that `journalctl -u claude-usage -n 20` shows "collector listening on port 4318".
5. Reaching it from outside:
   - Domain: install Caddy, add a site block for the domain that does `reverse_proxy 127.0.0.1:4318`, reload Caddy, and confirm `curl -s https://<domain>/healthz` works from the server. Open ports 80 and 443 in the firewall (ufw or firewalld); keep 4318 closed from outside.
   - IP only: open port 4318 in the firewall and confirm `curl -s http://<ip>:4318/healthz` works. Tell me plainly that keys then travel unencrypted.
6. Run `npm test` in /opt/claude-usage once; all tests must pass. If the tests cannot bind ports or lack a browser, say so, but the service health check above is what matters.
7. Write /opt/claude-usage/UPDATE.md with the update procedure: `cd /opt/claude-usage && git pull && systemctl restart claude-usage`.
8. Print for me, exactly and nothing else at the end:
   Dashboard:  <scheme://address>/?key=<READ_KEY>
   Setup page: <scheme://address>/setup?key=<READ_KEY>
   Health:     <scheme://address>/healthz
   INGEST_KEY: <the value>   (I paste this into the setup page for each PC)

Do not change the application code. If a step fails, show me the command and its error and stop there.
```

## 2. Each PC

Open the setup page the VPS printed (`/setup?key=READ_KEY`) in a browser on any machine. Type who uses the PC, paste the `INGEST_KEY`, click **Make the commands**, copy the **Usage agent, Windows** command and paste it into PowerShell on that PC. It downloads the agent from the VPS and registers it with `claude mcp add`. Then close Claude Code on that PC and start it again.

The command it writes, for reference (values in angle brackets come from the VPS; a name with spaces is written as `Harsh%20Patel`):

```
$d=Join-Path $env:USERPROFILE '.claude-usage';New-Item -ItemType Directory -Force -Path $d|Out-Null;$f=Join-Path $d 'agent.js';$h=if($env:COMPUTERNAME){$env:COMPUTERNAME}else{[Net.Dns]::GetHostName()};Invoke-WebRequest -UseBasicParsing -Uri '<ADDRESS>/agent.js' -OutFile $f;claude mcp remove -s user claude-usage 2>$null|Out-Null;claude mcp add -s user claude-usage -e USAGE_URL=<ADDRESS> -e USAGE_KEY=<INGEST_KEY> -e USAGE_MEMBER=<NAME> -e "USAGE_HOST=$h" -- node $f;$env:USAGE_URL='<ADDRESS>';$env:USAGE_KEY='<INGEST_KEY>';$env:USAGE_MEMBER='<NAME>';$env:USAGE_HOST=$h;node $f --once
```

Check on the PC, inside Claude Code: `/mcp` lists `claude-usage` as connected, and asking "how much Claude did the team use this week?" makes Claude call `usage_summary`. The dashboard shows the PC as "name · PC-NAME" within a minute of the first session; its history is included.

macOS or Linux PCs: use the **Usage agent, macOS or Linux** command from the same page.

## What runs where

| Where | What | Runs when |
| --- | --- | --- |
| VPS | `collector/server.js` as the `claude-usage` systemd service | always |
| each PC | `~/.claude-usage/agent.js`, registered as the `claude-usage` MCP server | every Claude Code session: on start, every minute, and at exit |
| browser | `/?key=READ_KEY` on the VPS, or the claude.ai artifact's "Live usage" section pointed at the VPS | when you look |
