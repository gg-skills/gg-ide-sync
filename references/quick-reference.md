---
title: GG IDE Sync Quick Reference
---

# GG IDE Sync Quick Reference

Run commands from the target repository root.

## Full sync

```bash
npx tsx .agents/skills/ide-sync/scripts/sync.ts
```

## Lane commands

```bash
npx tsx .agents/skills/ide-sync/scripts/sync.ts --lane skills
npx tsx .agents/skills/ide-sync/scripts/sync.ts --lane agents
npx tsx .agents/skills/ide-sync/scripts/sync.ts --lane workflows
npx tsx .agents/skills/ide-sync/scripts/sync.ts --lane rules
npx tsx .agents/skills/ide-sync/scripts/sync.ts --lane submodules
```

## Host package scripts

```json
{
  "scripts": {
    "sync": "npx tsx .agents/skills/ide-sync/scripts/sync.ts",
    "skills:sync": "npx tsx .agents/skills/ide-sync/scripts/sync.ts --lane skills",
    "agents:sync": "npx tsx .agents/skills/ide-sync/scripts/sync.ts --lane agents",
    "workflows:sync": "npx tsx .agents/skills/ide-sync/scripts/sync.ts --lane workflows",
    "rules:sync": "npx tsx .agents/skills/ide-sync/scripts/sync.ts --lane rules",
    "sync:submodules": "npx tsx .agents/skills/ide-sync/scripts/sync.ts --lane submodules"
  }
}
```

## Source folders by lane

| Lane | Expected source folders |
|------|-------------------------|
| `skills` | `skills/` |
| `agents` | `canonical-agents/`, root guidance files |
| `workflows` | `package.json`, `canonical-workflows/`, package workflow opt-ins |
| `rules` | `canonical-rules/`, docs and guidance markdown |
| `submodules` | `.gitmodules`, package-local `package.json#scripts.sync` |

## Verification

```bash
NODE_OPTIONS='--experimental-vm-modules' npx jest --config skills/ide-sync/jest.config.ts
npx tsx .agents/skills/ide-sync/scripts/sync.ts --lane agents --dry-run
npx tsx .agents/skills/ide-sync/scripts/sync.ts --lane workflows --dry-run
npx tsx .agents/skills/ide-sync/scripts/sync.ts --lane submodules --dry-run
```
