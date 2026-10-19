# Claude usage, every PC, one dashboard

Several PCs share one Claude account. This repository puts a small **usage agent** on each PC and a **collector** on your server (a VPS, Render, or an always-on office PC). Each agent reads its own PC's Claude Code logs and sends the daily totals to the collector; the collector serves one dashboard with cost and tokens by model, by day and by PC, plus the largest sessions.

```
PC 1  Claude Code ── claude-usage MCP agent ──┐
PC 2  Claude Code ── claude-usage MCP agent ──┤  snapshots of per-day totals (HTTPS, x-api-key)
...                                           ├───────────────▶  collector/server.js on the VPS
PC 7  Claude Code ── claude-usage MCP agent ──┘                   ├─ dashboard   /?key=READ_KEY
                                                                  ├─ setup page  /setup?key=READ_KEY
                                                                  └─ feed        /api/usage
```

The agent is an MCP server, so Claude Code starts it with every session and no extra scheduler is needed. It also gives Claude three tools: `usage_summary` (what did the team use and spend), `usage_status` (is reporting working) and `usage_sync_now`. Only token counts, model names, session ids and the PC's name and hardware leave each PC; prompts and responses never do. Figures match `ccusage` exactly, including the cheaper and dearer cache tiers.

## 1. Run the collector on the server

Needs Node.js 18 or newer. Clone the repository on the VPS, then:

```
export INGEST_KEY='<long random text>'   # every PC sends this
export READ_KEY='<another long random text>'   # opens the dashboard and the feed
export REPORT_TZ='Asia/Kolkata'          # which day a request belongs to
export PORT=4318
node collector/server.js
```

Put it behind your usual HTTPS reverse proxy (nginx, Caddy) or open the port, and keep it running with systemd or pm2. Check `https://<collector>/healthz`. Data lives in `data/store.json`.

Other hosts: `render.yaml` is a Render blueprint (the free plan has no disk, so set `GITHUB_BACKUP` and `GITHUB_TOKEN` to mirror the store into a repository), and the `Dockerfile` builds an image that keeps its data in `/data`.

| Variable | Meaning |
| --- | --- |
| `INGEST_KEY` | Required. Agents and telemetry send it in `x-api-key`. It also opens the feed, so `usage_summary` works on every PC without more setup. Anyone holding it can post usage, so treat it like a password; each PC's id is still protected by its own token. |
| `READ_KEY` | Protects the dashboard, the setup page and `/api/usage`. Empty means open to anyone with the address. |
| `REPORT_TZ` | Time zone that decides which day a request belongs to; agents follow it. Default `UTC`. |
| `PORT`, `DATA_DIR` | Default `4318` and `./data`. |
| `PRICES_URL`, `PRICES_FILE` | Prices refresh from LiteLLM at start (`off` disables); `data/prices.json` overrides or adds models (`{"claude-x": {"in": 3, "out": 15, "cw": 3.75, "cr": 0.3, "cw1h": 6}}` per million tokens). |
| `GITHUB_BACKUP`, `GITHUB_TOKEN` | Optional mirror of the store to `owner/repo`; `GITHUB_BACKUP_PATH`, `GITHUB_BACKUP_BRANCH` refine it. |
| `MAX_BODY_BYTES` | Largest accepted POST, default 8 MB. |

## 2. Set up each PC

Open `https://<collector>/setup?key=READ_KEY`, type who uses the PC and paste `INGEST_KEY`. Copy the **usage agent** command for Windows or for macOS/Linux and run it on that PC. It downloads `agent.js` from the collector into `~/.claude-usage`, registers it for every project with

```
claude mcp add -s user claude-usage -e USAGE_URL=https://<collector> -e USAGE_KEY=<INGEST_KEY> -e USAGE_MEMBER=<name> -e USAGE_HOST=<pc-name> -- node ~/.claude-usage/agent.js
```

and sends the history already on the PC. From the next Claude Code session on, the PC reports by itself: on start, every minute while a session runs, and once more when the session ends. Run the same command again to update the agent or change the name.

