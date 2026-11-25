# Conduit bridge for company IT

This document is for administrators who run the Conduit bridge on company computers. It covers configuration, network connections, local data, engines on company accounts, agent permissions, updates and removal. Statements refer to bridge 3.0.4 and the installers `install.sh` and `install.ps1` served by app.tryconduit.de.

The bridge runs as the signed-in user, not as a system service. Everything it does, and everything the AI agents it starts do, happens with that user's rights.

## Where settings live

The installer writes `~/.conduit/bridge/.env.local` (Windows: `%USERPROFILE%\.conduit\bridge\.env.local`), readable only by the user. The service launcher (`start.sh` or `start.ps1`) reads it line by line as `KEY=value`, nothing in it is executed. Add the variables from this document there and restart the service:

| Platform | Restart |
|---|---|
| macOS | `launchctl kickstart -k gui/$(id -u)/de.tryconduit.bridge` |
| Linux | `systemctl --user restart conduit-bridge` |
| Windows | `Stop-ScheduledTask ConduitBridge; Start-ScheduledTask ConduitBridge` |

Notes:

- Self-updates replace `src/`, `node_modules/` and the package files. They do not touch `.env.local`.
- **Re-running the installer** updates only its own keys in `.env.local` (`BRIDGE_HOST`, `BRIDGE_PORT`, `PAIR_PORT`, `CLAUDE_BIN`, `DB_DIR`, `PAIR_PUBLIC_HOST`, `PAIR_APP_BASE`, `CONDUIT_SUPERVISED`, `PAIR_OWNER_EMAIL`) and keeps every other line as it is, including the settings from this document. Installers from before October 2026 rewrote the whole file.
- The user who owns the machine account can edit `.env.local`. These settings are an operator configuration, not protection against that user. For Claude Code, policies the user cannot change belong in Claude Code's managed settings (see Anthropic's documentation); the bridge does not override them.
- The bridge logs the active agent, update and retention settings at startup (`agent_policy`, `selfupdate_policy`, `housekeeping_policy` in `bridge.log`). The paired owner can also see them in the app's status call (`/api/status`: `agentPolicy`, `update`).

## Network

The bridge listens only on `127.0.0.1` (port 8787, pairing page 8788) and refuses to start on a wildcard address. All remote access arrives through the Cloudflare tunnel, which `cloudflared` opens outbound. Inbound firewall rules are not needed.

Outbound connections:

| From | Destination | Purpose | When |
|---|---|---|---|
| cloudflared | `region1.v2.argotunnel.com`, `region2.v2.argotunnel.com`, port 7844 TCP and UDP (http2 / QUIC) | The tunnel | Always. Cloudflare publishes the IP ranges and the names for SNI-filtering firewalls (`cftunnel.com`, `h2.cftunnel.com`, `quic.cftunnel.com`) in [Run a tunnel behind a firewall](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/tunnel-with-firewall/). The installer starts cloudflared with `--no-autoupdate`, so cloudflared's own update hosts are not needed. |
| bridge | `https://app.tryconduit.de/bridge/v3/bridge.tar.gz` and `.sig` (`CONDUIT_UPDATE_URL`) | Self-update | Every 6 hours unless updates are off (see Updates) |
| bridge (npm) | npm registry, by default `registry.npmjs.org` | Dependencies when a release changes them; the optional speech runtime | Only then |
| bridge | `https://github.com/CommsConnectgmbh/conduit-bridge/releases/download/...` (`CONDUIT_MODELS_URL`), which redirects to GitHub's download host | Optional speech models | Only when a user installs a voice or speech recognition |
| bridge | `OLLAMA_HOST`, by default `http://127.0.0.1:11434` | Local models | When Ollama is used |
| bridge | Amazon's Alexa API (`api*.amazonalexa.com`) and the certificate URL in a signed Alexa request | Optional Alexa skill | Only with `ALEXA_SKILL_ID` set |
| bridge | Sonos speakers in the local network: SSDP multicast (`239.255.255.250:1900`), their local API on port 1443 | Optional speaker for long Alexa answers | Only with `ALEXA_SPEAKER` set, when an answer is read aloud |
| Sonos speaker | This computer, on its local address and a random port, path `/clip/<random>.wav` | The speaker fetches the answer as a WAV clip | Only while a clip is pending (at most 5 minutes); the listener is closed otherwise and never reachable through the tunnel |
| AI CLIs | Their vendors (Anthropic, OpenAI, Google) | The model calls | Per turn, under the CLI's own sign-in |
| installer | `app.tryconduit.de`, the Conduit cloud API, GitHub (cloudflared download if not installed), npm | Installation | Once |

