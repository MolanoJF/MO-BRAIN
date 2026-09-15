# Slice 2 findings — Open Q1 25-Space scale probe

> Roadmap risk 10 / Open Q1: *does anything degrade with many sources — search fan-out, `federated_read[]` array length, repo count on disk?* Measured once, locally, against the slice0 stack (`GBRAIN_VERSION=0.50.0.0`, compose project `brainstand-slice0`) on 2026-09-15. Production `brainstand-*` was left running and was not the measurement target.

Status: `confirmed` (the C5 threshold held) | `falsified` | `changed`.

C5 wrote the decision rule into `scripts/scale-probe.ts` **before** the run:

```ts
const P95_LATENCY_BUDGET = 3.0;   // × the 1-Space baseline
const RECALL_FLOOR        = 0.90; // × the 1-Space baseline's recall
```

Degradation past either threshold would have been STOP AND ESCALATE, with no Space-boundary redesign inside Slice 2. Neither threshold tripped. That is not a license to treat 25 as infinity — see Caveats.

## Setup

Same 25-page corpus both phases. Each page is a short markdown file with a unique token `ZXPROBE{nn}QUOKKA`. Real embeddings (`openai:text-embedding-3-small`). `search.mode=fast`. Searches ran as a thin-client OAuth Connection (not gbrain-ops local admin), so `federated_read[]` was actually on the path.

| Phase | Topology | Connection |
|---|---|---|
| 1-Space baseline | 25 pages in one git repo `/srv/brain-repos/q1-mono`, source `q1-mono` | `federatedRead: ['q1-mono']` |
| 25-Space | the same 25 pages, one git repo + source each (`q1-s01`…`q1-s25`) | `federatedRead: [all 25]` |

N = 20 queries (tokens of pages 01–20). Hit = the unique token appears in a result `title`/`slug`/`chunk_text`. p95 is nearest-rank (`ceil(0.95 × n) − 1` → the 19th of 20 samples). Latency is wall-clock of `docker compose exec` → `gbrain search --json` through that thin client.

