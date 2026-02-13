# Knight Agent

Lightweight AI agent runtime for Knights of the Round Table.

Replaces full OpenClaw gateway pods (~1.5-2GB) with a thin Express server wrapping the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-js), achieving ~75% resource reduction while maintaining the same agent capabilities.

Skills follow the open [Agent Skills](https://agentskills.io) standard — the same format used by Claude Code, Augment, and other compatible agents.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Knight Pod                       │
│                                                   │
│  ┌─────────────┐  ┌──────────┐  ┌────────────┐  │
│  │ knight-light │  │ nats-    │  │ git-sync   │  │
│  │ (Express +   │  │ bridge   │  │ (skills)   │  │
│  │  Agent SDK)  │  │          │  │            │  │
│  └──────┬───────┘  └────┬─────┘  └────────────┘  │
│         │               │                         │
│         │  HTTP webhook  │                         │
│         ◄───────────────┘                         │
└─────────┼───────────────┼─────────────────────────┘
          │               │
          │ Anthropic API  │ NATS JetStream
          ▼               ▼
```

## Design Principles

### Layered Prompt Architecture

Unlike flat file injection, knight-light uses a structured 4-layer prompt system:

| Layer | Location | Purpose | Changes? |
|-------|----------|---------|----------|
| **1. System Prompt** | API `system` param | Identity + hard constraints | Immutable per knight |
| **2. Context** | Prefilled messages | Soul, memory, tools | Per-session |
| **3. Skills** | On-demand injection | Domain-specific instructions | Per-task |
| **4. Task** | User message | The actual request | Per-request |

### Key Differences from OpenClaw

- **No browser sidecar** — knights don't need web browsing
- **No session persistence** — stateless task execution (memory via workspace files)
- **No channel routing** — NATS is the only interface
- **OAuth or API key** — supports Max plan token reuse
- **~400MB image** vs ~1.5-2GB for full OpenClaw

## Configuration

Knights are configured via workspace files mounted into the container:

```
/workspace/
├── SOUL.md              # Personality, tone, boundaries
├── AGENTS.md            # Operating instructions
├── TOOLS.md             # Tool notes, API endpoints
├── IDENTITY.md          # Name, emoji, vibe
├── memory/              # Daily logs + long-term memory
│   ├── MEMORY.md
│   └── YYYY-MM-DD.md
└── skills/              # Agent Skills (agentskills.io standard)
    ├── opencti-intel/
    │   ├── SKILL.md     # Frontmatter + instructions
    │   └── scripts/     # Executable helpers
    ├── nats-comms/
    │   └── SKILL.md
    └── cve-deep-dive/
        ├── SKILL.md
        └── references/  # On-demand reference docs
```

Skills are discovered automatically at startup via the [Agent Skills](https://agentskills.io) spec. Only name + description (~100 tokens each) are loaded initially; full instructions load on-demand when the agent activates a skill (progressive disclosure).

## Quick Start

```bash
# With API key
docker run -e ANTHROPIC_API_KEY=sk-... \
  -v ./workspace:/workspace \
  ghcr.io/dapperdivers/knight-light:latest

# With OAuth token (Max plan)
docker run -v ~/.claude:/home/node/.claude:ro \
  -v ./workspace:/workspace \
  ghcr.io/dapperdivers/knight-light:latest
```

## Webhook API

### `POST /hooks/agent`

Receives tasks from nats-bridge. Same contract as OpenClaw's webhook.

```json
{
  "message": "Analyze CVE-2026-1234 for impact on Kubernetes clusters",
  "metadata": {
    "taskId": "abc-123",
    "knight": "galahad",
    "domain": "security"
  }
}
```

### `GET /healthz`

Returns `200 OK` when ready.

### `GET /info`

Returns knight identity and status.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | One of key/oauth | — | API key for Anthropic |
| `CLAUDE_AUTH_DIR` | One of key/oauth | `~/.claude` | Path to OAuth credentials |
| `WORKSPACE_DIR` | No | `/workspace` | Path to workspace files |
| `PORT` | No | `18789` | HTTP server port |
| `MODEL` | No | `claude-sonnet-4-5-20250514` | Default model |
| `MAX_TOKENS` | No | `16384` | Max output tokens |
| `KNIGHT_NAME` | No | Read from IDENTITY.md | Knight name override |
| `LOG_LEVEL` | No | `info` | Logging level |

## License

MIT
