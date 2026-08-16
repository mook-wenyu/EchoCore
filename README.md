# EchoCore · @echocore/dsh-memory

[English](README.md) | [简体中文](README.zh.md)

> This is the English summary. The canonical documentation (Chinese) lives in the [package README](packages/dsh-memory/README.md).

DSH (DeepSeek Harness) **session-scoped memory plugin**: automatic extraction, cache-aware injection, scoring retrieval and background maintenance of long-term memory for coding agents — a "hippocampus" for the agent.

## Features

- **Auto-extraction**: dual-channel (compaction shadowing + incremental turns) LLM extraction into structured memories (fact/preference/decision/todo/insight) with full source tracing
- **Cache-aware injection**: stable system snapshot (prefix-cache friendly, TTL + revision invalidation) + real-time user-message injection (budgeted, deduplicated, with prompt-injection declaration)
- **Scoring retrieval**: relevance × time-importance modulation (importance-adaptive half-life + access-frequency modulation + salience floor); optional semantic fusion via RRF rank fusion (local ONNX or remote OpenAI-compatible API)
- **Contradiction resolution**: Jaccard ≥0.7 same-kind new statements auto-supersede old ones (bidirectional pointers + audit + retrieval exclusion)
- **Background maintenance**: scheduled dedup merge, soft-decay re-ranking, tag tidying (rule-based, no LLM)
- **Full audit trail**: every create/merge/supersede/archive action is traceable
- **Browser panel**: settings "Memory" page — search/filter/detail/archive + config section (remote embedding, save-to-apply, **persisted across restarts** via the `memory` section of `~/.dsh/settings.yaml` — DSH's official user-settings seam)

## Quick Start

```bash
git clone <your-fork-url> && cd EchoCore
pnpm install
pnpm --filter @echocore/dsh-memory test
pnpm --filter @echocore/dsh-memory build
```

Deploy into DSH profile composition line (global):

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
insert:
  - name: '@echocore/dsh-memory'
```

## Configuration

Minimal config surface: only 4 remote-embedding keys (12-Factor — everything else is a code constant).

| Key | Default | Meaning |
|-----|---------|---------|
| `embeddingApiBaseUrl` | `''` | Remote embeddings base URL (OpenAI-compatible `/embeddings`) |
| `embeddingApiKey` | `''` | Literal key or `env:NAME` environment-variable reference |
| `embeddingModel` | `''` | Remote model name (e.g. `BAAI/bge-m3`) |
| `embeddingDimension` | 1024 | Remote dimension (local is fixed 384) |

Embedding backend auto-select: remote first → local fallback → disabled (keyword search).

## Requirements

- Node.js 18+, DSH 0.1.0-rc.x / Cordis 4.x, pnpm workspace
- Semantic embedding optional: local ONNX model (21.9 MB q8)

## Documentation

- [Package README (Chinese, full)](packages/dsh-memory/README.md)
- `docs/`: implementation & optimization plans (Chinese, with decision records and verified evidence)

## Backup

The single copy of the memory store needs backup (script keeps latest 10):

```bash
node packages/dsh-memory/scripts/backup-memory.mjs
```

## License

[Apache-2.0](LICENSE)
