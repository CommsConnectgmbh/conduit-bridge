# Conduit Bridge

The part of [Conduit](https://tryconduit.de) that runs on your own computer. It connects the Conduit apps to your AI tools: Claude Code, Gemini through Antigravity, OpenAI Codex, or a local model through Ollama. Chat history is stored locally in SQLite.

The bridge runs on macOS, Linux and Windows with Node.js 22.5 or newer.

## Install

Open the [Conduit app](https://app.tryconduit.de) and follow its setup instructions. The app provides a one-line install command with a single-use setup code.

The installer (`install.sh` or `install.ps1`):

- Verifies the bridge package's Ed25519 signature.
- Installs dependencies with `npm ci --ignore-scripts`.
- Sets up the Cloudflare tunnel and autostart through launchd, a systemd user service, or a Windows scheduled task.
- Opens the local pairing page.

## Security

Pair each device once using the QR code or link on the loopback-only pairing page.

App-to-bridge traffic is end-to-end encrypted using Noise: `Noise_IKpsk1` for pairing and `Noise_IK` for reconnects, with X25519, AES-GCM and SHA-256. Framed channels provide flow control.

The tunnel and Conduit cloud see ciphertext and connection metadata. The cloud holds no key to the bridge. Unencrypted `/api` and `/ws` access through the public port is refused.

Self-updates accept only packages signed with the pinned release key. See [RELEASE_SIGNING.md](RELEASE_SIGNING.md).

Report security issues to [hi@tryconduit.de](mailto:hi@tryconduit.de).

## Settings for companies

All settings are environment variables in `.env.local` in the bridge directory. Without them the bridge behaves as before. [docs/ENTERPRISE.md](docs/ENTERPRISE.md) lists every variable, the network connections, the local data and how to run the engines on company accounts.

- **Agent permissions.** By default Claude Code, Codex and Antigravity run every tool without asking. `CONDUIT_CLAUDE_PERMISSION_MODE`, `CONDUIT_CLAUDE_ALLOWED_TOOLS`, `CONDUIT_CLAUDE_DISALLOWED_TOOLS`, `CONDUIT_CLAUDE_SETTINGS`, `CONDUIT_CODEX_SANDBOX`, `CONDUIT_AGY_PERMISSIONS`, `CONDUIT_AGY_SANDBOX` and `CONDUIT_DISABLED_ENGINES` restrict them with the options of each CLI. A refused tool call is reported in the answer. An invalid value blocks the engine.
- **Updates.** `CONDUIT_SELFUPDATE=notify` only reports a newer release, `CONDUIT_UPDATE_PIN` installs nothing newer than a given version, and `CONDUIT_UPDATE_WINDOW` limits installs to a time range. The signature check always applies.
- **Local data.** `CONDUIT_RETENTION_DAYS`, `CONDUIT_AUDIT_RETENTION_DAYS` and `CONDUIT_PASTE_RETENTION_DAYS` set retention periods. `CONDUIT_LOG_*` and `CONDUIT_SERVICE_LOG_*` control log rotation.

## Uninstall

The bridge ships an uninstaller for each platform. It lists everything before removing anything. By default it removes the services and the program and keeps chats, keys, configuration, logs and models. Add `--purge` (`-Purge` on Windows) to delete them too, or use `--dry-run` (`-DryRun`) to only see the list.

```bash
bash ~/.conduit/bridge/src/uninstall.sh            # macOS, Linux
```

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\.conduit\bridge\src\uninstall.ps1"   # Windows
```

## Local speech

Optional speech recognition and synthesis run on your computer:

- **Recognition:** Parakeet TDT 0.6B v3 through sherpa-onnx.
- **German voice:** Thorsten through Kokoro and ONNX Runtime.
- **American English voices:** Heart, Bella, Nicole, Sarah, Michael, Fenrir and Puck through Kokoro and ONNX Runtime.
- **Pronunciation:** eSpeak NG 1.52.0 compiled to WebAssembly, with German and English frontends ported from the Python originals.

Models and pronunciation files are downloaded on demand and pinned by SHA-256. Native runtime dependencies use exact versions and integrity hashes from the signed bridge package. Speech support depends on the operating system and CPU architecture; see [speech-runtime.mjs](src/speech-runtime.mjs).

The parity tools compare pronunciation against the Python originals. The [German results](tools/parity-de/PARITY.md) document Unicode differences and deliberate reading changes. English checks are in [tools/parity-en](tools/parity-en).

## Development

```bash
npm install
npm test
npm start
```

`npm test` runs the suite with Node's built-in test runner. Use `npm run dev` to restart the server when source files change.

Build a release package with:

```bash
node scripts/build-release.mjs --out <output-directory>
```

Sign the package before publishing it. See [RELEASE_SIGNING.md](RELEASE_SIGNING.md) for signing and release-channel instructions.

The [tools](tools/) directory contains the eSpeak NG WebAssembly build, English pronunciation-data export and parity tests. Python reference and export steps require Python 3.12 with the original packages. These tools are excluded from the bridge release package.

## License

The bridge's own code is licensed under [MIT](LICENSE). Speech components and generated files carry additional licenses, including Apache-2.0, LGPL-2.1-or-later and GPL-3.0-or-later.

When GPL-licensed files are distributed with the bridge, the combined package is distributed under GPL-3.0-or-later; the MIT license of the other files remains unchanged. Downloaded models have their own licenses.

See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and [licenses](licenses/) for details.
