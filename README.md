# OMP-Wechat

Bridge WeChat messages to [OMP (Oh My Pi)](https://omp.sh) / [Pi](https://pi.dev) — receive WeChat messages, process them with OMP/Pi's AI engine, and reply back automatically.

Uses the [Tencent iLink Bot API](https://www.wechatbot.dev/zh/protocol) (the official WeChat personal-account Bot API behind ClawBot) for message transport, and the OMP/Pi SDK as the AI brain.

## How It Works

```
WeChat user → iLink Bot API → [OMP/Pi process] → SDK → AI provider
                                  ↑                         │
                                  └──── reply ← message_end ─┘
```

The extension runs **inside** the OMP/Pi process. On `session_start`, the iLink long-poll loop starts in-process as a background promise. A singleton port lock ensures only one process runs the poll loop at a time — other OMP/Pi processes standby with a 30s failover timer to take over if the lock holder crashes.

For boot-time persistence, install a launchd/systemd service via `/wechat install`. The service runs `omp --mode rpc` (or `pi --mode rpc`) with `KeepAlive`/`Restart=always`, so the host (and the poll loop) survive crashes and reboots.

- **No external `bun` required** — OMP/Pi is a standalone binary with an embedded runtime
- **Singleton** — port lock guarantees one poll loop across all concurrent OMP/Pi processes
- **Failover** — non-lock-holder processes check every 30s and take over if the lock holder dies
- **iLink layer**: long-polls `getupdates` for inbound messages, sends replies via `sendmessage`
- **AI engine**: one in-memory session per WeChat chat, prompts injected via `session.prompt()`
- **Typing indicator**: shows "Typing..." on WeChat while the model is thinking
- **Access control**: pairing-based — strangers must pair before their messages are delivered

## Features

- **OMP/Pi extension**: installs via `omp plugin link .` or `pi plugin link .`, auto-starts poll loop on `session_start`
- **Slash commands**: `/wechat login`, `/wechat status`, `/wechat pair`, `/wechat allow`, `/wechat revoke`, `/wechat list`, `/wechat stop`, `/wechat install`, `/wechat uninstall`
- **Singleton**: port lock guarantees one poll loop across all concurrent OMP/Pi processes — no duplicate replies
- **Failover**: 30s timer takes over automatically if the lock holder crashes
- **Bidirectional**: receive and reply to WeChat text messages
- **Per-chat sessions**: each WeChat chat gets an independent AI session (concurrent, isolated)
- **LRU pool**: caps memory usage by evicting least-recently-used sessions (default: 50)
- **Typing indicator**: native WeChat "Typing..." shown during AI processing
- **Access control**: pairing / allowlist / disabled modes
- **Long text chunking**: splits replies >2000 chars at paragraph/line/space boundaries
- **Boot service**: optional launchd/systemd service for auto-start on boot

## Quick Start

### Prerequisites

- [OMP](https://omp.sh) or [Pi](https://pi.dev) installed and authenticated (`omp login` / `pi login`)
- WeChat (latest iOS version with ClawBot support)

### Install

```bash
git clone https://github.com/mentalfl0w/omp-wechat.git OMP-Wechat
cd OMP-Wechat
bun install          # build dependency only
bun run build
omp plugin link .    # or: pi plugin link .
```

This links the extension into OMP/Pi. The poll loop starts automatically on your next `session_start`.

### Login (scan QR code)

```
/wechat login
```

A QR code appears in the terminal. Scan it with WeChat and confirm on your phone. Credentials are saved to `~/.omp-wechat/credentials.json`.

### Run

No explicit run command needed — the poll loop auto-starts on `session_start`. Once running, send a message to the bot on WeChat — it will be processed and the reply sent back.

To check status: `/wechat status`. To stop: `/wechat stop`.

### Boot-time auto-start (optional)

```
/wechat install
```

Installs a launchd (macOS) or systemd (Linux) service that runs the host (`omp --mode rpc` or `pi --mode rpc`) at boot. The host stays alive via `KeepAlive`/`Restart=always`, keeping the poll loop running across crashes and reboots.

Logs: `~/.omp-wechat/logs/rpc.log`
Manage: `launchctl start|stop com.omp-wechat` (macOS) or `sudo systemctl start|stop omp-wechat` (Linux)

To remove: `/wechat uninstall`

## Configuration

Configuration is loaded from `~/.omp-wechat/config.yml`, falling back to built-in defaults. Model, working directory, and tools are inherited from the OMP/Pi session automatically.

```yaml
# ~/.omp-wechat/config.yml
maxSessions: 50
dmPolicy: pairing
model: "@smol"              # default model (role alias or provider/id)
systemPrompt: |
  You are an AI assistant chatting via WeChat.
  Keep replies concise and in plain text.
```

| Field | Default | Description |
|---|---|---|
| `maxSessions` | `50` | Session pool cap (LRU eviction) |
| `dmPolicy` | `pairing` | Access policy: `pairing` / `allowlist` / `disabled` |
| `model` | OMP default | Default model: role alias (`@smol`, `@slow`) or `provider/id` |
| `systemPrompt` | Built-in | System prompt for WeChat chat sessions |
> **Model, working directory, and tools are managed by OMP/Pi.** `createAgentSession()` automatically calls `discoverAuthStorage()`, reusing your existing `omp login` / `pi login` OAuth, `~/.omp/agent/agent.db` API keys, or `models.yml` config. This project never touches API keys.

## Slash Commands

| Command | Description |
|---|---|
| `/wechat login` | Scan QR code to log in |
| `/wechat status` | Show poll loop state, session pool, boot service, authorized users |
| `/wechat pair <code>` | Approve a pairing request |
| `/wechat allow <wxid>` | Directly authorize a user |
| `/wechat revoke <wxid>` | Revoke a user's authorization |
| `/wechat list` | List authorized users |
| `/wechat stop` | Stop the poll loop |
| `/wechat install` | Install boot-time launchd/systemd service |
| `/wechat uninstall` | Remove boot-time service |

### Chat Commands (via WeChat message)

| Command | Description |
|---|---|
| `/model` | Show current AI model |
| `/models` | List all available models |
| `/model provider/id` | Switch model for this chat (e.g. `/model anthropic/claude-haiku-4-5`) |

## Access Control

| Mode | Behavior |
|---|---|
| `pairing` (default) | Unknown senders get a pairing code; they must be approved via `/wechat pair <code>` |
| `allowlist` | Only users in the allowlist can send messages; others are silently dropped |
| `disabled` | All inbound messages are dropped |

The logged-in user (who scanned the QR code) is automatically added to the allowlist.

## Lifecycle

| Scenario | Behavior |
|---|---|
| Host process starts | Poll loop starts automatically (acquires singleton lock) |
| Other host processes | Standby with 30s failover timer, take over if lock holder dies |
| Host process exits | Poll loop stops, lock released, all sessions disposed |
| Host crashes | Failover timer in another process detects dead lock and takes over; or launchd/systemd restarts the host (if `/wechat install` was run) |
| Machine reboots | Service auto-starts the host (if installed), poll loop resumes |
| No boot service | Poll loop only runs while a host process is active |

Logs: `~/.omp-wechat/logs/daemon.log` (poll loop) and `~/.omp-wechat/logs/rpc.log` (boot service RPC output)

## Project Structure

```
OMP-Wechat/
├── package.json              # omp.extensions / pi.extensions manifest
├── src/
│   ├── index.ts              # OMP/Pi extension entry (session_start + /wechat commands)
│   ├── bridge.ts             # In-process poll loop + message handling + singleton port lock
│   ├── service.ts            # Boot-time launchd/systemd install
│   ├── config.ts             # Config loading (config.yml + defaults)
│   ├── ilink/
│   │   ├── types.ts          # iLink Bot API type definitions
│   │   ├── client.ts         # iLink API client (poll/send/typing)
│   │   └── login.ts          # QR code login flow
│   ├── engine/
│   │   ├── session.ts        # AI session creation + reply subscription
│   │   └── pool.ts           # Session pool (LRU eviction, concurrency)
│   ├── access/
│   │   └── control.ts        # Access control (pairing/allowlist/disabled)
│   ├── utils/
│   │   ├── chunk.ts          # Long text chunking
│   │   └── logger.ts         # stderr + file logger
│   └── types/
│       └── qrcode-terminal.d.ts
├── dist/                     # Built output (index.js)
└── README.md
```

## Limitations

- **Reply-only**: iLink requires `context_token` from an inbound message; you cannot initiate conversations
- **1:1 only**: iLink Bot API does not support group chats
- **Single instance**: iLink allows only one bot connection per account
- **Text only (Phase 1)**: images/voice/video are represented as `(image)` / `(voice)` placeholders; media support is planned

## Roadmap

- [ ] **Phase 2**: Media support (inbound images as base64, voice transcription)
- [x] **Phase 3**: Persistent sessions — `SessionManager.continueRecent()` per chat, context survives restarts
- [x] **Phase 4**: Per-chat model selection — `/model` `/models` chat commands for manual switching
- [ ] **Phase 5**: Fine-grained permissions (per-user tool restrictions, bash approval via WeChat)

## License

MIT
