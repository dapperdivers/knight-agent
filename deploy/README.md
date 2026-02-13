# Deploying Knights

## Quick Deploy

To deploy a new knight, you need:
1. A ConfigMap with workspace files (SOUL.md, AGENTS.md, IDENTITY.md, TOOLS.md)
2. A HelmRelease pointing at the knight-agent image
3. A secret with `ANTHROPIC_API_KEY` (can reuse existing)

That's it. PVC is recommended for memory persistence and tool installation.

## RBAC

Each knight gets a scoped ServiceAccount with read-only access:
- **No secrets** — API keys injected via envFrom, never queryable
- **No exec** — can't shell into other pods
- **No write** — can't modify cluster state
- **Per-namespace** — each knight only sees namespaces relevant to its domain

See `rbac.yaml` for the template. Add RoleBindings per namespace as needed.

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