What the agent does: it walks the `projects/**/*.jsonl` logs under `~/.claude` and `~/.config/claude` (or the directories in `CLAUDE_CONFIG_DIR`, comma-separated, like ccusage), reads only what was appended since last time, de-duplicates the streamed chunks of each API response the way ccusage does (one record per `message.id`, the chunk with the largest usage wins), prices fast-mode requests as their own model (`claude-opus-5-5-fast`), totals tokens per day and model (keeping the 1-hour cache writes apart, because they cost more), and posts the days that changed. The collector replaces those days, so nothing is ever counted twice, and a lost state file only costs a full re-send. When Claude Code deletes old logs (after 30 days by default) the agent stops sending the days those files covered, so the collector keeps the fuller history it already has. If the day zone changes (on the collector or the PC), the agent recounts and retracts the rows that moved.

One correction on top of ccusage: Claude Code's per-message records carry only a placeholder output count for most subagent work, so ccusage understates output tokens (five-fold on a subagent-heavy session here). Claude Code also writes its own running ledger per session (`cost-state` records) that counts them properly; the agent lifts each session's days to the ledger's totals, shared in proportion. `USAGE_LEDGER=0` switches that off and gives ccusage's figures exactly.

When Claude Code closes, it gives the agent only a fraction of a second, so the last minute of a session is usually sent at the start of the next one.

Each PC's id (`person@pc-name`) is bound to the first agent that reports it, with a token derived from that PC's Claude Code install; another PC posting under the same id is refused. To hand an id to a new installation, or to drop a renamed person's old row, remove the member: `curl -X DELETE 'https://<collector>/api/members/<id>?key=READ_KEY'` (the id is URL-encoded, `harsh%40desktop-1`).

Agent settings (environment of the MCP server): `USAGE_URL`, `USAGE_KEY`, `USAGE_MEMBER` (the person), `USAGE_HOST` (default: the PC's name; the install command pins it), `USAGE_READ_KEY` (default: the ingest key), `USAGE_CLAUDE_DIR` (comma-separated log roots), `USAGE_STATE_DIR` (default `~/.claude-usage`), `USAGE_INTERVAL_MS` (default 60000), `USAGE_TZ` (default: the collector's zone), `USAGE_LEDGER` (`0` to ignore the session ledgers).

By hand: `node agent.js --once` scans and sends once (`--everything` re-sends all days), `--status` prints the state, `--summary` prints the team summary.

**Telemetry instead of the agent.** The setup page also writes the settings for Claude Code's built-in OpenTelemetry export (`OTEL_LOGS_EXPORTER=otlp` to `/v1/logs` with per-PC `member.*` resource attributes). It needs no extra program but counts only from the moment it is on, and must live in the user-level `~/.claude/settings.json`. Use one way per PC; if both report the same PC, the agent's figures win.

## 3. Look at the dashboard

* `https://<collector>/?key=READ_KEY`: the live page, refreshed every minute while open.
* In Claude Code on any set-up PC: ask for the team's usage, or run `usage_summary`.
* The claude.ai artifact version of the page has a "Live usage from every PC" section: paste the collector's address and read key once and every device that opens the artifact shows the same PCs. It still accepts usage files added by hand.
* `https://<collector>/api/usage?key=READ_KEY`: the feed, one entry per PC with `rows` of `[day, model, input, output, cacheWrite, cacheRead, cost]`, the 50 largest sessions, and which price source each model used.
* `DELETE https://<collector>/api/members/<id>?key=READ_KEY` forgets one PC (its days and sessions).

Costs are API list-price estimates (LiteLLM's table, refreshed at start; the 1-hour cache tier and fast mode are priced as such). Haiku 5.5's dearer tier above 100K prompt tokens is decided per request and is not reproduced from daily totals. A Max plan is not billed per token, so the figures show relative weight, not what you pay.

## Layout

```
agent/agent.js           the per-PC MCP agent (Node, no dependencies); served by the collector at /agent.js
agent/test/              node --test
collector/server.js      the collector (Node, no dependencies)
collector/prices.js      model prices and lookup
collector/setup.html     per-PC install commands, served at /setup
collector/test/          node --test
ledger/ledger.tpl.html   the dashboard page; the collector fills /*__SEED__*/ and /*__LIVE__*/ when serving it
ledger/build.py          builds a stand-alone copy of the page from ccusage output (for the artifact)
docs/settings.example.json  the telemetry env block with placeholders
render.yaml, Dockerfile  deployment
```

`npm test` runs every test.
