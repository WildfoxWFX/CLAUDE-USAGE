# Claude usage, every PC, one dashboard

Several PCs share one Claude account. This repository makes each PC's Claude Code report its usage by itself, as it happens, and shows all of them in one page: cost and tokens by model, by day, by PC, and the largest sessions.

How it fits together:

```
PC 1  Claude Code ──┐
PC 2  Claude Code ──┤  OpenTelemetry events (OTLP/HTTP JSON, one POST every 5 s while in use)
...                 ├──────────────────────────────▶  collector/server.js  ──▶  dashboard  /?key=READ_KEY
PC 7  Claude Code ──┘   x-api-key: INGEST_KEY                                 └─▶  feed       /api/usage?key=READ_KEY
```

Claude Code has built-in OpenTelemetry export. Six lines in each PC's `~/.claude/settings.json` turn it on and point it at the collector. The collector keeps per-member daily totals and serves the dashboard (the `ledger/` page) with live data. The same page, published as a claude.ai artifact, can read the collector's feed too ("Live usage from every PC" section).

Only token counts, model names, Claude Code's own cost estimate, session ids and a few resource attributes (OS, CPU architecture, Claude Code version) leave each PC. Prompts and responses are never sent.

## 1. Run the collector

Pick one:

**Render (hosted, free plan works).** Fork or push this repository to GitHub, then on Render choose *New → Blueprint* and select the repository. `render.yaml` creates the service and generates two secrets, `INGEST_KEY` and `READ_KEY`; read them under *Environment*. The free plan has no persistent disk, so also set `GITHUB_BACKUP` (for example `your-user/claude-usage`) and `GITHUB_TOKEN` (a fine-grained token with *Contents: read and write* on that repository): the collector then mirrors its store to `data/usage-store.json` in that repository every five minutes and on shutdown, and loads it back after a redeploy. Free services sleep after 15 minutes without traffic and need about a minute to wake, during which a PC's first batches are lost; a free uptime monitor hitting `/healthz` every 10 minutes keeps it awake (750 free hours a month cover one service).

**An always-on PC on your network.** Needs Node.js 18 or newer.

```
set INGEST_KEY=<long random text>
set READ_KEY=<another long random text>
set REPORT_TZ=Asia/Kolkata
node collector/server.js
```

It listens on port 4318 (`PORT` changes it). Allow that port in the Windows firewall. Each PC then uses `http://<that PC's IP>:4318/v1/logs`. Data lives in `data/store.json` next to the code.

**Docker.** `docker build -t claude-usage-collector .` then run it with the same environment variables and a volume on `/data`.

Environment variables:

| Variable | Meaning |
| --- | --- |
| `INGEST_KEY` | Required. Every PC sends it in the `x-api-key` header. |
| `READ_KEY` | Protects the dashboard, the setup page and `/api/usage`. Empty means open to anyone with the address. |
| `REPORT_TZ` | Time zone that decides which day a request belongs to. Default `UTC`. |
| `PORT` | Default `4318`. |
| `DATA_DIR` | Where `store.json` lives. Default `./data`. |
| `GITHUB_BACKUP`, `GITHUB_TOKEN` | Optional mirror of the store to `owner/repo`. `GITHUB_BACKUP_PATH` (default `data/usage-store.json`) and `GITHUB_BACKUP_BRANCH` refine it. |
| `MAX_BODY_BYTES` | Largest accepted POST. Default 8 MB. |

Check it: `https://<collector>/healthz` answers with the member and event counts.

## 2. Set up each PC

Open `https://<collector>/setup?key=READ_KEY`, type the name of the person who uses the PC and paste `INGEST_KEY`. The page writes three equivalent things: a PowerShell command for Windows, a Terminal command for macOS and Linux, and the JSON to merge by hand. Run the command on that PC, then close and reopen Claude Code. After the next prompt the PC appears on the dashboard within a minute.

What the command writes into the user-level `~/.claude/settings.json` (`%USERPROFILE%\.claude\settings.json` on Windows), keeping everything else in the file:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "none",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "https://<collector>/v1/logs",
    "OTEL_RESOURCE_ATTRIBUTES": "member.name=harsh,member.id=harsh@desktop-i981mmd,member.host=DESKTOP-I981MMD",
    "OTEL_EXPORTER_OTLP_HEADERS": "x-api-key=<INGEST_KEY>"
  }
}
```

`member.name` is the person, `member.host` the PC, `member.id` keeps the two apart on the dashboard even when one account is shared by everyone. Claude Code reads these only from the user-level or managed settings file, never from a project's `.claude/settings.json`, and only at start. A value in `OTEL_RESOURCE_ATTRIBUTES` may not contain spaces or commas; the setup page percent-encodes names for you.

Not showing up? Start Claude Code once with `CLAUDE_CODE_OTEL_DIAG_STDERR=1` set and read the exporter's errors: 401 means the key differs from `INGEST_KEY`; a connection error means the address is wrong or unreachable from that PC.

## 3. Look at the dashboard

* `https://<collector>/?key=READ_KEY` is the live page, refreshed every minute while open.
* The claude.ai artifact version of the page has a "Live usage from every PC" section: paste the collector's address and read key once; with the artifact's shared store, every device that opens the artifact then shows the same PCs. The artifact still accepts usage files added by hand for PCs that cannot report.
* `https://<collector>/api/usage?key=READ_KEY` is the feed: one entry per member with `rows` of `[day, model, input, output, cacheWrite, cacheRead, cost]`, plus the 50 largest sessions.

Costs are Claude Code's own API list-price estimates. A Max plan is not billed per token, so they show relative weight, not what you pay.

## Layout

```
collector/server.js      the collector (Node, no dependencies)
collector/setup.html     per-PC settings generator, served at /setup
collector/test/          node --test
ledger/ledger.tpl.html   the dashboard page; the collector fills /*__SEED__*/ and /*__LIVE__*/ when serving it
ledger/build.py          builds a stand-alone copy of the page from ccusage output (for the artifact)
docs/settings.example.json  the env block with placeholders
render.yaml, Dockerfile  deployment
```

`npm test` runs the collector's tests.