Apart from the update download from app.tryconduit.de, the bridge makes no calls to Conduit's servers at runtime. App traffic through the tunnel is end-to-end encrypted (Noise, see the README); the tunnel and the cloud see ciphertext and connection metadata.

Model downloads and the speech runtime are pinned by SHA-256 in the signed bridge package, so a mirror can be used: host the same files under `<mirror>/<model id>/<file name>` and set `CONDUIT_MODELS_URL`. A company npm registry configured for the user also serves the speech runtime and update dependencies; their integrity hashes come from the signed lockfile.

## What is stored locally

Paths for an installation by `install.sh`; on Windows the same names under `%USERPROFILE%`.

Since 3.1.2 the bridge keeps the chat database, attachments and logs owner-only (directories 0700, files 0600) and corrects older installs on every start. On Windows the user profile's ACL applies instead.

| Data | Path | Content | Kept |
|---|---|---|---|
| Chat history | `~/.conduit/bridge/db.sqlite` (+ `-wal`, `-shm`) | Chats (account e-mail, title, working directory, engine, model, token and cost counters, CLI session ids), full prompt and answer text, the audit trail of tool steps (input up to 4,000 and output up to 6,000 characters), paired devices | Until the user deletes the chat, or `CONDUIT_RETENTION_DAYS` |
| Bridge identity | `~/.conduit/bridge/identity.key` | X25519 private key, mode 0600 | Until removed; replacing it means pairing all devices again |
| Configuration | `~/.conduit/bridge/.env.local` | Ports, paths, tunnel host name, account e-mail, settings from this document | Until removed |
| Tunnel token | `~/.conduit/.cloudflared-token` | Cloudflare connector token, readable only by the user | Until removed |
| Attachments | `~/Library/conduit-bridge/pastes/` (also on Linux and Windows, as `Library` in the home directory) | Files sent from the app, up to 25 MB each | 30 days by modification time (`CONDUIT_PASTE_RETENTION_DAYS`) |
| Bridge log | `~/Library/Logs/conduit-bridge/bridge.log` (+ rotated files) | JSON events without e-mail addresses, paths, search terms or CLI output | 10 MB x 5 files (`CONDUIT_LOG_MAX_BYTES`, `CONDUIT_LOG_FILES`) |
| Service logs | macOS: `~/.conduit/logs/de.tryconduit.{bridge,tunnel}.{out,err}.log`; Linux: the user journal; Windows: none | Bridge stdout (the same lines as `bridge.log`) and cloudflared output | macOS: not rotated unless `CONDUIT_SERVICE_LOG_MAX_BYTES` is set; Linux: journald's limits |
| Alexa state | In the bridge log directory | The id of the one Alexa conversation | Only with Alexa configured |
| Speech models and runtime | `~/.conduit/models/`, `~/.conduit/speech-runtime/` | Downloaded models and native libraries | Until removed in the app or by the uninstaller |
| CLI histories | Wherever each CLI keeps them (for example `~/.claude`, `~/.codex`) | The CLIs' own conversation records; the bridge continues conversations through them | Not managed by the bridge. Deleting a chat, retention and the uninstaller do not touch them. |

The database is not encrypted by the bridge. Use disk encryption (FileVault, BitLocker, LUKS). With a retention period set, the bridge turns on SQLite's `secure_delete` and truncates the write-ahead log after each purge, so removed rows do not stay readable in free pages of the database file.

`CONDUIT_AUDIT_DETAIL=0` stops storing the input and output of tool steps. The step list itself (tool name, short label, status) remains.

## Engines on company accounts

