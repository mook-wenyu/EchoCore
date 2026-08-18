# EchoCore · @echocore/dsh-memory

[English](README.md) | [简体中文](README.zh.md)

> This is the English summary. The canonical documentation (Chinese) lives in the [package README](packages/dsh-memory/README.md).

DSH (DeepSeek Harness) **session-scoped memory plugin**: automatic extraction, cache-aware injection, scoring retrieval and background maintenance of long-term memory for coding agents — a "hippocampus" for the agent.

## Features

- **Auto-extraction**: dual-channel (compaction shadowing + incremental turns) LLM extraction into structured memories (fact/preference/decision/todo/insight) with full source tracing
- **Cache-aware injection**: stable system snapshot (prefix-cache friendly, TTL + revision invalidation) + real-time user-message injection (budgeted, deduplicated, with prompt-injection declaration)
- **Scoring retrieval**: relevance × time-importance modulation (importance-adaptive half-life + access-frequency modulation + salience floor) with a **dual-gate keyword path** (noise floor `MIN_RELEVANCE_SCORE=0.3` on raw relevance + fused `minScore`; semantic single-list recall unaffected)
- **Self-learning retention**: `effectiveImportance = clamp(importance + access evidence + self/user-relevance initial factor, 0..10)` drives keep/snapshot ordering (not retrieval); **Echo-Gap redline** — LLM-assessed (importance/reflection) scores never write back to stored importance (arXiv:2608.00017); pinned by contract tests
- **Contradiction resolution**: Jaccard ≥0.7 same-kind new statements auto-supersede old ones (bidirectional pointers + audit + retrieval exclusion); supersede/archive **keep the original row** (invalidate-not-delete)
- **Background maintenance**: rule-based dedup merge / soft-decay / tag tidying, plus optional **LLM self-reflection** (archive/merge semantic duplicates & contradictions — reversible, cumulative observability in `memory_status`) and **causal-chain extraction** (add-only, audit-only, confidence ≥0.6)
- **Agent tools**: `memory_recall` / `memory_search` / `memory_note` / `memory_forget` / `memory_audit` / `memory_status` / `memory_reflect` (lossless-JSON-safe outputs — optional fields omit the key, never `undefined`)
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

> Deployment mechanics (verified): dsh-memory loads via the **patch layer** (`cordis.patch.yml`), not `dsh.bundle` — so config/patch edits hot-reload through the host's `cordis-plugin-hmr` **without a host restart**; source changes require `pnpm --filter @echocore/dsh-memory build` + refreshing the profile's `.pnpm` store copy (or `dsh plugin --profile <name> add @echocore/dsh-memory`), then a patch touch or restart. The web profile's pnpm supply-chain `minimumReleaseAge` policy may reject freshly published packages (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`) — see the package README.

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

- [Package README (Chinese, canonical)](packages/dsh-memory/README.md)
- [Production validation report](production-validation-report-2026-08-18.md) (deploy state, W2 hot-activation, semantic coverage, supply-chain note)
- Self-learning redline contract tests: `packages/dsh-memory/test/self-learning-contract.test.ts`
- `docs/`: implementation & optimization plans (Chinese, with decision records and verified evidence)

## Backup

The memory store lives in `$DSH_HOME/storages/memory.sqlite` (SQLite WAL). Backup with a consistent snapshot via the SQLite backup API (script keeps latest 10 by default):

```bash
node packages/dsh-memory/scripts/backup-memory.mjs
```

## License

[Apache-2.0](LICENSE)