Exact run (abridged; full JSON is the script's stdout):

```
[1-space]  spaces=1  repos=1  federated_read requested=1  grant=1  whoami=1  sources.status=1003ms  p95=1676.0ms  recall=1.000 (20/20)
[25-space] spaces=25 repos=25 federated_read requested=25 grant=25 whoami=25 sources.status=1027ms  p95=1574.0ms  recall=1.000 (20/20)
thresholds held: latency 0.939× ≤ 3, recall 1.000× ≥ 0.9
```

`whoami` reported `transport: "oauth"` in both phases.

## Numbers

| Metric | 1-Space | 25-Space | Ratio (25 / 1) |
|---|---|---|---|
| Search p95 (ms) | **1676** | **1574** | **0.939×** (budget 3.0×) |
| Search mean (ms) | 1417 | 1408 | 0.993× |
| Search max (ms) | 2259 | 1601 | — |
| Recall | **20/20 = 1.000** | **20/20 = 1.000** | **1.000×** (floor 0.90×) |
| `federated_read[]` requested | 1 | 25 | — |
| `federated_read[]` on grant JSON | 1 | 25 | no truncation |
| `federated_read[]` on `whoami` | 1 | 25 | no truncation |
| Probe repos on disk (`q1-*`) | **1** | **25** | 25× |
| `sources list --json` row count | 2 | 26 | always +1 (`default`) |
| `sources status --json` (ms) | **1003** | **1027** | 1.024× |
| `sync --all` (ms) | 1676 | 4059 | 2.42× |
| `embed --stale` (ms) | 3317 | 2433 | 0.73× |
| Estimated embed+query spend | ~$0.000093 | (included) | well under $1; cap $5 |

Search samples (ms), 1-Space: 1676, 1347, 1364, 1432, 1365, **2259**, 1323, 1373, 1357, 1351, 1358, 1400, 1383, 1333, 1429, 1308, 1320, 1334, 1380, 1349.

Search samples (ms), 25-Space: 1601, 1345, 1314, 1340, 1428, 1490, 1414, 1300, 1469, 1489, 1429, 1574, 1468, 1383, 1431, 1382, 1312, 1401, 1374, 1312.

**C5 verdict: pass.** Latency 0.939× ≤ 3.0; recall 1.000× ≥ 0.90. Not STOP AND ESCALATE.

## Mechanism

The thing Open Q1 named is grant-scoped retrieval, not local-admin `gbrain search`. Both phases minted one `mcp grant` (`memory-reader`, `harness=generic`), installed it with `init --mcp-only` under a separate `GBRAIN_HOME`, and searched as that OAuth client against `gbrain serve` on `127.0.0.1:3132` inside slice0 `gbrain-ops`. Production `gbrain-serve` stayed on its own compose network; the probe did not bind a host port.

At this corpus size the search wall-clock is dominated by a roughly-constant floor (~1.3–1.4s) that is docker-exec + thin-client MCP + one query embed, not by source count. Spreading the same 25 pages across 25 sources did not move p95 outside noise; the 25-Space p95 was *lower* because the 1-Space run had a single 2259ms outlier (query 6, not the first sample, so not a cold-start artefact of the phase). Mean latency is 1417ms vs 1408ms.

`federated_read[]` of length 25 was accepted on `mcp grant`, stored, and echoed verbatim by `whoami`. No silent truncation at this size.

Repo count is real: 25 distinct git repos under `/srv/brain-repos/q1-sNN`. Docker Desktop held them. `sources add` itself is ~900–1000ms per source (sequential, ~24s for 25) and is a wizard-cost observation, not a search one.

`gbrain init` always leaves a `default` source (`local_path: null`, `federated: true`, `page_count: 0`). That is why `sources list` reads 2 and 26 rather than 1 and 25. The probe's repo-count figure counts only `q1-*` and is the apples-to-apples number.

The one command that *did* scale with source count is `sync --all` (1676ms → 4059ms, 2.42×). It still sits under the search p95 budget, and it is not the C5 metric. `sources status` with live commit probes (`probeContent: true` upstream) did not move (1003ms → 1027ms).

Probe sources were added without `--federated` (upstream default `federated: false` on `sources list`). Thin-client recall still hit every target via the grant's `federated_read` list. This run is therefore a measurement of Connection-scoped fan-out, which is the product path Slice 2 actually ships.

## Caveats

- **Tiny corpus.** 25 pages of ~80 tokens each. This does not exercise large-page embedding, FTS corpus size, HNSW/ANN pressure, or a year of agent writes. A 25-Space *brain full of real pages* is a different measurement.
- **Queries are unique tokens.** `ZXPROBE{nn}QUOKKA` is designed to hit. Recall 1.0 here is expected and says nothing about synonym / concept retrieval (`query` with expansion), which this probe did not run.
- **N = 20 is enough for a p95 and noisy for a tail.** Nearest-rank p95 is the 19th sample. One 2259ms 1-Space outlier is the entire 1-Space-vs-25-Space p95 gap. Do not read 0.939× as "25 Spaces are faster."
- **Wall-clock includes docker-exec.** A constant ~1s floor damps ratios. In-engine fan-out could still grow and remain hidden under that floor. An in-process timer was not available on `search --json` (the payload is the hit array; `latency_ms` is telemetry-only).
- **`search.mode=fast`, expansion off.** The cheap hybrid path. `query` (LLM expansion) was not measured and would add a different cost.
- **Not 100 Spaces, not concurrent.** One Connection, one query at a time, 25 sources. Concurrent members, larger `federated_read[]`, or `sources status` against long git histories are unmeasured.
- **`default` source is always present after init.** Any later UI that renders `sources list` length as "Space count" will be off by one unless it filters `id !== 'default'` (or `local_path == null`).
- **Spend.** Estimated embed+query vectors ≈ $0.000093 on `text-embedding-3-small`. Cumulative well under $5.
- **Sandbox.** slice0 stack, local Docker Desktop. `ssh al-vps` was not needed. Production `brainstand-*` was not composed down and did not share volumes with this run.
- **Not in CI.** One-shot measurement. Re-run with `bun run scripts/scale-probe.ts` after `bun run stack:up` if the pin or the search path changes.

## Decisions this changes

- **Space-per-boundary at 25 is not blocked by Open Q1 today.** Slice 2's UI can keep pushing one Space per boundary up to the size this probe covers. The C5 stop rule did not fire; do not redesign Space boundaries on the basis of this run.
- **Do not treat this as a scale-out proof.** The search ratio is a flat line on a 25×80-token corpus with a ~1.3s docker-exec floor. Re-measure before promising tens of Spaces *with real page volume*, or before a Connection with `federated_read[]` well past 25. The next interesting number is probably `sync --all` (already 2.42× here) and `sources add` sequential cost, not search p95.
- **`sources list` is not Space count.** Filter out init's `default` row (null `local_path`, 0 pages) before showing "how many Spaces" in the console.
- **Health / `sources status` at 25 sources is ~1s** and did not degrade relative to 1. Not a Slice 2 blocker. Still a live git probe per source upstream — watch it if Space counts grow into the hundreds.