The bridge drives the command line tools installed on the machine and uses whatever sign-in they have. It holds no AI credentials itself. Which contract applies to prompts and answers depends on how the CLI is signed in, so use the company's accounts:

- **Claude Code.** `claude auth login` signs in with a Claude subscription (Team and Enterprise plans included; `--sso` forces the SSO flow) or, with `--console`, with an Anthropic Console account billed by API usage. Claude Code also accepts an API key through `ANTHROPIC_API_KEY` or an `apiKeyHelper` in its settings, and third-party providers (Amazon Bedrock, Google Vertex AI, Microsoft Foundry) with their own credentials. The bridge passes its environment to the CLI, so a variable in `.env.local` reaches it, but `.env.local` is a plain file. Prefer the CLI's own sign-in or an `apiKeyHelper` in managed settings or in the file named by `CONDUIT_CLAUDE_SETTINGS`. Check the sign-in with `claude auth status`.
- **OpenAI Codex.** `codex login` signs in with a ChatGPT account (use the company workspace), `codex login --with-api-key` with an OpenAI API key read from stdin, `--with-access-token` with an access token. Codex reads `~/.codex/config.toml` (`CODEX_HOME`) for model and further settings.
- **Antigravity (Gemini).** Uses the Google account the `agy` CLI is signed in with.
- **Ollama.** Runs entirely on the machine (or on the host in `OLLAMA_HOST`). Prompts do not leave it. The bridge offers no tools for Ollama: the model only answers in text.

To allow only some engines, switch the others off with `CONDUIT_DISABLED_ENGINES` (for example `gemini,codex`). A switched-off engine shows as unavailable and refuses turns with a message.

## Agent permissions

**Default:** every engine with tools runs without asking. Claude Code gets `--permission-mode bypassPermissions`, Codex `--dangerously-bypass-approvals-and-sandbox`, Antigravity `--dangerously-skip-permissions`. A paired device can therefore do on the computer whatever the user can. Treat pairing as equivalent to shell access.

The settings below restrict this with each CLI's own options. Two rules apply to all of them:

- **Refuse, never ask.** In the bridge nobody can answer a permission prompt. A restricted CLI refuses what is not allowed and continues; the bridge adds a sentence to the answer, for example "Claude was not allowed to use Write on this computer. The bridge's permission settings block this action." The refused step shows as failed in the activity list. The turn does not hang.
- **Fail closed.** An unknown value, a missing settings file or an unknown engine name in `CONDUIT_DISABLED_ENGINES` blocks the affected engines with a message naming the variable. The bridge never falls back to full rights.

Enforcement is done by the CLIs, not by the bridge. Behaviour was checked against Claude Code 2.1.295, codex-cli 0.160.0 and the installed `agy`; other versions may differ.

### Claude Code

| Variable | Passed as | Default |
|---|---|---|
| `CONDUIT_CLAUDE_PERMISSION_MODE` | `--permission-mode` (`acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`). For any mode except `bypassPermissions` the bridge also passes `--permission-prompts none`, so anything that would need a prompt is refused. | `bypassPermissions` |
| `CONDUIT_CLAUDE_ALLOWED_TOOLS` | `--allowedTools`, comma-separated, rule syntax of Claude Code (`Read,Grep,Bash(git status *)`) | empty |
| `CONDUIT_CLAUDE_DISALLOWED_TOOLS` | `--disallowedTools`, same syntax. Denied tools are removed even under `bypassPermissions`. | empty |
| `CONDUIT_CLAUDE_SETTINGS` | `--settings <file>`, an additional Claude Code settings file (permission rules, `apiKeyHelper`, ...) | empty |

The same arguments apply to chats (one-shot and warm process) and to the Alexa skill. Examples:

- Read-only assistant: `CONDUIT_CLAUDE_PERMISSION_MODE=dontAsk`, `CONDUIT_CLAUDE_ALLOWED_TOOLS=Read,Grep,Glob` and `CONDUIT_CLAUDE_DISALLOWED_TOOLS=Bash,Write,Edit,WebFetch,WebSearch`. The deny list matters: in `dontAsk` and `manual` mode Claude Code itself decides which actions need approval and refuses only those. Shell commands it considers harmless still run (in a test, `echo` ran in both modes without an allow rule, while writing a file was refused).
- Full rights without network fetches: keep the default mode and set `CONDUIT_CLAUDE_DISALLOWED_TOOLS=WebFetch,WebSearch`.

