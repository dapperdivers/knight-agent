# Deploying Knights

## Quick Deploy

To deploy a new knight, you need:
1. A ConfigMap with workspace files (SOUL.md, AGENTS.md, IDENTITY.md, TOOLS.md)
2. A HelmRelease pointing at the knight-agent image
3. A secret with `ANTHROPIC_API_KEY` (can reuse existing)

That's it. No PVC required for day-one deployment — memory persistence is optional.

## File Overlay Strategy

```
/workspace/                          ← WORKSPACE_DIR
├── config/                          ← ConfigMap mount (read-only)
│   ├── SOUL.md
│   ├── AGENTS.md
│   ├── IDENTITY.md
│   └── TOOLS.md
├── data/                            ← PVC mount (read-write, optional)
│   ├── memory/
│   ├── TOOLS.md                     ← Knight's own edits (overrides config/)
│   └── ...
└── skills/                          ← git-sync mount (read-only)
    ├── nats-comms/
    ├── web-search/
    └── ...
```

The knight-agent `workspace/loader.ts` checks PVC first, falls back to ConfigMap.

## Example: New Knight in 5 Minutes

See `example-knight.yaml` for a complete example.
