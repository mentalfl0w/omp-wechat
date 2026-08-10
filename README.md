# OMP-Wechat

Bridge WeChat messages to [OMP (Oh My Pi)](https://omp.sh) / [Pi](https://pi.dev) — receive WeChat messages, process them with OMP/Pi's AI engine, and reply back automatically.

Uses the [Tencent iLink Bot API](https://www.wechatbot.dev/zh/protocol) (the official WeChat personal-account Bot API behind ClawBot) for message transport, and the OMP/Pi SDK as the AI brain.

## How It Works

```
WeChat user → iLink Bot API → [OMP/Pi process] → SDK → AI provider
                                  ↑                         │
                                  └──── reply ← message_end ─┘
```

The extension runs **inside** the OMP/Pi process. The iLink long-poll loop starts at extension load time (not `session_start`) as a background promise. A singleton port lock ensures only one process runs the poll loop at a time — other OMP/Pi processes standby with a 30s failover timer to take over if the lock holder crashes.

For boot-time persistence, install a launchd/systemd service via `/wechat install`. The service runs `omp --mode rpc` (or `pi --mode rpc`) with a `get_state` JSON-RPC heartbeat piped to stdin every 5s — without an active RPC client, `omp --mode rpc` exits on idle stdin, so the heartbeat keeps the process alive. `KeepAlive`/`Restart=always` handles crashes and reboots.

- **No external `bun` required** — OMP/Pi is a standalone binary with an embedded runtime
- **Singleton** — port lock guarantees one poll loop across all concurrent OMP/Pi processes
- **Failover** — non-lock-holder processes check every 30s and take over if the lock holder dies
- **iLink layer**: long-polls `getupdates` for inbound messages, sends replies via `sendmessage`
- **AI engine**: one in-memory session per WeChat chat, prompts injected via `session.prompt()`
- **Typing indicator**: shows "Typing..." on WeChat while the model is thinking
- **Access control**: pairing-based — strangers must pair before their messages are delivered

## Features

- **OMP/Pi extension**: installs via `omp plugin link .` or `pi plugin link .`, auto-starts poll loop at extension load time
- **Slash commands**: `/wechat login`, `/wechat status`, `/wechat pair`, `/wechat allow`, `/wechat revoke`, `/wechat list`, `/wechat stop`, `/wechat install`, `/wechat uninstall`
- **Singleton**: port lock guarantees one poll loop across all concurrent OMP/Pi processes — no duplicate replies
- **Failover**: 30s timer takes over automatically if the lock holder crashes
- **Bidirectional**: receive and reply to WeChat text messages
- **Image recognition**: inbound images are downloaded from WeChat CDN, AES-decrypted, and passed to the vision model
- **Inbound file content**: text files (`.txt/.md/.csv/.json/.py/…`) sent by the user are downloaded, decrypted, and their content is handed to the AI; binary files arrive as metadata placeholders
- **Markdown stripping**: AI replies are stripped of markdown formatting before delivery — WeChat renders plain text only
- **File delivery**: AI-generated files (documents, images, PDFs, spreadsheets, code…) written to a per-chat outbox directory are automatically uploaded to the WeChat CDN (AES-128-ECB encrypted) and sent back to the user as file/image messages
- **Per-chat sessions**: each WeChat chat gets an independent AI session (concurrent, isolated)
- **LRU pool**: caps memory usage by evicting least-recently-used sessions (default: 50)
- **Typing indicator**: native WeChat "Typing..." shown during AI processing
- **Access control**: pairing / allowlist / disabled modes
- **Long text chunking**: splits replies >2000 chars at paragraph/line/space boundaries
- **Boot service**: optional launchd/systemd/Task Scheduler service for auto-start on boot

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

This links the extension into OMP/Pi. The poll loop starts at extension load time — no `session_start` required.

### Login (scan QR code)

```
/wechat login
```

A QR code appears in the terminal. Scan it with WeChat and confirm on your phone. Credentials are saved to `~/.omp-wechat/credentials.json`.

### Run

No explicit run command needed — the poll loop starts at extension load time. Once running, send a message to the bot on WeChat — it will be processed and the reply sent back.

To check status: `/wechat status`. To stop: `/wechat stop`.

### Boot-time auto-start (optional)

```
/wechat install
```

Installs a launchd (macOS), systemd (Linux), or Task Scheduler (Windows) service that runs the host (`omp --mode rpc` or `pi --mode rpc`) at boot (macOS/Linux) or user logon (Windows). A `get_state` JSON-RPC heartbeat is piped to stdin every 5s to keep the process alive (without an active RPC client, `omp --mode rpc` exits on idle stdin). launchd `KeepAlive`/systemd `Restart=always`/PowerShell restart-loop handles crashes. On Windows, the task uses `/sc onlogon` (no admin required); the host starts when the user logs in, not at bare-metal boot.

Logs: `~/.omp/logs/rpc.log` (stderr only; stdout discarded) and `~/.omp/logs/wechat.log` (poll loop)
Manage:
- macOS: `launchctl start|stop com.omp-wechat`
- Linux: `sudo systemctl start|stop omp-wechat`
- Windows: `schtasks /run|/end /tn OMP-Wechat`

To remove: `/wechat uninstall`

## Configuration

Configuration is loaded from `~/.omp-wechat/config.yml`, falling back to built-in defaults.

```yaml
# ~/.omp-wechat/config.yml
maxSessions: 50
dmPolicy: pairing
model: "@smol"              # default model (role alias or provider/id)
cwd: ~/projects/my-app      # working directory for AI sessions
systemPrompt: |
  You are an AI assistant chatting via WeChat.
  Keep replies concise and in plain text.
```

| Field | Default | Description |
|---|---|---|
| `maxSessions` | `50` | Session pool cap (LRU eviction) |
| `dmPolicy` | `pairing` | Access policy: `pairing` / `allowlist` / `disabled` |
| `model` | OMP default | Default model: role alias (`@smol`, `@slow`) or `provider/id` |
| `cwd` | `process.cwd()` | Working directory for AI sessions — determines which project context (CLAUDE.md, .omp/) the agent loads |
| `systemPrompt` | Built-in | System prompt for WeChat chat sessions |
| `outboxDir` | `~/.omp-wechat/outbox` | Base directory for per-chat outboxes (see File Delivery below) |
| `maxFileSizeMb` | `100` | Max file size delivered via WeChat, in MB |
| `sendFiles` | `true` | Set to `false` to disable file delivery entirely |

> **Model and tools are managed by OMP/Pi.** `createAgentSession()` automatically calls `discoverAuthStorage()`, reusing your existing `omp login` / `pi login` OAuth, `~/.omp/agent/agent.db` API keys, or `models.yml` config. This project never touches API keys.
>
> **Image recognition** requires a vision model role configured in OMP (e.g. `omp model role vision xfyun/xopkimik25`). If no vision role is set, inbound images are skipped — only the text placeholder is sent to the AI.

## File Delivery

Ask the AI to generate a file (report, PDF, spreadsheet, image, code, …) — the finished artifact is sent back to you as a WeChat file or image message automatically.

### How it works

1. Every chat gets a private **outbox directory**: `~/.omp-wechat/outbox/<wxid>/`
2. The session's system prompt teaches the AI to write final deliverables there (and only there)
3. When the AI finishes a turn, the plugin diffs the outbox and uploads every new/changed file:
   - `getuploadurl` → CDN upload (AES-128-ECB encrypted) → `sendmessage` as a file item
   - Images (`.png/.jpg/.jpeg/.gif/.webp/.bmp`) are auto-routed to image messages; everything else goes as a file
4. Delivered files are removed from the outbox; failed or oversized files stay on disk and a text notice is sent instead

### Example

> **You**: Please generate a weekly report as a PDF
> **AI**: *(writes `weekly-report.pdf` to the outbox)* Done — the report is attached.
> **You** (WeChat): receives the text reply **plus** the `weekly-report.pdf` file

### Limitations

- Files are sent via `sendmessage` using the latest inbound `context_token`, same as text replies — an expired token (long-running task, restart) may fail delivery until you message again
- Files larger than `maxFileSizeMb` are skipped with a text notice
- Only files in the per-chat outbox are ever sent — the AI cannot exfiltrate arbitrary paths

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
| `/wechat install` | Install boot-time launchd/systemd/Task Scheduler service |
| `/wechat uninstall` | Remove boot-time service |

### Chat Commands (via WeChat message)

| Command | Description |
|---|---|
| `/model` | Show current AI model |
| `/models` | List all available models |
| `/model provider/id` | Switch model for this chat (e.g. `/model anthropic/claude-haiku-4-5`) |
| `/new` | Reset session — clear context and start fresh |

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
| Host process starts | Poll loop starts at extension load time (acquires singleton lock) |
| Other host processes | Standby with 30s failover timer, take over if lock holder dies |
| Host process exits | Poll loop stops, lock released, all sessions disposed |
| Host crashes | Failover timer in another process detects dead lock and takes over; or launchd/systemd/Task Scheduler restarts the host (if `/wechat install` was run) |
| Machine reboots | macOS/Linux: service auto-starts at boot; Windows: service starts at user logon (if installed), poll loop resumes |
| No boot service | Poll loop only runs while a host process is active |

Logs: `~/.omp/logs/wechat.log` (poll loop) and `~/.omp/logs/rpc.log` (boot service stderr)

## Project Structure

```
OMP-Wechat/
├── package.json              # omp.extensions / pi.extensions manifest
├── src/
│   ├── index.ts              # OMP/Pi extension entry (extension load + /wechat commands)
│   ├── bridge.ts             # In-process poll loop + message handling + singleton port lock
│   ├── service.ts            # Boot-time launchd/systemd/Task Scheduler install
│   ├── config.ts             # Config loading (config.yml + defaults)
│   ├── ilink/
│   │   ├── types.ts          # iLink Bot API type definitions
│   │   ├── client.ts         # iLink API client (poll/send/typing)
│   │   ├── upload.ts         # Outbound media: CDN upload + file/image send
│   │   ├── cdn.ts            # CDN media download/upload + AES-128-ECB crypto
│   │   └── login.ts          # QR code login flow
│   ├── engine/
│   │   ├── session.ts        # AI session creation + reply/outbox subscription
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

- **Reply-only**: iLink requires `context_token` from an inbound message; you cannot initiate conversations (applies to text and file replies alike)
- **1:1 only**: iLink Bot API does not support group chats
- **Single instance**: iLink allows only one bot connection per account
- **Media**: inbound images and text files are fully processed (vision model / content extraction); voice (unless the server provides transcription) and video remain as placeholders

## Roadmap

- [x] **Phase 2a**: Inbound image support (CDN download + AES decrypt + vision model)
- [ ] **Phase 2b**: Voice transcription / video support
- [x] **Phase 2c**: Outbound file delivery — AI-generated files sent back via WeChat (CDN upload + file/image messages)
- [x] **Phase 2d**: Inbound file content extraction + markdown stripping for replies
- [x] **Phase 3**: Persistent sessions — `SessionManager.continueRecent()` per chat, context survives restarts
- [x] **Phase 4**: Per-chat model selection — `/model` `/models` chat commands for manual switching
- [ ] **Phase 5**: Fine-grained permissions (per-user tool restrictions, bash approval via WeChat)

## License

MIT