Claude Code's managed settings, if the company deploys them, apply in addition to these options.

### Codex

| Variable | Passed as | Default |
|---|---|---|
| `CONDUIT_CODEX_SANDBOX` | `-c sandbox_mode="<value>"` and `-c approval_policy="never"` instead of the bypass flag. Values: `read-only`, `workspace-write`, `danger-full-access`. | empty: no sandbox |

With `approval_policy="never"` Codex never asks; a command the sandbox does not allow fails and the model reports it. The bridge has no structured signal from Codex for a refusal, so the explanation comes from the model's answer. Codex offers no per-tool allow list through the bridge; further rules belong in the user's Codex configuration.

### Antigravity

| Variable | Effect | Default |
|---|---|---|
| `CONDUIT_AGY_PERMISSIONS` | `bypass` passes `--dangerously-skip-permissions`. `settings` omits it: Antigravity then refuses in print mode every action its own `settings.json` does not allow under `permissions.allow`. | `bypass` |
| `CONDUIT_AGY_SANDBOX` | `1` adds `--sandbox` (terminal restrictions as implemented by the CLI) | `0` |

Antigravity has no permission modes or tool lists on its command line. In a test with `settings` and no allow rules, reading a file was allowed and writing one was refused; refused actions are listed in the answer.

### Ollama

No tools, nothing to restrict. Text in, text out.

### Read-only runs

A client can restrict a single message to reading by sending `readOnly: true` with the prompt (it can never widen the rights). Claude then starts with `--permission-mode dontAsk --permission-prompts none --tools Read,Grep,Glob --allowedTools Read,Grep,Glob --strict-mcp-config`: no shell, no file writes, no web access and no MCP server exist in that run, and `bypassPermissions` is never passed. The operator's `CONDUIT_CLAUDE_DISALLOWED_TOOLS` and `CONDUIT_CLAUDE_SETTINGS` still apply on top. Checked against claude 2.1.322: the run lists only Glob, Grep and Read, no MCP server, and a request to write a file or run a command is refused (`CONDUIT_TEST_REAL_CLAUDE=1 node --test test/readonly-real-claude.test.mjs` repeats the check). A warm process is started for one kind of run only; switching between read-only and normal restarts it. Ollama has no tools and runs as usual. Codex and Antigravity refuse a read-only message instead of running it with their usual rights.

Read access itself is not confined to a folder: a read-only run can read whatever the bridge's user can read.

### Spoken replies

The app's conversation mode sends `spoken: true` with the prompt. The bridge then puts a fixed instruction of its own ahead of the prompt the engine sees (`src/spoken.mjs`): answer in one to three plain sentences that read well aloud, and put anything that only works on screen after a line with just `---`. The stored message stays exactly what the user said, and the rights of the run do not change (a warm claude keeps running when a chat switches between talking and typing). `/api/status` announces it as `features.spokenReplies`.

## Emergency stop

