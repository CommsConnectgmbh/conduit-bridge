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
| AI CLIs | Their vendors (Anthropic, OpenAI, Google) | The model calls | Per turn, under the CLI's own sign-in |
| installer | `app.tryconduit.de`, the Conduit cloud API, GitHub (cloudflared download if not installed), npm | Installation | Once |

Apart from the update download from app.tryconduit.de, the bridge makes no calls to Conduit's servers at runtime. App traffic through the tunnel is end-to-end encrypted (Noise, see the README); the tunnel and the cloud see ciphertext and connection metadata.

Model downloads and the speech runtime are pinned by SHA-256 in the signed bridge package, so a mirror can be used: host the same files under `<mirror>/<model id>/<file name>` and set `CONDUIT_MODELS_URL`. A company npm registry configured for the user also serves the speech runtime and update dependencies; their integrity hashes come from the signed lockfile.

## What is stored locally

Paths for an installation by `install.sh`; on Windows the same names under `%USERPROFILE%`.

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
| `CLAUDE_BIN`, `CLAUDE_MODEL`, `CLAUDE_ALEXA_MODEL` | Claude Code binary and models | `~/.local/bin/claude`, `claude-opus-5`, `haiku` |
| `CLAUDE_CWD` | Default working directory of chats | home directory |
| `FILE_SEARCH_ROOTS` | Colon-separated roots for @-mentions and the working directory picker. Not a sandbox: it limits what the app offers, not what an agent can reach. | `CLAUDE_CWD` |
| `CODEX_BIN`, `CODEX_MODEL`, `CODEX_HOME` | Codex binary, model, configuration directory | searched, from `config.toml`, `~/.codex` |
| `AGY_BIN`, `AGY_MODEL` | Antigravity binary and model | `~/.local/bin/agy`, `gemini-3.1-pro-high` |
| `OLLAMA_HOST`, `OLLAMA_MODEL` | Ollama service and default model | `http://127.0.0.1:11434`, first installed |
| `CONDUIT_WARM`, `CONDUIT_WARM_MAX`, `CONDUIT_WARM_IDLE_MS` | Long-lived Claude processes per chat | on, 4, 480000 |
| `CONDUIT_MAX_CONCURRENT_TURNS` | Turns running at once | max(4, 2 x `CONDUIT_WARM_MAX`) |
| `CONDUIT_MAX_RUNTIME_SESSIONS` | Chats held in memory | 200 |
| `CONDUIT_TURN_STALL_MS` | End a turn after this long without output | 900000 |
| `CONDUIT_MAX_TURN_MS` | Hard limit per turn | `0`: none |
| `CONDUIT_AUDIT_INPUT_CAP`, `CONDUIT_AUDIT_OUTPUT_CAP` | Stored characters per tool step | 4000, 6000 |
| `DB_DIR`, `LOG_DIR`, `PASTE_DIR` | Database, log and attachment directories | `~/Library/conduit-bridge` (installer: `~/.conduit/bridge`), `~/Library/Logs/conduit-bridge`, `~/Library/conduit-bridge/pastes` |
| `CONDUIT_IDENTITY_PATH` | Bridge private key | `<DB_DIR>/identity.key` |
| `CONDUIT_MODELS_DIR`, `CONDUIT_SPEECH_RUNTIME_DIR`, `CONDUIT_MODELS_URL` | Speech models, runtime, download base | `~/.conduit/models`, `~/.conduit/speech-runtime`, the GitHub releases of this repository |
| `ALEXA_SKILL_ID`, `ALEXA_USER_ID` | Optional own Alexa skill | empty: endpoint answers 503 |
| `CONDUIT_SUPERVISED` | `1` tells the bridge a service manager restarts it (set by `install.sh`) | detected |

## Known limits

- No single sign-on, central administration or role model. Each person pairs their own devices with their own bridge.
- The app's interface is loaded from app.tryconduit.de at every start; the end-to-end encryption protects the transport, not against a compromised web deployment.
- The audit trail is a record for the user, stored locally and deletable by the user. It is not a tamper-evident compliance log; forward it off the machine if one is needed.
- When the installer downloads cloudflared itself, it takes a fixed release (2026.10.0) and checks its SHA-256; if Homebrew (macOS) or winget (Windows) is present, cloudflared comes from there without this pin. The Claude Code CLI is installed in a fixed version (2.1.295) only when no `claude` is present yet. Companies that need their own versions install both beforehand; the installer then uses what it finds.
