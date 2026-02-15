# TOOLS.md — Knight Toolkit

This file is yours to maintain. Add notes about tools, endpoints,
techniques, and configurations as you discover them. It persists
across restarts on your PVC.

## Pre-installed CLI Tools

jq, yq, curl, wget, git, python3, pip, kubectl, gh, nats, rg, tree

## Web Search (SearXNG)

```bash
# Quick search via shared skill
bash /workspace/skills/shared/web-search/scripts/search.sh "query here"

# Direct API
curl -s "http://searxng.selfhosted.svc.cluster.local:8080/search?q=QUERY&format=json" | jq '.results[:5]'
```

## Web Fetch

```bash
bash /workspace/skills/shared/web-fetch/scripts/fetch.sh "https://example.com"
```

## Kubernetes (read-only)

```bash
kubectl get pods -n <namespace>
kubectl logs -n <namespace> <pod>
```

## NATS

```bash
nats -s nats://nats.database.svc:4222 stream ls
nats -s nats://nats.database.svc:4222 stream info fleet_a_tasks
```

## GitHub

```bash
gh issue list --repo <owner>/<repo>
gh pr list --repo <owner>/<repo>
```

## Python Packages

Install persistently with `pip install --user <package>`.
Packages go to `~/.local/` which is on your PVC.

## Your Notes

Add your own tool notes, endpoint configs, and techniques below.
This section is for things you've learned that future-you should know.