`POST /api/emergency-stop` (inside the end-to-end session; the app's Tasks page has the button) stops every running answer of every chat, drops all queued messages, ends the warm processes and a running Alexa question, and refuses every new run until `POST /api/emergency-release`. Open chats get a frame `{ type: "emergency", active }`. The state is kept in `.emergency-stop.json` in the log folder, so it survives a restart of the bridge; if that file cannot be read it counts as pressed. If the file cannot be written (for example a full disk), the bridge empties the existing file instead, which needs no space and reads as pressed after a restart. The bridge writes the file (as released) on its first start, so this fallback is available from then on. Only if not even that works (the file could never be created, for example a disk full since before the first start) the stop holds in memory alone: the answer says `persisted: false`, `/api/status` reports `emergencyStop.unsaved: true` on every read until a later press or the release can save, and the app shows that a restart would lift it. `GET /api/emergency` and `/api/status` (`emergencyStop`) show it. Stopped and refused runs are recorded with the end `emergency` in the journal, also an answer whose result arrives while the stop ends its process (the text that arrived is kept; the same holds for the normal Stop). A state file that exists but cannot be read counts as pressed; if it cannot be created at the first start, `unsaved` is reported from the start.

## Automations (scheduled briefings)

macOS and Linux only (on Windows the feature reports `unsupported_platform`). Off unless `automations.json` exists in the bridge's data folder (`DB_DIR`, by default `~/Library/conduit-bridge`). An automation runs at a local time on chosen weekdays and has three stages:

1. **collect**: your command fetches data. No model is involved. It prints JSON in format version 1: `{"version":1,"sources":[{"id","title","status":"ok|error|truncated","count","newCount","fetchedAt","text"}]}`. The bridge builds the fact header from this itself, so an unreachable source is reported as unavailable and never as "nothing new".
2. **summarize**: Claude writes the briefing in the *scheduled profile*. That means no tool at all (not even Read), no MCP server, no user or project settings and therefore no hooks or plugins from them, no slash commands, and no session to resume. The prompt arrives on stdin. If the CLI's first event shows anything it could act with, the run is stopped (`profile_mismatch`). Every message in a chat created this way runs in the same profile, whatever engine or mode the client asks for.
3. **deliver**: your command gets JSON on stdin (`title`, `date`, `status`, `header`, `summary`, and `full` only with `deliverFull`). Optionally the bridge also sends a Web Push to the owner's installed PWA. The push carries no briefing text.

Rules for the file:
- The file is mode 0600 and owned by the bridge's user, in a folder nobody else can write to.
- Unknown fields are refused, and so is the whole file.
- `collect` and `deliver` are argv arrays, never shell strings. Each program is an absolute path, owned by the bridge's user or root, and not writable by group or others. The bridge checks this again before every run.
- `owner` must be the bridge's account (`PAIR_OWNER_EMAIL`).

Your `deliver` command must send plain text without link previews. The briefing contains other people's text, and a preview would fetch a link from it.

Each automation runs at most once per local date (the IANA `tz`; a time that does not exist on a DST day runs at the first valid minute). It is retried up to 3 times, 10 minutes apart, inside its window (`windowHours`, default 6). It is marked late after 2 hours, with one notice. The emergency stop kills every stage and nothing is delivered. After a restart, a run that was delivering is marked `unknown` instead of being sent again. The bridge does not wake a sleeping Mac. If you need that, use `pmset repeat wakeorpoweron`. The app shows late runs.

Alerts (optional `alerts` block, same file): `{"deliver": [...], "push": true}`. The bridge tells the owner about Claude sign-in trouble (see below) through the deliver command (JSON on stdin with `kind: "alert"`, `title`, `summary`) and, with `push`, a Web Push that opens Today. Each problem is told once until it is resolved. The deliver command is held while the emergency stop is on.

Web Push: VAPID keys come from `CONDUIT_VAPID_PRIVATE_KEY` (read once at start, then removed from the environment so no agent run can see it) or from a private file the bridge creates on first use. If the key changes, push stays off (`vapid_mismatch`) instead of silently invalidating every subscription. Endpoints must be https on port 443 at a known push service, resolve to a public address, and redirects are refused. The native app shells cannot receive Web Push; use your deliver command there.

## Claude sign-in

Two sign-ins can matter on a bridge machine: whatever the bridge's turns run with (`CLAUDE_CODE_OAUTH_TOKEN`, an API key, or the stored login), and the stored claude.ai login that `/login` renews, which terminal sessions, Remote Control and connectors use. Every 30 minutes the bridge runs `claude auth status --json` without its own token and reads the stored login's state and end date (`/api/status` → `claudeLogin`, owner only). Three days before it runs out, when it has run out, when a turn fails on its sign-in, and when a turn never starts (see `CONDUIT_TURN_FIRST_REPLY_MS`), the owner is told once through `alerts` in `automations.json`.

The owner can sign in again from the app: `POST /api/claude-login/start` runs `claude auth login --claudeai` (without the bridge's token, with `BROWSER` set so no browser opens on the machine) and returns the sign-in link; the code the browser shows goes back with `POST /api/claude-login/code` to the waiting CLI's stdin. One attempt at a time, ended after 10 minutes. Neither the link nor the code is logged. A token the bridge runs with is not renewed this way; the alert then names `claude setup-token`. Turn the watch off with `CONDUIT_CLAUDE_LOGIN_WATCH=0`.

## Updates

The bridge checks for a new release every 6 hours (`CONDUIT_SELFUPDATE_INTERVAL_MS`) while idle, downloads it, verifies its Ed25519 signature against the key compiled into the bridge, installs dependencies only from the signed lockfile without install scripts, and restarts under the service manager. A failed install rolls back. There is no setting to accept unsigned packages.

| Variable | Effect | Default |
|---|---|---|
| `CONDUIT_SELFUPDATE` | `1` install, `notify` only report, `0` off | `1` |
| `CONDUIT_UPDATE_PIN` | Install nothing newer than this version, for example `3.0.4`. Releases up to it are installed; a pin below the installed version installs nothing (no downgrade). | empty |
| `CONDUIT_UPDATE_WINDOW` | Install only inside this local time range, for example `02:00-05:00` or `22:00-04:00`. The bridge then checks every 5 minutes and installs at most once per window. | empty |
| `CONDUIT_SELFUPDATE_INTERVAL_MS` | Check interval | 21600000 (6 hours) |
| `CONDUIT_UPDATE_URL` | Update channel URL | `https://app.tryconduit.de/bridge/v3/bridge.tar.gz` |

"Report" means: a release is reported only after its signature verified. It appears in `bridge.log` as `selfupdate_available` or `selfupdate_held` and in the status call as `update.available`. In `notify` mode the package is still downloaded at each check.

An unreadable pin or window, or an unknown `CONDUIT_SELFUPDATE` value, switches to reporting and logs `config_invalid`. An update is never installed because of a typo.

Updates never start while a turn is running.

## Retention and logs

| Variable | Effect | Default |
|---|---|---|
| `CONDUIT_RETENTION_DAYS` | Delete whole chats (messages and audit) whose last activity is older than this many days | `0`: keep |
| `CONDUIT_AUDIT_RETENTION_DAYS` | Delete audit steps older than this many days; the chats stay | `0`: keep |
| `CONDUIT_PASTE_RETENTION_DAYS` | Delete attachments older than this many days | `30` (`0`: keep) |
| `CONDUIT_AUDIT_DETAIL` | `0`: store no tool input or output | `1` |
| `CONDUIT_LOG_MAX_BYTES`, `CONDUIT_LOG_FILES` | Rotation of `bridge.log` (files counted with the current one, at least 2) | 10485760, 5 |
| `CONDUIT_LOG_STDOUT` | `0`: write log lines only to `bridge.log`, not also to stdout (on macOS stdout fills `de.tryconduit.bridge.out.log`) | `1` |
| `CONDUIT_SERVICE_LOG_MAX_BYTES`, `CONDUIT_SERVICE_LOG_FILES` | Rotate every `*.log` file in the service log directory above this size, keeping this many old copies | `0`: off, 3 |
| `CONDUIT_SERVICE_LOG_DIR` | Service log directory | `<DB_DIR>/../logs`, which is `~/.conduit/logs` for an installed bridge |

Retention runs one minute after start and then hourly. Chats with a running or queued turn are skipped until the next run. Service logs are rotated by copying and then truncating the file in place, because launchd keeps it open; lines written in that instant can be lost. On Linux the services log to the user journal; set its limits in `journald.conf`. The Windows tasks write no service logs.

## Uninstall

The uninstall scripts are part of the bridge from 3.0.4 on (`src/uninstall.sh`, `src/uninstall.ps1`; bridges that self-update receive them with the update). Both first list every service and path, then ask.

```bash
bash ~/.conduit/bridge/src/uninstall.sh --dry-run    # show only
bash ~/.conduit/bridge/src/uninstall.sh              # services and program, keep data
bash ~/.conduit/bridge/src/uninstall.sh --purge      # also delete the data
```

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\.conduit\bridge\src\uninstall.ps1" -DryRun
powershell -ExecutionPolicy Bypass -File "$HOME\.conduit\bridge\src\uninstall.ps1" -Purge
```

`--yes` (`-Yes`) skips the question for scripted removal. Without a terminal and without `--yes` the shell script stops without changes.

| | macOS | Linux | Windows |
|---|---|---|---|
| Services | launchd agents `de.tryconduit.bridge`, `de.tryconduit.tunnel` (stopped, plist removed) | systemd user units `conduit-bridge`, `conduit-tunnel` (disabled, stopped, removed) | Scheduled tasks `ConduitBridge`, `ConduitTunnel` (stopped with the node and cloudflared processes they started, unregistered) |
| Program (always) | `~/.conduit/bridge` code and launcher, `tunnel.sh`/`tunnel.ps1`, the tunnel token, a cloudflared the installer downloaded to `~/.conduit/bin` | | |
| Data (`--purge`) | Chat database, identity key, `.env.local`, attachments, `bridge.log*`, Alexa state, service logs, speech models and runtime | | |

Paths set in `.env.local` (`DB_DIR`, `LOG_DIR`, `PASTE_DIR`, `CONDUIT_MODELS_DIR`, ...) are honoured. Not touched: the AI CLIs and their histories, Node.js, a cloudflared installed by Homebrew or winget, and the `loginctl enable-linger` setting the Linux installer made. The tunnel registration in the Conduit cloud remains until the account is deleted.

## Other variables

| Variable | Effect | Default |
|---|---|---|
| `BRIDGE_HOST`, `BRIDGE_PORT` | Listen address; wildcard addresses are refused | `127.0.0.1`, `8787` |
| `PAIR_PORT` | Loopback port of the pairing page | `8788` |
| `PAIR_PUBLIC_HOST` | Tunnel host name (set by the installer); without it pairing is refused | empty |
| `PAIR_OWNER_EMAIL` | Account of the paired devices (set by the installer) | empty |
| `PAIR_APP_BASE`, `CONDUIT_APP_BASE` | App origin, allowed for CORS, and base of the update URL | `https://app.tryconduit.de` |
| `BRIDGE_ALLOWED_HOSTS` | Accepted `Host` headers, comma-separated | empty: not checked |
| `BRIDGE_ALLOWED_ORIGINS` | Additional CORS origins | empty |
| `CLAUDE_BIN`, `CLAUDE_MODEL`, `CLAUDE_ALEXA_MODEL` | Claude Code binary and models | `~/.local/bin/claude`, `opus` (family alias: opus, sonnet, haiku, fable), `haiku` |
| `CLAUDE_CWD` | Default working directory of chats | home directory |
| `FILE_SEARCH_ROOTS` | Colon-separated roots for @-mentions and the working directory picker. Not a sandbox: it limits what the app offers, not what an agent can reach. | `CLAUDE_CWD` |
| `CODEX_BIN`, `CODEX_MODEL`, `CODEX_HOME` | Codex binary, model, configuration directory | searched, from `config.toml`, `~/.codex` |
| `AGY_BIN`, `AGY_MODEL` | Antigravity binary and model | `~/.local/bin/agy`, first model listed by `agy models` |
| `OLLAMA_HOST`, `OLLAMA_MODEL` | Ollama service and default model | `http://127.0.0.1:11434`, first installed |
| `CONDUIT_WARM`, `CONDUIT_WARM_MAX`, `CONDUIT_WARM_IDLE_MS` | Long-lived Claude processes per chat | on, 4, 480000 |
| `CONDUIT_MAX_CONCURRENT_TURNS` | Turns running at once | max(4, 2 x `CONDUIT_WARM_MAX`) |
| `CONDUIT_MAX_RUNTIME_SESSIONS` | Chats held in memory | 200 |
| `CONDUIT_TURN_STALL_MS` | End a turn after this long without output | 900000 |
| `CONDUIT_TURN_STARTUP_MS` | End a Claude turn whose process printed nothing this long after launch (0 = off) | 90000 |
| `CONDUIT_TURN_FIRST_REPLY_MS` | End a warm Claude turn that took the prompt but showed no model activity (stream event, message, result or API retry notice; status events do not count, a running hook allows up to 10 minutes) this long (0 = off) | 180000 |
| `CONDUIT_CLAUDE_LOGIN_WATCH` | `0` turns the sign-in watch and phone sign-in off | on |
| `CONDUIT_MAX_TURN_MS` | Hard limit per turn | `0`: none |
| `CONDUIT_ORPHAN_GRACE_MS` | Optional safety limit: stop a running turn once no app has been connected to the bridge (any chat) for this long; values below 60000 are raised to 60000 (recorded as an error, never as finished) | 0 (off) |
| `CONDUIT_JOURNAL_DIR` | Folder for the automatic Markdown journal, one file per chat (created 0700 if missing; an existing folder keeps its mode; files 0600) | `<DB_DIR>/journal` |
| `CONDUIT_JOURNAL` | `0` turns the journal and agent checkpoints off | on |
| `CONDUIT_AUDIT_INPUT_CAP`, `CONDUIT_AUDIT_OUTPUT_CAP` | Stored characters per tool step | 4000, 6000 |
| `DB_DIR`, `LOG_DIR`, `PASTE_DIR` | Database, log and attachment directories | `~/Library/conduit-bridge` (installer: `~/.conduit/bridge`), `~/Library/Logs/conduit-bridge`, `~/Library/conduit-bridge/pastes` |
| `CONDUIT_IDENTITY_PATH` | Bridge private key | `<DB_DIR>/identity.key` |
| `CONDUIT_MODELS_DIR`, `CONDUIT_SPEECH_RUNTIME_DIR`, `CONDUIT_MODELS_URL` | Speech models, runtime, download base | `~/.conduit/models`, `~/.conduit/speech-runtime`, the GitHub releases of this repository |
| `ALEXA_SKILL_ID`, `ALEXA_USER_ID` | Optional own Alexa skill | empty: endpoint answers 503 |
| `ALEXA_SPEAKER` | Sonos player id (`RINCON_…`). An Alexa question that takes longer than Alexa waits keeps running; the answer is read aloud on this player with the bridge's German voice, which must be installed. A room name is not accepted as binding: the bridge then stays off and logs the ids of the players in that room (`alexa_speaker_needs_player_id`, voice speaker first). | empty: off |
| `ALEXA_SPEAKER_VOLUME`, `ALEXA_SPEAKER_VOICE` | Volume of the clip (1-100), voice id | `40`, the first German voice |
| `ALEXA_TASK_TIMEOUT_MS` | How long a question handed to the speaker may run | 600000 |
| `CONDUIT_SUPERVISED` | `1` tells the bridge a service manager restarts it (set by `install.sh`) | detected |

## Known limits

- No single sign-on, central administration or role model. Each person pairs their own devices with their own bridge.
- The app's interface is loaded from app.tryconduit.de at every start; the end-to-end encryption protects the transport, not against a compromised web deployment.
- The optional Alexa speaker (`ALEXA_SPEAKER`) is bound to one player id set by the operator. An answer is played only on a speaker whose certificate is signed by the Sonos device CA and issued to exactly that player, checked before anything is sent, and the clip is served only to that speaker's address. Sonos does not publish this CA; its public key is pinned in the bridge, recovered from genuine player certificates (`tools/sonos-device-ca/`, reproducible with your own speakers). The answer travels the local network as plain HTTP (Sonos fetches clips that way), so a device that can read the local network traffic can hear it too.
- The audit trail is a record for the user, stored locally and deletable by the user. It is not a tamper-evident compliance log; forward it off the machine if one is needed.
- When the installer downloads cloudflared itself, it takes a fixed release (2026.10.0) and checks its SHA-256; if Homebrew (macOS) or winget (Windows) is present, cloudflared comes from there without this pin. The Claude Code CLI is installed in a fixed version (2.1.295) only when no `claude` is present yet. Companies that need their own versions install both beforehand; the installer then uses what it finds.
