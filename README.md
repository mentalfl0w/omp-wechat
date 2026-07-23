# OMP-Wechat

Bridge WeChat messages to [OMP (Oh My Pi)](https://omp.sh) — receive WeChat messages, process them with OMP's AI engine, and reply back automatically.

Uses the [Tencent iLink Bot API](https://www.wechatbot.dev/zh/protocol) (the official WeChat personal-account Bot API behind ClawBot) for message transport, and the OMP SDK as the AI brain.

## How It Works

```
WeChat user → iLink Bot API → [OMP-Wechat] → OMP SDK → AI provider
                                  ↑                              │
                                  └──── reply ← message_end ─────┘
```

- **iLink layer**: long-polls `getupdates` for inbound messages, sends replies via `sendmessage`
- **OMP engine**: one in-memory session per WeChat chat, prompts injected via `session.prompt()`
- **Typing indicator**: shows "对方正在输入..." while the model is thinking
- **Access control**: pairing-based — strangers must pair via terminal before their messages are delivered

## Features

- **Bidirectional**: receive and reply to WeChat text messages
- **Per-chat sessions**: each WeChat chat gets an independent OMP session (concurrent, isolated)
- **LRU pool**: caps memory usage by evicting least-recently-used sessions (default: 50)
- **Typing indicator**: native WeChat "typing..." shown during AI processing
- **Access control**: pairing / allowlist / disabled modes
- **Long text chunking**: splits replies >2000 chars at paragraph/line/space boundaries
- **Cross-platform daemon**: auto-installs launchd (macOS) or systemd (Linux) via `./omp-wechat install`
- **Standalone binary**: compiles to a single executable — no runtime dependency on Bun or Node

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) 1.1+ (for building only; the compiled binary has no runtime dependency)
- [OMP](https://omp.sh) installed and authenticated (`omp login`)
- WeChat (latest iOS version with ClawBot support)

### Build

```bash
git clone <your-repo-url> OMP-Wechat
cd OMP-Wechat
bun install
bun run build
```

This produces `./omp-wechat`, a standalone binary (~85 MB).

### Login (scan QR code)

```bash
./omp-wechat login
```

A QR code appears in the terminal. Scan it with WeChat and confirm on your phone. Credentials are saved to `~/.omp-wechat/credentials.json`.

### Run

```bash
# Foreground
./omp-wechat run

# Or install as a background daemon (auto-detects platform)
./omp-wechat install
```

Once running, send a message to the bot on WeChat — it will be processed by OMP and the reply sent back.

## Configuration

Configuration is loaded from (in priority order):

1. Environment variables
2. `~/.omp-wechat/config.yml`
3. `~/.omp-wechat/.env`
4. Built-in defaults

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `OMP_WECHAT_CWD` | Current directory | OMP working directory (tools operate here) |
| `OMP_MODEL` | OMP default | Model spec (`provider/model` format, e.g. `anthropic/claude-sonnet-4-5`) |
| `OMP_WECHAT_TOOLS` | `read,grep,glob,write,edit,bash` | Comma-separated allowed tools |
| `OMP_WECHAT_MAX_SESSIONS` | `50` | Session pool cap (LRU eviction) |
| `OMP_WECHAT_DM_POLICY` | `pairing` | Access policy: `pairing` / `allowlist` / `disabled` |

### Config file

```yaml
# ~/.omp-wechat/config.yml
model: anthropic/claude-sonnet-4-5
cwd: /Users/you/Desktop/Work
tools:
  - read
  - grep
  - glob
  - write
  - edit
  - bash
maxSessions: 50
dmPolicy: pairing
systemPrompt: |
  You are an AI assistant chatting via WeChat.
  Keep replies concise and in plain text.
```

> **Model credentials are managed by OMP.** `createAgentSession()` automatically calls `discoverAuthStorage()`, reusing your existing `omp login` OAuth, `~/.omp/agent/agent.db` API keys, or `models.yml` config. This project never touches API keys.

## CLI Commands

```bash
./omp-wechat login              # Scan QR code to log in
./omp-wechat run                # Run in foreground
./omp-wechat install            # Install as background daemon (launchd/systemd)
./omp-wechat uninstall          # Uninstall daemon
./omp-wechat status             # Show daemon + session pool + authorized users
./omp-wechat pair <code>        # Approve a pairing request
./omp-wechat allow <wxid>       # Directly authorize a user
./omp-wechat revoke <wxid>      # Revoke a user's authorization
./omp-wechat list               # List authorized users
```

## Access Control

| Mode | Behavior |
|---|---|
| `pairing` (default) | Unknown senders get a pairing code; they must be approved via `omp-wechat pair <code>` in terminal |
| `allowlist` | Only users in the allowlist can send messages; others are silently dropped |
| `disabled` | All inbound messages are dropped |

The logged-in user (who scanned the QR code) is automatically added to the allowlist.

## Daemon Management

### macOS (launchd)

```bash
./omp-wechat install     # Generates plist, loads, and starts
./omp-wechat uninstall   # Unloads and removes plist

# Manual control
launchctl start com.omp-wechat
launchctl stop com.omp-wechat
tail -f ~/OMP-Wechat/logs/stderr.log
```

### Linux (systemd)

```bash
./omp-wechat install     # Generates service file (sudo), enables, and starts
./omp-wechat uninstall   # Stops, disables, and removes service file

# Manual control
sudo systemctl start omp-wechat
sudo systemctl stop omp-wechat
journalctl -u omp-wechat -f
```

### tmux (any platform)

```bash
mkdir -p logs
tmux new -d -s omp-wechat './omp-wechat run 2>&1 | tee logs/stderr.log'
tmux attach -t omp-wechat
```

## Project Structure

```
OMP-Wechat/
├── package.json
├── tsconfig.json
├── .env.example
├── src/
│   ├── main.ts            # CLI entry point (login/run/install/... )
│   ├── config.ts          # Config loading (env + config.yml + defaults)
│   ├── daemon.ts          # Cross-platform daemon install/uninstall
│   ├── ilink/
│   │   ├── types.ts       # iLink Bot API type definitions
│   │   ├── client.ts      # iLink API client (poll/send/typing)
│   │   └── login.ts       # QR code login flow
│   ├── engine/
│   │   ├── session.ts     # OMP session creation + reply subscription
│   │   ├── pool.ts        # Session pool (LRU eviction, concurrency)
│   │   └── prompt.ts      # Barrel exports
│   ├── access/
│   │   └── control.ts     # Access control (pairing/allowlist/disabled)
│   ├── utils/
│   │   ├── chunk.ts       # Long text chunking
│   │   └── logger.ts      # stderr logger
│   └── types/
│       └── qrcode-terminal.d.ts
└── README.md
```

## Limitations

- **Reply-only**: iLink requires `context_token` from an inbound message; you cannot initiate conversations
- **1:1 only**: iLink Bot API does not support group chats
- **No message history**: WeChat provides no history API; session context is lost on restart (in-memory sessions)
- **Single instance**: iLink allows only one bot connection per account
- **Text only (Phase 1)**: images/voice/video are represented as `(image)` / `(voice)` placeholders; media support is planned

## Roadmap

- **Phase 2**: Media support (inbound images as base64, voice transcription)
- **Phase 3**: Persistent sessions (`SessionManager.create()` per chat directory)
- **Phase 4**: Per-chat model selection (smol for simple questions, slow for complex)
- **Phase 5**: Fine-grained permissions (per-user tool restrictions, bash approval via WeChat)

## How It Works — iLink Bot API

OMP-Wechat uses the Tencent iLink Bot API — the same protocol powering WeChat's ClawBot feature.

| Endpoint | Method | Purpose |
|---|---|---|
| `/ilink/bot/get_bot_qrcode` | GET | Fetch login QR code |
| `/ilink/bot/get_qrcode_status` | GET | Poll QR scan status |
| `/ilink/bot/getupdates` | POST | Long-poll for new messages (35s) |
| `/ilink/bot/sendmessage` | POST | Send a text reply |
| `/ilink/bot/getconfig` | POST | Get typing ticket |
| `/ilink/bot/sendtyping` | POST | Show/cancel "typing..." indicator |

Base URL: `https://ilinkai.weixin.qq.com/`

Every request requires `Authorization: Bearer <bot_token>` + a random `X-WECHAT-UIN` header. Replies must include the `context_token` from the inbound message.

## License

MIT
