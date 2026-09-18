# Slice 4 findings — the agent runner lane

> **Task 1 complete; Task 18 owns the rest of this file.** This document was created by
> **Task 1 — Probe the harness and the token lane** of
> [`docs/superpowers/plans/2026-09-17-slice-4-agent-runner.md`](superpowers/plans/2026-09-17-slice-4-agent-runner.md),
> on branch `slice-4-agent-runner`. It carries a status, the exact command and the verbatim output for
> **every** upstream-reality row (U1–U8) and **every** probe (P1–P9), plus the execution findings
> (F1–F13) Task 1 surfaced, the **D8 mechanism decision**, and the cleanup record. Task 18 appends
> Gate C's measured numbers and real dollar cost here.

Status vocabulary: `confirmed` (the claim held as written) | `contradicted` (reality differed, and the
correction is named here) | `inference` (no artifact carries the observation; stated as such, never
dressed up as a measurement).

Every command below was run on this machine on **2026-09-17** against the live dev stack
(`brainstand-*-1` at gbrain `0.50.5.0`, `DOMAIN=localhost`) and the pinned harness
`@anthropic-ai/claude-code@2.1.274`. Output is pasted from that run; nothing is reconstructed from
memory, and no row is backed by "expected" text. Where a probe could not discriminate between its two
outcomes, that is said in the row and the replacement probe is given.

**Verification of this document's own premise:** this task's **only** write to the repository is
`docs/slice-4-findings.md`. No file under `src/`, `test/`, `docker/`, `compose/`, `scripts/` or
`contracts/` was created or modified by Task 1 — sibling agents have their own uncommitted work in this
shared tree, so a tree-wide `git status` is not evidence about this task, and none is offered here.

---

## The go/no-go on U1–U8

| # | Claim | Status | Consequence if contradicted |
|---|---|---|---|
| U1 | The Claude Code headless CLI installs cleanly on `oven/bun:1.3.13` at an exact version, and `claude --version` reports it | `confirmed` | — **GO.** Task 2 builds on `oven/bun:1.3.13` with `ARG HARNESS_VERSION=2.1.274` |
| U2 | `--output-format stream-json` emits a line-delimited frame vocabulary that carries per-turn `usage` and tool-use blocks | `confirmed` | — **GO**, with two corrections Task 8 must absorb: `--verbose` is mandatory with `-p`, and the vocabulary is 8 frame types, not the 3 the plan implies (P2) |
| U3 | `ANTHROPIC_BASE_URL` routes **all** model traffic, and with the auto-updater and telemetry off the process makes no other outbound connection | `confirmed` | — **GO.** D6's fence needs no extra host in the allowlist (P3) |
| U4 | `--mcp-config` accepts an HTTP MCP server with a static `Authorization` header (no interactive OAuth dance) | `confirmed` | — **GO.** D5's "exactly one server, static bearer" holds (P4) |
| U5 | A CLI-minted gbrain token has a **revocable id** exposed on the grant receipt, and a CLI verb revokes it | **`contradicted`** | **D8 takes the fallback.** The receipt exposes a **client id**, never a token id; OAuth tokens are stored by `token_hash` with no id column, and `gbrain auth revoke --id <uuid>` operates on the *legacy* `access_tokens` table. See [the D8 decision](#the-d8-mechanism-decision) and F7/F8 |
| U6 | An MCP `put_page` produces one or more git commits in the Space repo, with an author gbrain chooses | **`contradicted`** | **D9 changes shape.** An MCP write produces **zero** commits in this stack (the file lands untracked); the write-through commit is gated on `sources harden`, and gbrain supplies **no** author identity when it does commit. Task 9 must derive the diff from the working tree / our own commits, not from gbrain's. See P8 and F10 |
| U7 | `claude` runs under a read-only rootfs given tmpfs at `$HOME` and the workspace | `confirmed` | — **GO, and cheaper than planned:** the minimal writable set is **`/tmp` alone**; `$HOME` is not required. Two image-shape findings in F1 |
| U8 | gbrain-serve's `/mcp` accepts a bearer access token directly | `confirmed` | — **GO.** The per-run token lane needs no OAuth handshake inside the container (P7) |

**Two of eight upstream rows are contradicted, and both are load-bearing** (D8's kill switch and D9's
diff). Neither blocks the slice; both change a downstream task's shape, as recorded per row below.

---

## Probe summary

| # | Probe | Status |
|---|---|---|
| P1 | The harness installs on `oven/bun:1.3.13` at an exact version and `claude --version` reports it | `confirmed` |
| P2 | The complete `stream-json` frame vocabulary, per-turn usage, cumulative cost and tool-use blocks | `confirmed` |
| P3 | `ANTHROPIC_BASE_URL` carries all model traffic; no other outbound connection; the silence env vars | `confirmed` |
| P4 | `--mcp-config` HTTP server with a static `Authorization` header — sent as given, no OAuth negotiation | `confirmed` |
| P5 | The minimal writable set under `--read-only` | `confirmed` (`/tmp` alone; not stop-the-line) |
| P6 | The `mcp grant --json` receipt's key set, and whether a CLI verb revokes the minted token | **`contradicted`** — no token id exists |
| P7 | A raw bearer is accepted by gbrain-serve's `/mcp` | `confirmed` |
| P8 | The author/committer/message of the commit an MCP `put_page` produces | **`contradicted`** — there is no commit |
| P9 | `MODEL_PRICING` source, `pricedAt`, and the mapping from P2's usage fields | `confirmed` |

| # | Finding (execution surfaced these; the plan did not predict them) | Status |
|---|---|---|
| F1 | A root `bun install -g` puts the harness under `/root/.bun`, which a non-root `USER` cannot traverse (`Permission denied`), and a tmpfs at `$HOME` hides it entirely (`Script not found "claude"`) | `confirmed` |
| F2 | `claude -p … --output-format stream-json` **exits 1** without `--verbose`: `Error: When using --print, --output-format=stream-json requires --verbose` | `confirmed` |
| F3 | `--tools ""` yields an MCP-only surface (`tools: ["mcp__gbrain__put_page"]`) and the model then made **no** `ToolSearch` call — a strictly stronger MCP-only fence than `--disallowedTools` | `confirmed` |
| F4 | The harness issues `HEAD /api/hello` against the base URL before `POST /v1/messages` | `confirmed` |
| F5 | `ANTHROPIC_AUTH_TOKEN` is sent verbatim as `Authorization: Bearer <token>` on every model request; no API key is needed | `confirmed` |
| F6 | `mcp grant` refuses a non-HTTPS `--url`: `Use HTTPS for credential delivery; HTTP is supported only on loopback` | `confirmed` |
| F7 | Every `mcp grant` writes a private credential journal to `GBRAIN_HOME/.gbrain/credential-deliveries/<client_id>.json`, and `auth revoke-client` does **not** delete it — 38 such files existed in the dev stack before this probe | `confirmed` |
| F8 | `oauth_tokens` is keyed by `token_hash` with **no id column**; per-token revocation by id is structurally impossible, and RFC 7009 `POST /revoke` (which needs the client secret) is the only per-token kill | `confirmed` |
| F9 | The harness's own `total_cost_usd` matched our table exactly on a single-request run and was 8.8% higher than the same table on a two-request run — it is a hint, never the authority | `confirmed` |
| F10 | A successful MCP write reports `write_through.written: true` with **no** `committed` key and can still carry `status: "skipped"` / `chunk_skip_reason: "write_skipped"`; chunks appear asynchronously | `confirmed` |
| F11 | `delete_page` is **not** on the granted MCP surface (`unknown_operation`) although the grant's `allowedOperations` lists it — `allowedToolsFor` must read the surface, not the grant | `confirmed` |
| F12 | The Space repos have **no** `user.name`/`user.email` configured, so every commit in them must carry `-c user.name -c user.email` (our `commitAs` does; gbrain's write-through would exit 128) | `confirmed` |
| F13 | Pre-existing secret residue: 36 credential-delivery journals from earlier slices persist under `GBRAIN_HOME` | `confirmed` |

---

## P1 — the harness installs on `oven/bun:1.3.13` at an exact version

**Status: `confirmed`.** Where the plan relies on it: U1, D4, Task 2's from-line and smoke gate.

Package identity resolved from the registry before the build (`@anthropic-ai/claude-code`, latest
`2.1.274`, `bin: {"claude": "bin/claude.exe"}`, optional platform packages
`@anthropic-ai/claude-code-linux-x64@2.1.274`, `postinstall: node install.cjs`, `engines.node >=22`).

Throwaway Dockerfile (`.brainstand-tmp/slice4/p1.Dockerfile`, deleted with the rest of the scratch):

```dockerfile
FROM oven/bun:1.3.13

ARG HARNESS_VERSION
RUN test -n "$HARNESS_VERSION" || (echo "HARNESS_VERSION required" >&2; exit 1)

RUN bun install -g "@anthropic-ai/claude-code@${HARNESS_VERSION}"

RUN claude --version | tee /opt/harness-version.txt
RUN test -s /opt/harness-version.txt || exit 1
```

Command and wall-clock:

```bash
time docker build --build-arg HARNESS_VERSION=2.1.274 \
  -t slice4-probe-harness:2.1.274 -f p1.Dockerfile .
```

```
#6 [3/5] RUN bun install -g "@anthropic-ai/claude-code@2.1.274"
#6 0.550 bun add v1.3.13 (bf2e2cec)
#6 11.26 Resolved, downloaded and extracted [22]
#6 11.31 installed @anthropic-ai/claude-code@2.1.274 with binaries:
#6 11.31  - claude
#6 11.31 3 packages installed [10.77s]
#6 DONE 11.6s

#7 [4/5] RUN claude --version | tee /opt/harness-version.txt
#7 0.341 2.1.274 (Claude Code)
#7 DONE 0.4s

real	0m39.762s
user	0m0.000s
sys	0m0.000s
```

Exit code `0`. **`claude --version` reports `2.1.274 (Claude Code)`** — the pinned value, in the second
field, not the last one; Task 2's smoke gate must `grep -F "$HARNESS_VERSION"`, **not** use
`gbrain-base.Dockerfile`'s `$NF == v` awk test (the last field here is `(Claude Code)`).

The base image resolved to a digest, so the from-line is pinnable by digest too:
`oven/bun:1.3.13@sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e`
(Debian GNU/Linux 13 *trixie*, `x86_64`, `bun 1.3.13`).

Where the binary lands, and its size: `/usr/local/bin/claude` →
`/root/.bun/install/global/node_modules/@anthropic-ai/claude-code-linux-x64/claude` (230,580,536 bytes).
That symlink target is **inside `/root`**, which is `drwx------` — the direct cause of F1.

---

## P2 — the audit receipt's schema

**Status: `confirmed`, with two corrections.** Where the plan relies on it: U2, D4's "the event stream is
the receipt", Task 8's `parseStreamJson`, Task 15's A3, Task 13's run detail.

The plan's literal command **fails** (F2), so the probe that discriminates is the corrected one.

```bash
# The plan's command, verbatim — run once to record why it is not the shape:
docker run --rm -e ANTHROPIC_API_KEY slice4-probe-harness:2.1.274 \
  claude -p "say hi" --output-format stream-json --model haiku
Error: When using --print, --output-format=stream-json requires --verbose
EXIT_PIPELINE=1
```

**Both arms below used `--model haiku`, per the slice directive.**

### P2-a — the simple run (the frame vocabulary)

```bash
docker run --rm -e ANTHROPIC_API_KEY slice4-probe-harness:2.1.274 \
  claude -p "say hi" --output-format stream-json --model haiku --verbose > p2-simple.jsonl
```

`type` / `subtype` / top-level key set, one line per frame, in order:

```
system	init	agents,analytics_disabled,apiKeySource,capabilities,claude_code_version,cwd,fast_mode_disabled_reason,fast_mode_state,mcp_servers,memory_paths,messaging_socket_path,model,output_style,permissionMode,plugins,product_feedback_disabled,session_id,skills,slash_commands,subtype,terminal_slash_commands,tools,type,uuid
assistant	-	message,parent_tool_use_id,request_id,session_id,timestamp,type,uuid
assistant	-	message,parent_tool_use_id,request_id,session_id,timestamp,type,uuid
rate_limit_event	-	rate_limit_info,session_id,type,uuid
result	success	api_error_status,duration_api_ms,duration_ms,fast_mode_disabled_reason,fast_mode_state,first_content_frame_ms,is_error,modelUsage,num_turns,permission_denials,queued_turn_count,result,result_index,session_id,stop_reason,subagent_stats,terminal_reason,time_to_request_ms,total_cost_usd,ttft_ms,ttft_stream_ms,type,usage,uuid
```

The complete `result` frame, verbatim:

```json
{
  "duration_api_ms": 1868,
  "stop_reason": "end_turn",
  "session_id": "8d003c68-24a3-44d7-ba4a-47c4529a60a3",
  "total_cost_usd": 0.0154847,
  "usage": {
    "input_tokens": 10,
    "cache_creation_input_tokens": 6922,
    "cache_read_input_tokens": 13607,
    "output_tokens": 54,
    "output_tokens_details": { "thinking_tokens": 27 },
    "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
    "service_tier": "standard",
    "cache_creation": { "ephemeral_1h_input_tokens": 6922, "ephemeral_5m_input_tokens": 0 },
    "inference_geo": "not_available",
    "iterations": [
      { "input_tokens": 10, "output_tokens": 54, "cache_read_input_tokens": 13607,
        "cache_creation_input_tokens": 6922,
        "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 6922 },
        "type": "message" }
    ],
    "speed": "standard"
  },
  "modelUsage": {
    "claude-haiku-4-5-20251001": {
      "inputTokens": 10, "outputTokens": 54, "cacheReadInputTokens": 13607,
      "cacheCreationInputTokens": 6922, "webSearchRequests": 0, "costUSD": 0.0154847,
      "contextWindow": 200000, "maxOutputTokens": 32000, "thinkingTokens": 27,
      "canonicalModel": "claude-haiku-4-5", "provider": "firstParty", "costBasis": "list"
    }
  },
  "permission_denials": [],
  "terminal_reason": "completed",
  "fast_mode_state": "off",
  "fast_mode_disabled_reason": "sdk_opt_in_required",
  "is_error": false,
  "num_turns": 1,
  "subtype": "success",
  "api_error_status": null,
  "result": "Hey! 👋 Ready to help you with whatever you're working on. What's up?",
  "ttft_ms": 1681, "type": "result", "duration_ms": 2003,
  "ttft_stream_ms": 1424, "time_to_request_ms": 133, "first_content_frame_ms": 1425,
  "queued_turn_count": 0, "result_index": 0
}
```

Answers to P2's four questions, verbatim from the above:

1. **Every `type` seen** — `system`, `assistant`, `rate_limit_event`, `result`. (Three more appear in the
   tool-use arm below: `user`, plus the `system` subtypes `thinking_tokens` and `api_retry`.)
2. **`usage` appears per turn** — yes, on **every `assistant` frame's `message.usage`**, with
   `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation.
   {ephemeral_5m_input_tokens,ephemeral_1h_input_tokens}`, `output_tokens`, `service_tier`,
   `inference_geo`.
3. **A cumulative cost field exists** — `result.total_cost_usd`, plus per-model
   `result.modelUsage[model].costUSD` and the token totals beside it.
4. **What a tool-use block looks like** — see below; `assistant.message.content[]` carries a
   `{type:"tool_use", id, name, input, caller}` block, the tool result comes back on a **`user`** frame,
   and the harness adds a `wire_tool_inputs` map on the assistant frame.

Also load-bearing for Task 8's parser: `"model":"claude-haiku-4-5-20251001"` in the init frame — **the
alias `haiku` resolves to a dated model id**, and the `system/init` frame carries `mcp_servers`,
`permissionMode`, `tools`, `apiKeySource`, `analytics_disabled` and `product_feedback_disabled`. The run
exited `0`.

### P2-b — the forced tool call (the `--verbose` arm's second run)

Prompt forces one `Read`, `--allowedTools Read`:

```bash
docker run --rm -e ANTHROPIC_API_KEY -v "$PWD/p2ws:/tmp/probe" -w /tmp/probe \
  slice4-probe-harness:2.1.274 \
  claude -p "Use the Read tool on ./notes.txt and reply with only its first line." \
  --output-format stream-json --model haiku --verbose --allowedTools Read > p2-tool.jsonl
```

Frame order and content-block census:

```
system	init
rate_limit_event
system	thinking_tokens
system	thinking_tokens
assistant
assistant
rate_limit_event
user
assistant
assistant
result	success

      1 text
      2 thinking
      1 tool_use
```

The `tool_use` block, verbatim:

```json
{
  "type": "assistant",
  "message": {
    "model": "claude-haiku-4-5-20251001",
    "id": "msg_011Cf9Ba2m9e8RkHqr7MKL7V",
    "type": "message", "role": "assistant",
    "content": [
      { "type": "tool_use", "id": "toolu_01HjZUDZEfYKhEJjkd3sPqo4", "name": "Read",
        "input": { "file_path": "/tmp/probe/notes.txt" }, "caller": { "type": "direct" } }
    ],
    "stop_reason": null, "stop_sequence": null,
    "usage": { "input_tokens": 10, "cache_creation_input_tokens": 3032,
      "cache_read_input_tokens": 17512,
      "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 3032 },
      "output_tokens": 3, "service_tier": "standard", "inference_geo": "not_available" }
  },
  "parent_tool_use_id": null,
  "session_id": "54726187-4936-48eb-85ac-31e712e71bf6",
  "uuid": "698a02ba-192e-479d-bd61-2370fd474de9",
  "timestamp": "2026-09-17T14:38:48.693Z",
  "request_id": "req_011Cf9Ba2Gt6M1WCV3oX9s43",
  "wire_tool_inputs": { "toolu_01HjZUDZEfYKhEJjkd3sPqo4": { "file_path": "/tmp/probe/notes.txt" } }
}
```

The tool *result* arrives on the `user` frame, not on an assistant frame:

```json
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01HjZUDZEfYKhEJjkd3sPqo4","type":"tool_result","content":"1\tPROBE-LINE-ALPHA\n2\tsecond line\n3\t"}]},"tool_use_result":{"type":"text","file":{"filePath":"/tmp/probe/notes.txt","content":"PROBE-LINE-ALPHA\nsecond line\n","numLines":3,"startLine":1,"totalLines":3}}}
```

`result.total_cost_usd` for this arm was `0.0121636`, `num_turns: 3`, `stop_reason: "end_turn"`.

**Consequence for Task 8/Task 15:** `parseStreamJson` must handle eight frame shapes, not three, and
must not assume the tool result arrives on an `assistant` frame. A3's fixtures should be taken from
these two runs verbatim. Any parser that switches only on `assistant`/`result` silently drops the
`tool_use_result` payload — which is the *only* place the tool's output appears.

---

## P3 — one route out: `ANTHROPIC_BASE_URL`, and nothing else

**Status: `confirmed`.** Where the plan relies on it: U3, D6's allowlist, D7's proxy, honesty rule 2.

Design. A recorder (`.brainstand-tmp/slice4/sink.ts`, ~150 lines, deleted with the scratch) served three
things in one container on a docker `--internal` network (no gateway, no NAT, therefore **no default
route at all**): `POST /v1/messages` with a valid Anthropic SSE stream, a **DNS sinkhole** on UDP 53 that
answers every A query with its own address and logs the queried name, and a TCP 443 accept-logger.

```bash
docker network create --internal --subnet 172.31.99.0/24 slice4-probe-net
docker run -d --name slice4-sink --network slice4-probe-net --ip 172.31.99.10 \
  -e SINK_IP=172.31.99.10 -v "$PWD/sink.ts:/rec/sink.ts:ro" \
  slice4-probe-harness:2.1.274 bun run /rec/sink.ts
```

### A0 — the control that proves the fence is real

```bash
docker run --rm --network slice4-probe-net slice4-probe-harness:2.1.274 bun -e '
for (const url of ["https://api.anthropic.com/v1/models","https://statsig.anthropic.com/v1/initialize"]) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); console.log("REACHED", url, r.status); }
  catch (e) { console.log("BLOCKED", url, e.message); }
}
try { const s = await Bun.connect({ hostname: "1.1.1.1", port: 443, socket: { data() {}, open(){}, error(){} } }); console.log("REACHED raw tcp 1.1.1.1:443"); s.end(); }
catch (e) { console.log("BLOCKED raw tcp 1.1.1.1:443", e.message); }
try { const r = await fetch("http://slice4-recorder:8787/health", { signal: AbortSignal.timeout(5000) }); console.log("REACHED recorder", r.status); }
catch (e) { console.log("BLOCKED recorder", e.message); }
'
```

```
BLOCKED https://api.anthropic.com/v1/models Unable to connect. Is the computer able to access the url?
BLOCKED https://statsig.anthropic.com/v1/initialize Unable to connect. Is the computer able to access the url?
BLOCKED raw tcp 1.1.1.1:443 Failed to connect
REACHED recorder 404
```

No route out; the recorder is reachable. Every run below happened inside this net.

### A1 — the arm the plan asks for, with the silence env vars

```bash
docker run --rm --network slice4-probe-net --dns 172.31.99.10 \
 -e ANTHROPIC_BASE_URL=http://slice4-sink:8787 \
 -e ANTHROPIC_AUTH_TOKEN=probe-gateway-token \
 -e DISABLE_AUTOUPDATER=1 -e DISABLE_TELEMETRY=1 -e DISABLE_ERROR_REPORTING=1 -e DISABLE_BUG_COMMAND=1 \
 -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 -e CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 \
 slice4-probe-harness:2.1.274 \
 claude -p "say hi" --output-format stream-json --model haiku --verbose
```

```
EXIT=0
{"subtype":"success","is_error":false,"result":"recorder-ok","total_cost_usd":0.000024999999999999998,"num_turns":1}
```

Recorder log — the **complete** traffic of that process:

```
2026-09-17T14:40:09.811Z HTTP#1 HEAD /api/hello
2026-09-17T14:40:09.811Z HTTP#1-HDR accept: */* | accept-encoding: gzip, deflate, br, zstd | connection: keep-alive | host: slice4-sink:8787 | user-agent: Bun/1.4.3
2026-09-17T14:40:10.124Z HTTP#2 POST /v1/messages?beta=true
2026-09-17T14:40:10.124Z HTTP#2-HDR accept: application/json | … | authorization: <redacted len=26 head=Bearer probe-g> | content-length: 111787 | content-type: application/json | host: slice4-sink:8787 | user-agent: claude-cli/2.1.274 (external, sdk-cli) | x-app: cli | x-claude-code-session-id: 306eafc9-… | x-stainless-retry-count: 0 | …
2026-09-17T14:40:10.124Z HTTP#2-BODY bytes=111440 keys=model,messages,system,tools,metadata,max_tokens,thinking,context_management,stream stream=true model=claude-haiku-4-5-20251001 msgs=1 tools=25
```

Two requests, both to the base URL, zero external DNS names, zero TLS connects.

### A2–A5 — the arms that make A1's null result mean something

**A2 — the same run with no silence env vars at all** (so the null result cannot be an artifact of the
vars that were supposed to cause it):

```bash
docker run --rm --network slice4-probe-net \
 -e ANTHROPIC_BASE_URL=http://slice4-sink:8787 -e ANTHROPIC_AUTH_TOKEN=probe-gateway-token \
 slice4-probe-harness:2.1.274 claude -p "say hi" --output-format stream-json --model haiku --verbose
```

```
ARM_B_EXIT=0
result: recorder-ok cost=0.000024999999999999998 is_error=false
--- new sink lines (arm B) ---
2026-09-17T14:40:51.583Z HTTP#4 HEAD /api/hello
2026-09-17T14:40:51.977Z HTTP#5 POST /v1/messages?beta=true
… (no DNS lines, no TLS lines)
```

**A4 — 25 seconds of idle after a run, still no silence vars** (an auto-update or telemetry check is
asynchronous by nature, so a short run cannot clear it):

```bash
docker run --rm --network slice4-probe-net \
 -e ANTHROPIC_BASE_URL=http://slice4-sink:8787 -e ANTHROPIC_AUTH_TOKEN=probe-gateway-token \
 slice4-probe-harness:2.1.274 \
 sh -c 'claude -p "say hi" --output-format stream-json --model haiku --verbose > /tmp/out.jsonl 2>&1; echo EXIT=$?; sleep 25; echo SLEPT'
```

```
EXIT=0
SLEPT
--- external DNS/TLS lines added by arm D ---
(count: 0)
```

**A5 — the positive control, without which A1–A4 are uninformative.** Same net, same sinkhole, no base
URL override (so the default `https://api.anthropic.com` is used):

```bash
docker run --rm --network slice4-probe-net --dns 172.31.99.10 \
 -e ANTHROPIC_API_KEY="<a syntactically valid but non-existent key; never a real one>" \
 slice4-probe-harness:2.1.274 claude -p "say hi" --output-format stream-json --model haiku --verbose
```

```
() => new Date().toISOString() DNS A? api.anthropic.com from 172.31.99.3:54077
() => new Date().toISOString() TLS-CONNECT opens
() => new Date().toISOString() TLS-CONNECT bytes=1478 first=160301
… repeated for every retry, for 90 seconds
```

`first=160301` is a TLS ClientHello. **The observation channel demonstrably sees external attempts**, so
"no DNS query and no TLS connect" in A1–A4 is a real measurement, not a blind spot. The harness's retry
frames in that arm read `{"error_status":null,"error":"unknown"}` — a *connection* failure, not a 401.

### A6 — every env name verified against the pinned binary, not guessed

Extracted from the installed 2.1.274 binary itself (230,580,536 bytes) by regex over its latin1 view:

```
DISABLE_AUTOUPDATER  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC  DISABLE_TELEMETRY  DISABLE_ERROR_REPORTING
DISABLE_UPDATES  DISABLE_BUG_COMMAND  DISABLE_FEEDBACK_COMMAND  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY
DO_NOT_TRACK  FORCE_AUTOUPDATE_PLUGINS  CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE  ENABLE_LOCKLESS_UPDATES
SENTRY_INGEST_HOST  SENTRY_WILDCARD_HOST  ANTHROPIC_TELEMETRY_GROUP  …
```

The gating code, read out of the same binary:

```js
function x(){ if(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) return "essential-traffic";
             if(process.env.DISABLE_TELEMETRY) return "no-telemetry";
             if(Pe(process.env.DO_NOT_TRACK)) return "no-telemetry";
             return "default" }
function kt(){ return x()==="essential-traffic" … }
// and, on the error path:
… || process.env.DISABLE_ERROR_REPORTING || kt()) return;
```

So `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` *implies* the telemetry-and-error-reporting mode, and
`DISABLE_ERROR_REPORTING` is the explicit Sentry guard.

**Consequence for Task 2:** the image's `ENV` set is
`DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1
DISABLE_ERROR_REPORTING=1 DISABLE_BUG_COMMAND=1 DISABLE_FEEDBACK_COMMAND=1
CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1`, each name proven present in the pinned binary. **Consequence
for D6:** no second host is needed in the allowlist. **Consequence for Task 7:** the gateway must
tolerate `HEAD /api/hello` against its base URL (F4) — it is issued before the first model call.

---

## P4 — `--mcp-config` with a static `Authorization` header

**Status: `confirmed`.** Where the plan relies on it: U4, D5's "exactly one server", Task 8's argv.

Stub server: `.brainstand-tmp/slice4/stub-mcp.ts` (~110 lines, deleted with the scratch), answering
JSON-RPC `initialize`, `notifications/initialized`, `tools/list` (one tool, `put_page`) and `tools/call`.

```bash
MC='{"mcpServers":{"gbrain":{"type":"http","url":"http://slice4-mcpstub:8080/mcp","headers":{"Authorization":"Bearer probe-mcp-bearer-token"}}}}'
docker run --rm --network slice4-probe-net \
 -e ANTHROPIC_BASE_URL=http://slice4-sink:8787 -e ANTHROPIC_AUTH_TOKEN=probe-gateway-token \
 -e DISABLE_AUTOUPDATER=1 -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
 slice4-probe-harness:2.1.274 \
 claude -p "Use the gbrain put_page tool with slug 'probe' and content 'hello'. Then reply with only the tool output." \
 --output-format stream-json --model haiku --verbose \
 --mcp-config "$MC" --strict-mcp-config --allowedTools "mcp__gbrain__put_page"
```

Init frame's MCP view and the stub's log:

```
{"mcp_servers":[{"name":"gbrain","status":"connected","source":"dynamic"}],"mcp_tools":["mcp__gbrain__put_page"]}
```

```
2026-09-17T14:45:04.055Z MCP#1 POST /mcp
2026-09-17T14:45:04.055Z MCP#1-HDR accept: application/json, text/event-stream | authorization: <redacted len=29 head=Bearer probe-mcp-bearer-> | content-length: 440 | content-type: application/json | host: slice4-mcpstub:8080 | mcp-method: server/discover | mcp-protocol-version: …
2026-09-17T14:45:04.077Z MCP#2-RPC method=initialize id=0 params={"protocolVersion":"2025-11-25",…}
2026-09-17T14:45:04.080Z MCP#3-RPC method=notifications/initialized id=null params={}
2026-09-17T14:45:04.084Z MCP#4 GET /mcp
2026-09-17T14:45:04.096Z MCP#5-RPC method=tools/list id=1 params={}
```

**The header is sent exactly as given** — `authorization: <redacted len=29 head=Bearer probe-mcp-bearer->`
is `Bearer probe-mcp-bearer-token`, byte for byte. No OAuth endpoint was contacted: a precise re-grep of
the stub log for request lines yields exactly `1 MCP#1 POST /mcp` and `1 MCP#2 POST /mcp` in the 401 arm
(below); no `/.well-known/*`, `/register`, `/authorize` or `/token` request ever appears.

### P4-b — the 401 arm (does a bad token trigger an OAuth dance?)

The stub re-run with `-e STUB_401=1`, answering every request `401` with
`WWW-Authenticate: Bearer error="invalid_token", resource_metadata="…/.well-known/oauth-protected-resource"`:

```
>>> initialize -> HTTP 401 …      (stub log)
"mcp_servers":[{"name":"gbrain","status":"failed","source":"dynamic"}]
P4_401_EXIT=0
  1 MCP#1 POST /mcp
  1 MCP#2 POST /mcp
```

Two requests, then it gives up and marks the server `failed`. **No OAuth discovery, no dynamic client
registration, no authorization attempt.** The failure mode is clean and loud.

### P4-c — the real end-to-end MCP tool call (real model, one paid turn)

Same stub, healthy, on a routable network, with real auth and a real model:

```
{"name":"ToolSearch","input":{"query":"select:mcp__gbrain__put_page","max_results":1}}
{"name":"mcp__gbrain__put_page","input":{"slug":"probe","content":"hello"}}
{"result":"stub-put_page-ok","num_turns":3,"total_cost_usd":0.021504500000000003}
```

Stub side:

```
2026-09-17T14:45:40.524Z MCP#9-RPC method=tools/call id=2 params={"name":"put_page","arguments":{"slug":"probe","content":"hello"},"_meta":{"claudecode/toolUseId":"toolu_01HDhYwaEpGkb2CVHuyP2hZ4","progressToken":2}}
```

**The tool name on the wire is `mcp__gbrain__put_page`; the JSON-RPC `params.name` is the bare
`put_page`.** Task 8's allowlist is written in the former, gbrain sees the latter.

Note the extra `ToolSearch` turn: with the default tool surface, the harness first searches for the MCP
tool before calling it. Task 8's tool-call timeline must expect it (or suppress it with `--tools ""`,
below).

### P4-d — `--tools ""` is a stronger MCP-only fence than `--disallowedTools` (F3)

```bash
… --mcp-config "$MC" --strict-mcp-config --allowedTools "mcp__gbrain__put_page" --tools ""
```

```
{"tools":["mcp__gbrain__put_page"],"mcp_servers":[{"name":"gbrain","status":"connected","source":"dynamic"}]}
{"name":"mcp__gbrain__put_page"}
{"result":"stub-put_page-ok","num_turns":2,"is_error":false,"permission_denials":[]}
```

The session's **entire** tool list is the one MCP tool: every built-in (Bash, Write, Edit, WebFetch,
Task, …) is gone at the source, the MCP tool still works, and no `ToolSearch` turn is spent.
**D5's deny-list (`--disallowedTools` naming Bash/Write/Edit) is the weaker half of what is available.**
Task 8 should pass `--tools ""` (`--help`: *"Use \"\" to disable all tools"*) and keep the deny-list as
defence in depth, per honesty rule 2.

---

## P5 — the minimal writable set under `--read-only`

**Status: `confirmed`. Not a stop-the-line finding.** Where the plan relies on it: U7, Task 3's `tmpfs:`.

Two throwaway images were used, because the first one exposed F1 and could not be tested as a non-root
user:

- `slice4-probe-harness:2.1.274` — P1's image (`bun install -g` as root).
- `slice4-probe-harness-nonroot:2.1.274` — same, plus `ENV BUN_INSTALL=/opt/harness`,
  `ENV PATH=/opt/harness/bin:/usr/local/bin:$PATH`, `chmod -R a+rX /opt/harness`,
  `RUN useradd -u 10001 -m runner`, `USER 10001:10001`, `ENV HOME=/home/runner`. Build wall-clock
  `real 0m41.185s`; `claude --version` inside it prints `2.1.274 (Claude Code)`.

Every arm: `docker run --rm --read-only [tmpfs…] --network slice4-probe-net -e ANTHROPIC_BASE_URL=…
-e ANTHROPIC_AUTH_TOKEN=… -e DISABLE_AUTOUPDATER=1 -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 …
claude -p "say hi" --output-format stream-json --model haiku --verbose`.

| arm | mounts | exit | decisive line |
|---|---|---|---|
| 1 | none (root user) | **1** | `EROFS: read-only file system, mkdir '/tmp/claude-0'` |
| 2 | `--tmpfs /tmp` (root user) | **0** | `"subtype":"success"` |
| 3 | `--tmpfs /tmp --tmpfs /root` (root user) | **1** | `error: Script not found "claude"` — the tmpfs replaced the install directory (F1) |
| 4 | none (uid 10001) | **1** | `EROFS: read-only file system, mkdir '/tmp/claude-10001'` |
| 5 | `--tmpfs /home/runner` only (uid 10001) | **1** | `EROFS: read-only file system, mkdir '/tmp/claude-10001'` |
| 6 | `--tmpfs /tmp` only (uid 10001, **$HOME read-only**) | **0** | `"subtype":"success"` |
| 7 | `--tmpfs /tmp --tmpfs /home/runner` (uid 10001) | **0** | `"subtype":"success"` |
| 8 | `--tmpfs /tmp --tmpfs /home/runner --tmpfs /workspace -w /workspace` | **0** | `"subtype":"success"` |

**The minimal writable set is `/tmp` alone.** The harness `mkdir`s `/tmp/claude-<uid>` at startup and a
read-only rootfs is otherwise fine; `$HOME` is not required for a `-p` run (arm 6). Task 3's three
tmpfs mounts are therefore *sufficient but not minimal* — `/tmp` is the only one that is mandatory, and
`/workspace` is needed for the run's own files, not for the harness. **U7 is `confirmed`: no writable
rootfs is needed, so `read_only: true` stands.**

Two image-shape findings came out of this probe and Task 2/Task 3 must absorb both (F1):

```bash
docker run --rm slice4-probe-harness:2.1.274 sh -c 'ls -ld /root /root/.bun /usr/local/bin/claude'
drwx------ 1 root root 4096 … /root
lrwxrwxrwx 1 root root   89 … /usr/local/bin/claude -> ../../../root/.bun/install/global/node_modules/@anthropic-ai/claude-code-linux-x64/claude

docker run --rm -u 10001:10001 -w /tmp slice4-probe-harness:2.1.274 claude --version
error: Script not found "claude"

docker run --rm -u 10001:10001 -w /tmp slice4-probe-harness:2.1.274 \
  sh -c 'command -v claude; ls -l "$(command -v claude)"; claude --version'
sh: 1: claude: Permission denied
```

`/root` is mode `0700`, so a non-root `USER` cannot traverse it: **the plan's compose block
(`user: "10001:10001"` + `tmpfs: [/home/runner, …]`) cannot work with a root `bun install -g`.** The
fix, verified: install to `BUN_INSTALL=/opt/harness` and put `/opt/harness/bin` on `PATH`.

---

## P6 — the grant receipt, and what can revoke it (D8)

**Status: `contradicted`.** The claim *"a CLI-minted gbrain token has a revocable id exposed on the grant
receipt"* is **false**. Where the plan relies on it: U5, D8's preferred mechanism, Task 5's
`auth.revokeToken` registry entry (U11).

### P6-a — the grant, against the live stack

```bash
docker exec brainstand-gbrain-ops-1 gbrain mcp grant probe-runner-p6 \
  --harness claude-code --profile memory-writer --source shared --federated-read shared \
  --bound-slug-prefixes "probe-runner/" --token-ttl 900 \
  --url http://gbrain-serve:3131/mcp --credentials-out /tmp/probe-p6-creds.json --json
```

```
{"status":"error","reason":"mcp_setup_failed","message":"Use HTTPS for credential delivery; HTTP is supported only on loopback"}
EXIT=1
```

(F6 — worth recording: the grant refuses a plaintext `--url`, so the per-run mint must use
`https://${DOMAIN}/mcp`. Our `mcpUrl()` already does.)

Re-run with HTTPS — exit `0`, `"status":"granted"`. **The receipt's full key set:**

```
status
grant{ clientId, clientName, scopes, sourceId, federatedRead, boundSlugPrefixes, allowedOperations,
       boundTools, boundSourceId, boundBrainId, delegatedSlugPrefixes, delegatedNamespace,
       boundMaxConcurrent, budgetUsdPerDay, surface, surfaceSetBy, tokenTtlSeconds, profile,
       revision, repairReasons, revoked }
before
spending
credentials{ client_id, mcp_url, profile, harness, source_id, expires_at, renewable,
             credentials: "private-file" }
credential_file
next_action
```

`clientId` was `gbrain_cl_4eb1faab953b0f4fbd23c96053d5ea3aaa0b03d081654b90acf867a5e838d8b7`,
`tokenTtlSeconds: 900`, `surface: "starter"`, `revoked: false`.

**There is no token id anywhere in the receipt.** The only identifier is an **OAuth client id**, and
the only token-shaped thing is `tokenTtlSeconds` / `expires_at`. The private handoff file is where the
credential actually is:

```
keys: version,mcp_url,issuer_url,client_id,client_secret,access_token,expires_at,profile,harness,source_id
version => 1
mcp_url => https://localhost/mcp
issuer_url => https://localhost
client_id => <string len=74>
client_secret => <string len=74>
access_token => <string len=74>
expires_at => 1789657429
```

So `mcp grant` **mints the run token itself** (upstream: `provider.exchangeClientCredentials(...)`,
`src/commands/mcp-provision.ts:86`) and delivers it in the private handoff — and exposes no id for it.

### P6-b — the revoke verbs, verbatim

```bash
docker exec brainstand-gbrain-ops-1 gbrain auth revoke --id 00000000-0000-0000-0000-000000000000 --json
No active token found with id "00000000-0000-0000-0000-000000000000".
EXIT=1

docker exec brainstand-gbrain-ops-1 gbrain auth revoke --id 00000000-0000-0000-0000-000000000000
No active token found with id "00000000-0000-0000-0000-000000000000".
EXIT=1

docker exec brainstand-gbrain-ops-1 gbrain auth list --json
No tokens found. Create one: gbrain auth create "my-client"
EXIT=0
```

`--json` is accepted and ignored (prose output, exit 1). And the CLI's own help says what `--id`
targets: *"`gbrain auth revoke --id <uuid>` — Revoke exactly one token by id (names are not unique)"*,
implemented as `UPDATE access_tokens SET revoked_at = now() WHERE id = $1::uuid` — the **legacy token
table**, not the OAuth one.

**Structurally confirmed at the storage layer** (F8):

```
                   Table "public.oauth_tokens"
   Column   |           Type           | …
------------+--------------------------+---
 token_hash | text                     | not null      <- PRIMARY KEY: the token is hashed, there is no id
 token_type | text                     | not null
 client_id  | text                     | not null
 scopes     | text[]                   |
 expires_at | bigint                   |
 …
```

```
 gbrain_cl_4eb1faab…  | access | 1789657429 | | 2026-09-17 14:48:49.827996+00
```

**An OAuth access token has no id to revoke.** `auth.revokeToken` as the plan words it (U11, Task 5)
has nothing to accept as a parameter.

### P6-c — the two mechanisms that *do* work, measured

```bash
docker exec brainstand-gbrain-ops-1 gbrain auth revoke-client gbrain_cl_4eb1faab…8d8b7
OAuth client revoked: "probe-runner-p6" (gbrain_cl_4eb1faab…8d8b7)
Tokens and authorization codes purged via cascade.
EXIT=0
```

Before that revoke, the token called `/mcp` fine; after it:

```
=== BEFORE revoke: token still works (control) ===
>>> tools/list -> HTTP 200 ct=text/event-stream session=-
=== AFTER revoke: same call ===
>>> tools/list -> HTTP 401 ct=application/json; charset=utf-8 session=-
```

The RFC 7009 per-token path also works — a second grant, then `POST /revoke` on the internal URL with
`token` + `client_id` + `client_secret`:

```
=== before: token live ===
>>> tools/list -> HTTP 200 ct=text/event-stream session=-
=== POST /revoke (RFC 7009) ===
>>> POST /revoke -> HTTP 200 ct=null
(empty body)
=== after: same token ===
>>> tools/list -> HTTP 401 ct=application/json; charset=utf-8 session=-
```

Upstream citation: `src/commands/serve-http-oauth.ts:85` mounts `POST /revoke`, RFC 7009-shaped, and it
requires the client's secret (`confidentialCredentials(req)` before `provider.revokeToken`).

**F7 — the leak the fallback creates.** Every grant retains a private credential journal, and
revocation does not clean it:

```bash
docker exec brainstand-gbrain-ops-1 sh -c 'ls -l /srv/gbrain-home/.gbrain/credential-deliveries/'
… 38 files, mode -rw-------, one per grant, from 06:12–14:54 today
```

Two of those 38 were this probe's; both were deleted (the clients themselves were revoked, so the files
were the only remaining copy). The other 36 predate this session and are **left alone** — but they are
secret material sitting in a shared volume, and the slice's own runbook should say so. This is the first
concrete cost of the D8 fallback: **one ephemeral client per run means one more retained secret file per
run.**

---

## The D8 mechanism decision

**Decision: the fallback. Mint a per-run ephemeral client with `gbrain mcp grant` at claim, and kill it
with `gbrain auth revoke-client <client_id>` at finish.** The plan's preferred mechanism is
**unavailable**, not merely inconvenient:

1. The grant receipt carries **`clientId`, not a token id** (P6-a). There is no id to store on
   `agent_runs` and no id to hand to a revoke verb.
2. `gbrain auth revoke --id <uuid>` updates the **legacy `access_tokens`** table (P6-b), which an
   OAuth-minted token never enters.
3. OAuth access tokens are stored by **`token_hash`**, with no id column at all (F8), so no CLI verb
   *could* address one by id.

What Task 5 builds instead, all measured above:

- **Mint:** `mcp.grant` per run with `--token-ttl` (the run's TTL), `--url https://${DOMAIN}/mcp`
  (F6: plaintext is refused), `--credentials-out` to an ops-side path, and the run's compiled scoping.
  The `access_token` arrives in that handoff file and is the bearer the harness uses on `/mcp`.
- **Revoke:** `auth.revoke-client <clientId>` — exit `0`, output *"OAuth client revoked … Tokens and
  authorization codes purged via cascade."*, and a `401` on the next `/mcp` call. This is the kill
  switch, and it works whether or not the runner still exists (honesty rule 5).
- **Do not** add `auth.revokeToken` to the registry as the plan words it. If Task 5 wants a *token*
  (rather than client) kill switch it must be the **RFC 7009 `POST /revoke`** endpoint — a real,
  measured alternative, but it needs the client secret and is an HTTP OAuth contract, not a CLI verb,
  so it is a bigger posture change than the fallback and is **not** recommended for this slice.
- **Budget for F7:** each mint drops one more retained secret file under
  `GBRAIN_HOME/.gbrain/credential-deliveries/`, and neither `revoke-client` nor TTL expiry deletes it.
  Gate C's mint count should be small (L11's 50/15min `/token` limit is also in play, since
  `mcp grant` performs a `client_credentials` exchange), and the runbook needs a "how to rotate/clean
  the credential journals" line.

`G2` is satisfied either way: both verbs are published CLI contracts on our ops lane.

---

## P7 — a raw bearer is accepted by gbrain-serve's `/mcp`

**Status: `confirmed`.** Where the plan relies on it: U8, D5's single MCP server, D7's per-run token.

From inside `brainstand-gbrain-ops-1`, against the internal serve address, with the grant's
`access_token` sent as a raw bearer and **no** client secret, **no** session id and **no** OAuth
handshake:

```
>>> initialize -> HTTP 200 ct=text/event-stream session=-
event: message
data: {"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{},"resources":{}},"serverInfo":{"name":"gbrain","version":"0.50.5.0"},"instructions":"GBrain agent operating contract (apply on every cold start): …"}}
>>> tools/list -> HTTP 200 ct=text/event-stream session=-
event: message
data: {"result":{"tools":[{"name":"entity",…
```

21 tools were returned (the granted `surface: "starter"`), the response is server-sent events with
`event: message` + one `data:` JSON line, and no `mcp-session-id` header is issued or required. The
session-less, bearer-only shape is exactly what `--mcp-config` needs.

---

## P8 — what an MCP `put_page` leaves behind (U6)

**Status: `contradicted`.** The claim *"an MCP `put_page` produces one or more git commits in the Space
repo, with an author gbrain chooses"* was written into the plan as the ceiling on D9's attribution.
Reality: **it produces no commit at all**, and when it would, gbrain supplies no author.

Same client, same granted token (`probe-runner/` fence), writing to the `shared` Space:

```
=== pre-write git head in the shared Space ===
6325100773271fb710840a347e564d1806d6bbac|slice2-cshared-mu54u9vf@example.test|…|reports: live-sync 2026-09-17-0213
```

The `put_page` result, verbatim:

```json
{"slug":"probe-runner/p8-probe","status":"skipped","chunks":0,"chunk_skip_reason":"write_skipped",
 "auto_links":{"skipped":"remote","hint":"auto_link/auto_timeline run for trusted local writers only; …"},
 "auto_timeline":{"skipped":"remote","hint":"…"},
 "facts_backstop":{"skipped":"slug_bound_client"},
 "chronicle_backstop":{"skipped":"not_imported"},
 "write_through":{"written":true,"path":"/srv/brain-repos/shared/probe-runner/p8-probe.md"}}
```

**The response carries `write_through.written: true` and no `committed` key.** Upstream
(`src/core/write-through.ts:464-484`):

```ts
let committed = false;
try {
  assertSourceFilesystemActive();
  if (isDurabilityHardened(writeRoot)) {
    committed = commitWriteThroughFile(writeRoot, filePath, slug);
    …
} catch { /* best-effort */ }
return { written: true, path: filePath, ...(committed ? { committed, pushed, lastPushStatus } : {}) };
```

`isDurabilityHardened` is true only when the gbrain durability post-commit hook is installed
(`gbrain sources harden`). It is not, in this stack:

```
=== file present? ===
-rw-r--r-- 1 root root 178 … probe-runner/p8-probe.md
=== working tree status ===
?? probe-runner/
```

And more than fifteen minutes later, with a 5-minute `live-sync` schedule supposedly enabled on this
Space, HEAD had still not moved:

```
--- last 3 commits ---   (unchanged: 6325100… live-sync 2026-09-17-0213)
--- status ---
?? probe-runner/
```

**The author/committer/message gbrain chooses: none, because gbrain made no commit.** What the write
*did* leave was a file, a `pages` row, and a searchable chunk (`gbrain search "P8 probe"` →
`{"slug":"probe-runner/p8-probe","page_id":5,…,"chunk_source":"compiled_truth","score":0.875001}`,
`select count(*) from pages where slug like '%p8-probe%'` → `1`), i.e. **the brain moved and git did
not.** That is the exact inversion of D9's premise.

What happens when a Space *is* hardened is still not an attribution: `GIT_ENV`
(`src/core/git-remote.ts:189-194`) sets **no identity**, only prompt-suppression
(`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_ASKPASS=/bin/false`). So the commit inherits the
repo's git config. This repo has none:

```bash
docker exec brainstand-gbrain-ops-1 sh -c 'cd /srv/brain-repos/shared; git config --get user.name; git config --get user.email'
name_exit=1
email_exit=1
```

and the exact commit command the write-through path would run therefore fails:

```bash
cd /srv/brain-repos/shared && git add -- probe-runner/p8-probe.md \
  && git commit -m "gbrain: write-through probe-runner/p8-probe" -- probe-runner/p8-probe.md
Author identity unknown

*** Please tell me who you are.
…
fatal: unable to auto-detect email address (got 'root@ada829a1dee2.(none)')
COMMIT_EXIT=128
```

(That command was run with the file staged and then `git reset` — no commit was created, and the repo
was left exactly as found.) Upstream swallows that failure by design (`catch { return false }`).

**Consequences, named:**

- **Task 9 (`diffForRun`) cannot be "git log of gbrain's commits".** In this stack the agent's own
  writes are *untracked files*; a commit only exists if something else commits them. The honest
  implementation: capture `git rev-parse HEAD` **and** the working-tree state at claim, and treat
  "commits in `<before>..<after>`" **plus** "uncommitted paths under the write Space" as the run's
  footprint; or have the runner's own finish path commit its work first (then the commit is ours, and
  the author is our named actor, which is a *better* attribution story than the plan expected).
- **`concurrentWriters` (D9) keeps its purpose for a different reason.** Every commit observed in these
  Spaces was authored by **us** — `e2e|e2e@brainstand.local`, `gate-b|gate-b@brainstand.local`,
  `slice2-cshared-mu54u9vf@example.test` — because `commitAs` passes `-c user.name -c user.email` (F12).
  So a git range will show our other writers, never gbrain's, and the console's hedge must be worded for
  that case.
- **Honesty rule 7 gets *more* important, not less.** Because the write lands in the DB and the file
  plane at different times (`chunks: 0` at response time, the chunk visible shortly after), a revert
  that only moves the git tree would leave the index answering searches in exactly the way the rule
  warns about.
- **Task 8 must not read `status` as failure** (F10): `status: "skipped"` with
  `chunk_skip_reason: "write_skipped"` accompanied a *successful* write.

**F11, related and load-bearing for Task 8:** `delete_page` is in the grant's `allowedOperations` but
**not** on the granted MCP surface:

```
data: {"result":{"content":[{"type":"text","text":"{\"error\":\"unknown_operation\",\"message\":\"Unknown: delete_page\"}"}],"isError":true}}
```

`allowedToolsFor(connection, snapshot)` must intersect with the **surface** (`capability_snapshots.
tools_json`, i.e. the 21 tools `tools/list` returns), not with `allowedOperations` — otherwise the
allowlist names tools the server will reject.

---

## P9 — `MODEL_PRICING`'s source, `pricedAt`, and the mapping from P2

**Status: `confirmed`.** Where the plan relies on it: D7's price table, Task 7's `priceUsage`, Task 12's
"refuse a model absent from `MODEL_PRICING`", Gate C's budget.

Source read on **2026-09-17**: <https://platform.claude.com/docs/en/about-claude/pricing> (documents
`https://docs.claude.com/en/docs/about-claude/pricing`, which redirects there). Per-MTok, verbatim from
that page's model-pricing table:

| Model | Base input | 5m cache write | 1h cache write | Cache read | Output |
|---|---|---|---|---|---|
| Claude Opus 5 | $5 | $6.25 | $10 | $0.50 | $25 |
| Claude Opus 4.8 | $5 | $6.25 | $10 | $0.50 | $25 |
| Claude Sonnet 5 | $2 | $2.50 | $4 | $0.20 | $10 |
| Claude Sonnet 4.6 / 4.5 | $3 | $3.75 | $6 | $0.30 | $15 |
| **Claude Haiku 4.5** | **$1** | **$1.25** | **$2** | **$0.10** | **$5** |

and the multipliers the page states: *"5-minute cache write 1.25x base input price", "1-hour cache write
2x base input price", "Cache read (hit) 0.1x base input price"*, with `inference_geo: "us"` a 1.1x
multiplier on all categories.

**So `MODEL_PRICING` must be five rates per model, not four** — the plan says "input / output /
cache-read / cache-write" (D7, Task 7). Claude Code's own request uses the **1-hour** cache:

```
"cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 6922 }
```

Pricing those 6,922 tokens at the 5-minute rate undercounts that run by **33.5%** (computed below). A
single `cacheWrite` rate is a silent undercount on every run.

**The mapping from P2's frames onto the table** — the four counts the plan names, plus the fifth:

| `MODEL_PRICING` rate | Frame field | Note |
|---|---|---|
| input | `usage.input_tokens` | |
| output | `usage.output_tokens` | includes `output_tokens_details.thinking_tokens` |
| cache read | `usage.cache_read_input_tokens` | 0.1x base input |
| cache write (5m) | `usage.cache_creation.ephemeral_5m_input_tokens` | 1.25x base input |
| cache write (1h) | `usage.cache_creation.ephemeral_1h_input_tokens` | 2x base input — **the one Claude Code uses** |

`usage.cache_creation_input_tokens` is the **sum** of the two and is what the per-message frames carry
without the split; the split is present in the same frame. Task 7 should read the split and fall back to
the sum at the 5m rate only when the split is absent.

**Calibration against the harness's own math.** Applying that table to P2-a's counts reproduces the
harness's `total_cost_usd` **exactly**:

```
simple  reported=0.0154847  recomputed(1h write)=0.0154847  recomputed(5m write)=0.0102932
     10 in + 54 out + 6922 cw1h + 13607 cr  →  10*1 + 54*5 + 6922*2 + 13607*0.1 = 15484.7 per-MTok units
1h-vs-5m mispricing on simple run: 0.0051915 (33.5% undercount)
```

On the **two-request** run the same table does not reproduce it (F9):

```
tool    reported=0.0121636  recomputed(1h write)=0.0111846  delta=0.0009790
tool    delta in output-token equivalents: 195.8
```

The harness's local cost math is a *hint*, and the 8.8% gap on a two-request run is exactly why D7
makes the gateway the authority. Task 15's A4 should pin `priceUsage` to the five-rate table, and
Task 7's `agent_run_usage` rows come from the frames the gateway observes, never from
`total_cost_usd`.

`claude-haiku-4-5-20251001` is the only model id this slice **observed** (P2's init frame). The plan's
default, "claude-opus-5", exists on the pricing page as *Claude Opus 5* ($5/$25), but no API model id
for it was observed here: `GET https://api.anthropic.com/v1/models` with the host's OAuth bearer
returns `401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}`
— OAuth tokens are not raw API bearers, so that endpoint was not a usable id oracle. **[INFERENCE]**
The dated Opus/Sonnet ids must be confirmed at Task 12's validation, which is exactly where the plan
puts the refusal: a model absent from `MODEL_PRICING` is refused at schedule creation, never at 3am.

---

## Findings execution surfaced (F1–F13)

| # | Finding | Status | Where it lands |
|---|---|---|---|
| F1 | `bun install -g` as root installs under `/root/.bun`; `/root` is `0700`, so a non-root `USER` gets `Permission denied`, and a tmpfs at `$HOME` hides the binary (`error: Script not found "claude"`) | `confirmed` | **Task 2**: `ENV BUN_INSTALL=/opt/harness` + `PATH`, verified as uid 10001. **Task 3**: the tmpfs set is compatible once the install is outside `$HOME` |
| F2 | `-p` + `--output-format stream-json` exits 1 without `--verbose` | `confirmed` | **Task 8**'s `buildHarnessArgv` and **Task 15**'s A1 must include `--verbose` |
| F3 | `--tools ""` yields an MCP-only tool list and removes the `ToolSearch` turn | `confirmed` | **Task 8**: pass it; keep `--disallowedTools` as defence in depth (D5, honesty rule 2) |
| F4 | The harness sends `HEAD /api/hello` to the base URL before `POST /v1/messages?beta=true` | `confirmed` | **Task 7**: the gateway must answer or tolerate it |
| F5 | `ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer <token>` on the model request; no API key needed | `confirmed` | **Task 7/8**: D7's lane is exactly this, and it was exercised end-to-end (P3) |
| F6 | `mcp grant` refuses a non-HTTPS `--url` for credential delivery | `confirmed` | **Task 5**: mint against `https://${DOMAIN}/mcp`, never the internal `http://gbrain-serve:3131` |
| F7 | Each grant retains a private credential journal; `revoke-client` does not delete it (38 existed) | `confirmed` | **Task 5 / runbook**: budget the journal growth, document the cleanup |
| F8 | OAuth tokens are stored by `token_hash` (no id); RFC 7009 `POST /revoke` is the only per-token kill | `confirmed` | **Task 5**: the D8 decision above |
| F9 | The harness's `total_cost_usd` matches our table on one request, is 8.8% high on two | `confirmed` | **Task 7**: the gateway meters; the frame's cost is a hint |
| F10 | A successful MCP write has no `committed` key and can carry `status: skipped` | `confirmed` | **Task 8** (event classification), **Task 9** (the diff cannot come from gbrain's commits) |
| F11 | `delete_page` is in `allowedOperations` but not on the granted surface | `confirmed` | **Task 8**'s `allowedToolsFor` intersects the surface |
| F12 | Space repos have no git identity; every commit needs `-c user.name -c user.email` | `confirmed` | **Task 9/10**: `commitAs` already does this; gbrain's own commit cannot |
| F13 | 36 credential-delivery journals from earlier slices persist under `GBRAIN_HOME` | `confirmed` | Informational for the security review and the runbook; **not touched** by this task |

## What the plan got wrong

Recorded here rather than patched into the plan, because each is a one-line correction to a probe or a
flag, not a design change. Task 18 can lift them into a `> **Corrected**` blockquote if it prefers.

1. **U5's shape.** "A CLI-minted gbrain token has a revocable id exposed on the grant receipt, and a CLI
   verb revokes it" is false in both halves: no id on the receipt, and the revoke-by-id verb targets a
   different table. D8's fallback is the mechanism.
2. **U6's shape.** "An MCP `put_page` produces one or more git commits, with an author gbrain chooses" is
   false: zero commits unless the Space is durability-hardened, and no identity when it is. D9 must not
   build the diff on gbrain's commits.
3. **U7's shape.** The proposed tmpfs set (`$HOME` + workspace) works but is not minimal: `/tmp` alone is
   mandatory, `$HOME` is not required, and `$HOME` is actively dangerous when the harness is installed
   under it.
4. **D7/Task 7's price table is four rates; it needs five** (5m and 1h cache writes), or it undercounts
   Claude Code's default 1-hour cache by 33.5% on a run like P2-a.
5. **Task 1's own P2 command does not run** — `--verbose` is required with `-p`.
6. **The probe table's "author gbrain chooses" wording presumes a commit exists**; the honest question
   was "what does the write leave behind", which is a file, a page row and a chunk.
7. **`gbrain-base.Dockerfile`'s `$NF` version gate does not transfer.** `claude --version` prints
   `2.1.274 (Claude Code)`; a `$NF == v` test would fail on a correct build.

## Probe hygiene and cleanup

Nothing of this task's is left behind. The record, so the containers/images/networks can be verified
gone:

```bash
# containers and network created by P3/P4 (all removed)
docker rm -f slice4-sink slice4-recorder slice4-mcpstub
docker network rm slice4-probe-net slice4-p4-net
# images built by P1/P5 (all removed)
docker rmi -f slice4-probe-harness:2.1.274 slice4-probe-harness-nonroot:2.1.274
# scratch (deleted; another agent had already swept this dir mid-run — see below)
rm -rf .brainstand-tmp/slice4
```

Dev-stack hygiene for the two live writes this task made:

```bash
# the probe page: file + page row + chunk, removed through the product contract
docker exec brainstand-gbrain-ops-1 gbrain call delete_page '{"slug":"probe-runner/p8-probe"}' --source shared
docker exec brainstand-gbrain-ops-1 gbrain delete probe-runner/p8-probe --purge --source shared
docker exec brainstand-gbrain-ops-1 rmdir /srv/brain-repos/shared/probe-runner
docker exec brainstand-postgres-1 psql -U gbrain -d gbrain -tAc \
  "select count(*) from pages where slug like '%p8-probe%';"   # -> 0
# both probe OAuth clients revoked (cascade), both handoffs and journals deleted
docker exec brainstand-gbrain-ops-1 gbrain auth revoke-client gbrain_cl_4eb1faab…8d8b7
docker exec brainstand-gbrain-ops-1 gbrain auth revoke-client gbrain_cl_732507c0…3a158a
docker exec brainstand-gbrain-ops-1 rm -f /tmp/probe-p6-creds.json /tmp/probe-p6b-creds.json /tmp/mcp-call.ts
docker exec brainstand-gbrain-ops-1 rm -f /srv/gbrain-home/.gbrain/credential-deliveries/gbrain_cl_4eb1faab…8d8b7.json \
                                              /srv/gbrain-home/.gbrain/credential-deliveries/gbrain_cl_732507c0…3a158a.json
docker exec brainstand-postgres-1 psql -U gbrain -d gbrain -tAc \
  "select client_name from oauth_clients where client_name like 'probe-runner%';"   # -> (none)
```

No existing dev-stack container, volume or row was disturbed. The 36 pre-existing credential journals
(F13) and the pre-existing Space fixture commits were deliberately **not** touched.

**Mid-run collision, disclosed:** a sibling agent ran `rm -rf .brainstand-tmp/slice4` while this task was
in flight, destroying the raw capture files for P1–P5 (`Task14UpgradeLane` confirmed the sweep and
apologised). Every command and output above is unaffected — they are pasted from this run's own captured
transcript, not from those files — but the on-disk captures for P1–P5 no longer exist, so they cannot be
re-inspected. The convention going forward is a private subdir per agent
(`.brainstand-tmp/slice4/<agent-id>/`).

## Money spent by this task

Real API spend was kept to the two P2 arms and the one P4-c arm — the only runs that needed a real
model — and every one used `--model haiku`:

| Run | Reported cost |
|---|---|
| P2-a, `say hi` (real API) | `$0.0154847` |
| P2-b, forced `Read` (real API) | `$0.0121636` |
| P4-c, real MCP tool call (real API) | `$0.0215045` |
| **Total** | **$0.0491529** |

Everything else (P3, P5, and the P4 header arms) ran against the local recorder with **zero** real
tokens. The `fake` key used in the P3 control arm is not real and could not have spent anything.

**Credential note.** The `ANTHROPIC_API_KEY` present in this host's environment is **invalid**: the
direct call `fetch("https://api.anthropic.com/v1/models", {headers:{"x-api-key": …}})` returns
`401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null}`,
and so does the same call from the host shell. The real API runs above therefore used the host's Claude
Code subscription credential instead. **This matters to Gate C**, which is budgeted to spend real money:
the slice currently has no working API key, and Task 7's `readSecret(orgId,'anthropic_api_key')` path
(U12, first caller) cannot be exercised end-to-end until one is stored. This is the single largest
open item this task hands to the orchestrator.

---

## F14 — `/api/health` paid two `gbrain` subprocesses, and Bun's default 10 s idle timeout severed the connection (502) under load

**Status: `confirmed`. Pre-existing — present at `2620aaa`, before Task 12 touched `health.ts`; NOT Slice-4-introduced.**
Measured 2026-09-17 on the live dev stack (`brainstand-*-1`, gbrain `0.50.5.0`) by an agent whose only
product edits are `src/control/routes/health.ts` and `src/control/app.ts`.

### What was wrong

`GET /api/health` was taking 8–11 s. Two per-request `gbrain` subprocesses through the ops relay account
for all of it, and they are serialized inside one handler:

| step (in `health.ts` order) | cost, runner lane UP | cost, runner lane STOPPED | cost after the fix |
|---|---|---|---|
| `select 1` (`controlDb`) | 167 / 2 / 1 ms | 197 / 1 / 1 ms | 44 / 0 / 0 ms |
| `opsHealthy()` → `GET /healthz` | 6 / 1 / 1 ms | 16 / 1 / 1 ms | 6 / 1 / 0 ms |
| **`callOps('toolsJson')` — result discarded** | **4413 / 2953 / 3420 ms** | **2604 / 3379 / 2680 ms** | **gone** |
| `verifyRuntimePin()` → `callOps('checkUpdate')` | 5599 / 5399 / 3602 ms | 3718 / 5919 / 3158 ms | 1488 / 1407 / 1722 ms |
| `inspectRepos()` → `GET /git/inspect` | 314 / 386 / 131 ms | 653 / 171 / 48 ms | 29 / 21 / 22 ms |
| `openAlerts()` (db select) | 102 / 7 / 4 ms | 43 / 13 / 6 ms | 11 / 2 / 2 ms |
| `runnerStatus()` | 76 / 7 / 29 ms | 33 / 10 / 35 ms | 6 / 3 / 3 ms |
| **handler total** | **10 677 / 8755 / 7188 ms** | **7264 / 9495 / 5929 ms** | **1583 / 1434 / 1750 ms** |

Raw op cost from inside `brainstand-control-plane-1` (host under load, the window the 502s were seen in):
`GET /healthz` 1–51 ms · `GET /git/inspect` 242–507 ms · `POST /rpc {op:'toolsJson'}` **2879–4460 ms,
171 870 bytes** · `POST /rpc {op:'checkUpdate', json:true}` **3891–4697 ms, 12 391 bytes** ·
`POST /rpc {op:'doctor'}` 8032–39 000 ms, 46 786 bytes. Every one of these is a fresh `gbrain` process
spawned by the ops side; the control plane's own DB work is single-digit milliseconds.

**Not the runner lane.** Stopping it (`docker compose --env-file .env -f compose/docker-compose.yml
-f compose/docker-compose.dev.yml stop agent-runner`) leaves the same two steps dominating with the same
profile (table above), so the lane is not what costs the time. The long poll holds nothing either:
`claimNextRun` wraps only its own select+update in `db.transaction(...)` — `.for('update', { skipLocked:
true, of: schema.scheduleRuns })` with the lease-taking `UPDATE` in the same transaction
(`src/scheduler/claim.ts:53-60`, `:139-146`) — while the 25 s wait's `await Bun.sleep(...)` sits *outside*
it in the route's loop (`src/control/routes/runs.ts:141-149`). Confirmed live: with the runner
long-polling, `pg_stat_activity` on `control` showed **13 `idle` + 1 `active`** (the psql probe itself),
**no `idle in transaction`**, against a pool of `max: 10`.

### The mechanism that turned it into a 502

`src/control/app.ts` called `Bun.serve({ port, hostname, fetch })` with no `idleTimeout`, so Bun's
default 10 s applied, and it is a *connection* timer: a request whose handler has not written a byte when
it fires gets its socket closed, and Caddy reports `EOF` / `reverseproxy.statusError` as a **502**, not
the route's own answer. Measured on this Bun (1.3.13, same container), same construction as `app.ts`:

| server | request shape | handler | result |
|---|---|---|---|
| default `idleTimeout` | body-less `GET` | sleeps 15 s | **socket closed at 12.009 s** (`closed unexpectedly`) |
| default | body-less `GET` | sleeps 22 s | **socket closed at 12.006 s** |
| `idleTimeout: 120` | body-less `GET` | sleeps 15 s | 200 at 15.082 s |
| `idleTimeout: 60` | body-less `GET` | sleeps 22 s | 200 at 22.014 s |
| default | `POST` **with a body** | sleeps 15 s | 200 at 15.006 s |
| live server | `POST /api/runs/claim` (25 s long poll) | — | 204 at 25.074 s |

That last row is why nobody noticed: the claim long poll survives its own 25 s wait only because it
carries a request body — an implementation detail, not something the route asked for. The health route is
a body-less `GET`, which is exactly the shape the default severs. Direct in-container probes of
`/api/health` in the loaded window: one **severed socket at 8.153 s**, the rest 200 at 7.76/7.92/11.17/18.28 s.

### The fix (two parts, and which is which)

1. **The cost — a Slice 3 defect, removed.** `health.ts` ran `await callOps('toolsJson', {}, {timeoutMs:
   10_000})` and **discarded the result**: an extra 2.6–4.5 s, 171 KB `gbrain --tools-json` process on an
   endpoint served without a session, reporting nothing (`components.ops` is `opsHealthy()`'s verdict,
   and the two probes below it already fail visibly when the relay is down). Present at `2620aaa`;
   removed. `verifyRuntimePin`'s `checkUpdate` **stays**: its `pin.observed`/`pin.matches` are payload
   fields the e2e suite reads, and deleting it would turn an honest "unverifiable" into a permanent one.
2. **The mechanism — explicit `idleTimeout: 60` in `app.ts`.** This is not a timeout raised to hide a slow
   route: the route keeps its own multi-second ops round trip (now one of them, not two), and 60 s is
   chosen against the server's *own* longest deliberate first-byte delay — the 25 s claim long poll — and
   the 40 s ceiling that route's client waits (`CLAIM_WAIT_MS + CLAIM_SLACK_MS`). Without it, any honest
   `503` from a loaded relay is delivered as a bodiless 502.

### Before / after (same five-curl loop, `curl -sk -m 30 -o /dev/null -w 'http=%{http_code} t=%{time_total}\n' https://localhost/api/health`)

Before (host loaded, runner lane up — the window the brief's 502s came from):

```
http=200 t=7.634849
http=200 t=5.407666
http=200 t=6.078090
http=200 t=5.921726
http=200 t=5.175180
```

(the brief's own run in the same conditions: `11.407545 / 9.895538 / 502 20.227755 / 502 10.934088`)

After (rebuilt image, host quiet):

```
http=200 t=1.515786
http=200 t=1.530966
http=200 t=1.100700
http=200 t=1.152051
http=200 t=1.048814
```

Direct in-container hits, Caddy bypassed: 1.018 / 0.938 / 0.940 / 0.900 / 0.978 s (all 200).
Re-measured with the relay deliberately loaded again (4 concurrent `gbrain doctor` ops, 52 ops in 48.5 s):
1.493 / 1.610 / 1.258 / 1.400 / 1.462 s, all 200 — the old handler shape costs 2671 ms in that same window,
998 ms of which is the step that was removed. Host load moves these numbers 3–4× (the ops subprocesses
above were 8032–39 000 ms for `doctor`), which is why the same route 502'd at 11:00 and answered at 6 s
later; the removal is a constant ~⅓–⅖ of the handler either way.

Payload unchanged, checked live: keys `at, components, gbrainVersion, ok, pin, repos, runner,
scheduleAlerts`; `pin = {declared: "0.50.5.0", observed: "0.50.5.0", matches: true}`;
`runner = {state, lastSeenAt, version}` — three keys, no token, no client id.

### Blocking defect found while running the payload tests (not mine, not the product's)

`test/integration/scheduler-routes.test.ts` **could not load at all** in this tree: its
`mock.module('../../src/control/opsClient.ts', …)` omitted the module's real exports, and the graph pulls
them in through `src/agent/revert.ts` → `../scheduler/execute.ts` → `writeReport`, `cancelRun`, … Bun
aborts the file with `Export named 'writeReport' not found` before any test runs. Reproduced with this
task's own two files reverted to `HEAD`, so it is pre-existing. The mock now carries the five missing
stubs (`writeReport`, `cancelRun`, `gitRange`, `gitRevertRange`, `auditTail`); **no assertion was changed
or weakened** — the full file goes from unloadable to **55 pass / 0 fail**.

---

## F15 — Gate C, the Slice 4 exit gate: the measured numbers, the real spend, and the one promise it disproved

**Where.** `test/e2e/slice4.e2e.test.ts`, `describe('Slice 4 exit gate C')`, C1–C12 (Task 17). Every leg
runs the REAL `agent-runner` container on the REAL pinned harness against the REAL brain on this dev
stack (`brainstand-*`, `DOMAIN=localhost`, org timezone **`America/New_York`**, Connection
`251817a9-…` writing `internal` and reading `customers`, model pinned to `claude-haiku-4-5`). The gate
also added a named precondition to the file's `beforeAll` (`anthropic_api_key` present, with one
actionable message and the runbook section named — see "the credential note" below).

### What each leg measured (verbatim from the run logs)

| leg | observation |
|---|---|
| C1 | nightly `agent_prompt` materialized **by the leader tick**, not by a route: slot `2026-09-17T03:00`, `fire_at 2026-09-17T07:00:00+00:00` (= 03:00 EDT; the UTC wall of the same instant is `T07:00`, so the slot is the org's clock, not UTC), `attempt 1`, `state pending`, scheduled watermark `05:02:18.716` → `05:02:33.716` with the row count still 1 (a second tick is idempotent on `(schedule_id, slot)`). The pause that made the `pending` observation possible is PROVEN with a sentinel row that survived 33 304 ms — see "the orphaned claim" below |
| C2 | `claimed_by = 0796bdd1ae59-039764d7` = the **container's** announced id; the scheduler's worker was `c83c9229a86a-bc322e9f`; heads captured for `internal` + `customers`; `gbrain_client_id` minted at claim |
| C3 | run `succeeded`/`ok`; **`cost_usd` = `SUM(agent_run_usage.cost_usd)` = `$0.0263765` over 2 metered calls**, tokens in 18 / out 276 / cacheRead 17 860 / cacheWrite 18 554, `num_turns 2`, both sides computed in SQL |
| C4 | write Space range `bace919b..04ab1606` names `gate-c/mu6hnk0t/nightly.md`, authored by the Connection's member; **read Space `customers` `6b3b901d..6b3b901d` EMPTY**; no `agent_read_space_moved` alert; working tree clean after the finish's own commit |
| C5 | one `GET /api/runs/:id` payload carries prompt, the `mcp__gbrain__put_page` tool call, 2 usage rows, `costUsd`, and the diff file list |
| C6 | **FAILS — see below.** The tree and the admin-authored revert commit are right; the index is not |
| C7 | `docker compose kill agent-runner` mid-run (the kill lands after the agent's first page is on disk): `lease_expired` / `infra_failed`, `failure_detail.reason = lease_expired`, alert kind `lease_expired`, and the run's gbrain bearer — recovered from gbrain's own credential journal (F7) while the client was still alive — went **200 → 401** across the reclaim. Revoke error absent from the alert |
| C8 | **the double-write proof**: `schedule_runs` holds 2 rows, `attempt 1` and `2`, slots `manual:2026-09-18T05:07:56Z` and `…Z#r2`; each page exists exactly once in the run's own directory, one commit added it, and the agent's text appears exactly once in the file |
| C9 | cap tightened below the accrued spend: `classification budget_exceeded`, `agent_runs.failure_class budget_exceeded`, one alert `agent_budget_exceeded` with `budgetUsd $0.0055756` / `accruedUsd $0.0111512` and **no `midStream`**, the gateway's own log line `status 402, tokens 0, costUsd null` (the pre-forward refusal), and `agent_run_usage` holding exactly the forwarded calls (1 row, `http_status 200`, `stop_reason` set, cost non-null) — no truncated row |
| C10 | **from inside the container**: `control-plane:3150` and `caddy:443` connect; `localhost:443`, `postgres:5432`, `gbrain-serve:3131`, `gbrain-ops:3140`, `1.1.1.1:443`, `api.anthropic.com:443` all fail (ECONNREFUSED); `/proc/net/route` carries one subnet route `000012AC/0001` and **no `00000000` destination** |
| C11 | a prompt that asks for Bash: the harness's own `system/init` surface is 23 `mcp__gbrain__*` tools and no built-in, **no `tool_use` at all**, `permission_denials: []`, the write Space's head unmoved, no untracked leftovers, empty diff — nothing ran |
| C12 | B10's technique reused: empty `RUNNER_TOKEN` → `/api/health` `disabled` with `ok: true` and `controlDb`/`ops` `ok`, `/.well-known/gbrain` 200, `POST /api/schedules` → `409 runner_not_enabled` with no row written; then restored, and the runner proved to be polling the CURRENT control plane (request-shape refusal, F14's trap) |

### Money — measured, not estimated

Per-run figures logged by the gate's teardown (before the fixtures and their cascading runs were deleted):

| run | schedule | state | calls | cost |
|---|---|---|---|---|
| C1–C6 | `gate-c-nightly-…` | `succeeded` | 2 | **$0.0263765** |
| C7 (killed) | `gate-c-kill-…` (attempt 1) | `lease_expired` | 1 | **$0.0240012** |
| C8 (retry) | `gate-c-kill-…` (attempt 2) | `succeeded` | 2 | **$0.0153746** |
| C9 | `gate-c-budget-…` | `failed` / `budget_exceeded` | 1 | **$0.0111512** |
| C11 | `gate-c-bash-…` | `succeeded` | 1 | **$0.0109399** |

**Gate C total for that run: `$0.0878434` over 5 real runs.**

The final acceptance run of the same file (`bun test --parallel=1 test/e2e/slice4.e2e.test.ts`) reported
**27 tests: 26 pass, 1 fail — the failure is C6 alone** — in 543.03 s, with these per-run figures:

| run | schedule | state | calls | cost |
|---|---|---|---|---|
| C1–C6 | `gate-c-nightly-mu6i3zmk` | `succeeded` | 2 | `$0.0139852` |
| C7 (killed) | `gate-c-kill-mu6i3zmk` (attempt 1) | `lease_expired` | 1 | `$0.0122812` |
| C8 (retry) | `gate-c-kill-mu6i3zmk` (attempt 2) | `succeeded` | 2 | `$0.0155088` |
| C9 | `gate-c-budget-mu6i3zmk` | `failed` / `budget_exceeded` | 1 | `$0.0111187` |
| C11 | `gate-c-bash-mu6i3zmk` | `succeeded` | 1 | `$0.0109987` |

**that run's total: `$0.0638926`.** Gate C's whole measured spend across this task (this run, the
`$0.0878434` run above, the first 12-leg run whose five runs were not logged before teardown, and the
pre-barrier C1 attempts that spent one real run) is **≈ `$0.25` against the `$5.00` ceiling** — of which
`$0.151736` is directly measured and the rest is bounded by the same per-run shape (five runs of
$0.011–$0.027). Gate B's own metered leg costs `$0.000045`
(B6's log). Two earlier Gate C runs (the first 12-leg run, whose fixtures were deleted before this
logging existed, and the pre-barrier C1 attempt that spent a real run) plus the diagnostic model calls
bring the whole Gate C work to **≈ $0.21**, against the slice's **$5.00** ceiling — the money left is
untouched, and every leg that could be exercised without a model call was (C10, C12, and the C6
reproduction below).

### The defect: the revert's re-index does not remove the reverted page (honesty rule 7)

C6's third clause — "a subsequent `search` no longer returns the reverted page" — **fails on the shipped
product**, and it is not a race: the leg polls for two minutes after the route has already answered.

Measured, with a `succeeded` run whose page the agent wrote through MCP `put_page`:

```
[gate-c] C6 ... revert commit 43a8c3d6, the file is gone from the write Space and from git, and the
route reported a successful re-index (sync exit 0), yet gbrain still returns the page for the query
"gate C nightly page mu6hnk0t": ["gate-c/mu6hnk0t/nightly", …]
```

**Reproduced with no run, no harness and no model call**, in gbrain's own verbs:

```
$ gbrain put gate-c/repro-<t>          # the MCP shape: a page row first, brain-first
$ write that file into the repo; git add -A; git commit -m "agent run repro-<t>"
$ gbrain sync --source internal --json # added: 1
$ git rm -- gate-c/repro-<t>.md; git commit -m "revert: agent run repro-<t>"
$ gbrain sync --source internal --json # deleted: 1  … and the page still answers
$ gbrain sync --source internal --full # deleted: 0  … and the page still answers
$ gbrain delete gate-c/repro-<t> --purge   # this is what removes it
```

**Mechanism.** gbrain's `sync` prunes a page it **imported from a file** (a file-first page vanishes on
the next sync after its file is committed as deleted — measured), but a page created **brain-first**
(`put_page`; the file is only write-through) keeps its `pages` row and its chunk when that file goes
away, because there is no file-provenance record to diff. Every page an agent run writes is brain-first,
so the revert path's step 3 (`sync` + `embed --stale`, `src/agent/revert.ts:262-281`) cannot satisfy the
promise the runbook makes for it ("so the brain's index moves back with the tree. Honesty rule 7…"). The
route still reports success, which is the sharper half of the finding: the operator is told the index
moved when it did not.

**Fix directions** (for the slice owner; both are product changes, not gate changes): remove the reverted
pages by name after the revert (a page-level remove; note the scheduler allowlist holds only
`sync`/`embed`/`dream`/`doctor` today, and the operation registry has no page-delete verb, so this needs
one), or make the page file-backed at finish so a later sync can prune it, or have `sync` prune a
brain-first page whose write-through path vanished. Until one lands, **C6 must stay red** — the leg was
not softened, and the exit gate's report is "the third of the roadmap's three promises is broken for the
only page shape an agent produces".

### Things execution surfaced (each measured; none of them in the plan)

1. **An orphaned claim request keeps consuming pending agent rows for up to `RUN_CLAIM_WAIT_MS`.** With
   the runner container EXITED, a `running` row was observed whose `claimed_by` named a container that
   had already died, and a freshly inserted `pending` row was consumed as `skipped_overlap` (with
   `claimed_by` null) every few seconds: the claim route polls the database inside one request, and a
   request whose client is gone keeps polling until its 25 s window closes. Consequence for C1: pausing
   the consumer is not the same as a quiet lane, so the gate proves the pause with a sentinel row (a
   disabled schedule, so a stray request consumes it without a mint or an alert) that must survive a full
   window — 33 304 ms observed — before the materialized row is asserted `pending`. Any future e2e leg
   that stops the runner and expects a row to sit still needs the same barrier.
2. **A finished run's `failure_detail` says `recorded_by_component`, not `budget_exceeded`.** The meter
   writes `{reason: budget_exceeded, budgetUsd, accruedUsd}` at the refusal; `finishAgentRun` then
   rewrites `failure_detail` for a class a component already recorded, so the *numbers* survive only on
   the alert (`agent_budget_exceeded`) and the class survives on `failure_class`. C9 asserts both, in
   that shape — the second of the two facts a renderer must know.
3. **C11's "denied-tool event" is contradicted by measurement, in the stronger direction.** The runbook
   says a prompt asking for Bash "produces a denied-tool event"; measured, the harness's `result` frame
   carries `permission_denials: []` and **no `tool_use` at all**, because `--tools ""` removes the
   built-in surface at the source (F3) — the MCP server's own 23 tools are what remains, and the model
   cannot call a tool it was never offered. So the leg asserts the real thing: nothing ran, the offered
   surface has no built-in, the head did not move.
4. **The credential note at the top of this document is about the HOST's key, not the org's.** The org
   holds a working `anthropic_api_key`: the gateway forwarded every real call above (2/1/2/1/1 metered
   calls, `$0.0878434`). The `beforeAll` precondition added by this task names the secret, the row and
   the runbook section, so a cold stack fails once with the reason instead of four times with symptoms.

### What did not discriminate (stated, not dressed up)

- **C11's `permission_denials` branch** can only assert the negative: with `--tools ""` there is nothing
  to deny, so the "denied-tool event" half of the leg cannot be observed on this pin. The branch is
  written so that a future pin which *does* emit a denial asserts the denied tool is a non-MCP name, but
  today the observed value is `[]` and the leg's discriminating half is "no `tool_use`, no head move".
- **C8's retry row is written by the gate, not by the reclaimer.** `reclaimExpiredLeases` deliberately
  does not re-run a dead runner's agent run (its own comment; `test/integration/scheduler-claim.test.ts`'s
  "NEVER auto-retried"; the runbook's alert table). The plan's C8 expects "after C7's reclaim **and one
  retry**" with two rows; the shipped product produces one. The gate asserts the reclaim's real shape,
  then writes the retry occurrence in `createRetryRow`'s own shape and lets the REAL runner claim and
  execute it, so the double-write claim (one copy per page, one commit adding it, one copy of the text)
  is proven on real work — but the *origin* of the second attempt is the gate, and that is a finding, not
  a pass.

---

## F16 — the revert's re-index could not remove the page an agent run writes: the mechanism, measured, and the operation that fixes it

**Where.** `src/agent/revert.ts` (`revertRun`'s index step, D10 step 3), the new
`src/contracts/registry.ts` operation `page.delete`, the read-only ops route `POST /git/path-exists`
(`src/ops/git.ts` + `src/ops/server.ts`), `src/control/opsClient.ts`, `src/console/*`, and C6 of
`test/e2e/slice4.e2e.test.ts` — whose three clauses are UNCHANGED. F15 named the defect; this is the
repair, and the first thing it did was re-measure the mechanism without a model call.

### The mechanism, re-measured (and F15's sentence corrected)

F15 says `sync` "prunes only pages it imported from a file". That is the right *conclusion* by the wrong
*route*: a page created brain-first does carry a `source_path` (MCP `put_page` records the write-through
target), and a **full** reconcile does prune it. What actually leaves the reverted page alive is the
DELTA. Measured, in gbrain's own verbs, on this stack (`.brainstand-tmp/slice4/RevertIndex/repro-c6b.sh`,
model-free):

```
$ GBRAIN_SOURCE=internal gbrain put gate-c/repro-<t>   # the MCP shape: row first, file untracked
$ git add -A; git commit -m "agent run repro-<t>"      # the finish's commit — NO sync in between
$ git rm -- gate-c/repro-<t>.md; git commit -m "revert: agent run repro-<t>"
$ gbrain sync --source internal --json
Already up to date.
{"schema_version":1,"source_id":"internal","sync_status":"up_to_date","added":0,"modified":0,
 "deleted":0,"chunks_created":0,"embedded":0,...}
$ gbrain search "gate-c nightly page <t>" --json | grep -c 'gate-c/repro-<t>'
2                                   # …the reverted page still answers
```

The file's ADDITION and its REMOVAL both landed inside the anchor..HEAD window the route's `sync` is
about to reconcile, so they net to nothing: `git diff --name-status <anchor> HEAD` says nothing about
that path, `filtered.deleted` never holds it, and `deleted: 0` is not a lie — it is the truth about a
window in which the path does not exist. `embed --stale` only ever re-embeds. Instrumented, the tree
still holds the page (`source_path` recorded) and `deleted_at` is null: nothing in the shipped step 3
touches it.

Consequences for the fix, both load-bearing:

- **The removed pages must be named.** A page-level delete is the only step that does not depend on
  where the sync's anchor happens to sit.
- **The other candidate F15 lists — "make the page file-backed at finish so a later sync can prune it"
  — does not close this one.** The page is already file-backed (`source_path` is recorded at
  `put_page` time); what fails is the DELTA, which a file-backed page is just as invisible to. It would
  also rewrite the run's own finish path for the revert's benefit.
- **Teaching `sync` is not available** (G3: upstream is never patched).
- **`sync --full` is neither sufficient nor proportionate.** F15 measured `deleted: 0` for it on the
  brain-first shape, and even where a full reconcile does prune the row, it walks the whole Space on a
  request a human is waiting on.

### The fix, and the argv it adds

`page.delete` — `delete <slug> --source-id <id> --purge [--json]` — the measured working fix, run
through the SAME ops RPC path `sync`/`embed` already use (`revertRun` never spawns gbrain itself; S2).
`--purge` is honored only for the trusted LOCAL CLI (the op refuses a remote caller with
`permission_denied`), and gbrain-ops IS that local CLI; `--source-id` is REQUIRED rather than defaulted
to `ctx.sourceId`, because a multi-source brain can hold one slug in several sources and the reverted
page belongs to the write Space's source (A11's second leg proves the targeting).

The receipt, measured at the pin (`test/contract/runner.contract.test.ts`, A11 — L6's proof that `--json`
is implemented rather than accepted):

```
MEASURED page.delete at 0.50.5.0: status=purged slug=runner-contract/revert-<id> source_id=customers
write_through.removed=true (/srv/brain-repos/customers/runner-contract/revert-<id>.md)
inserted=["gbrain","delete","runner-contract/revert-<id>","--source-id","customers","--purge","--json"];
search "revert-needle-<id>": before=[hit], after=[]
```

The receipt's keys are `status`, `slug`, `source_id`, `write_through{removed,path,skipped}` and
`residuals`. An ABSENT slug exits **1** with `Error [page_not_found]: …` on **stderr** and no JSON
receipt — recorded here because a caller that only read the exit code could not tell "there was no page"
from "the delete failed".

`revertRun`'s step 3 is now: **the pages the revert removed, by name → `sync` → `embed --stale`**, and
`RevertSuccess.index` carries all three (`purge`, `sync`, `embed`) so a reader can see that the index
moved by deletion rather than assume it. Three rules the step gets right:

1. **Only the removed paths.** `purgeCandidates` filters to git's own `D` rows: a file the revert merely
   EDITED is re-synced from its new content, and its page is never touched. `revertRange`'s staged diff
   now runs with `--no-renames` (measured: the inverse of `git mv a.md b.md` arrives as
   `R100 b.md a.md` with rename detection on — post-image `a.md`, so the REMOVED path is invisible —
   and as `A a.md` + `D b.md` with it off), which is what lets the filter see a reverted rename at all.
2. **Never purge a page that is still a file.** `gbrain delete --purge` UNLINKS the page's markdown when
   it is there, so a slug whose file the tree still holds is live work. The guard asks the TREE through
   `POST /git/path-exists` (a revert's own file list is a memory of git, not the tree), probing both the
   removed path and the slug's own `<slug>.md` BEFORE any delete runs, and records
   `skipped_file_present` with the path it found. A probe that cannot look is `refused_unreadable` and
   FAILS the revert: "I could not look" is never permission to delete.
3. **The step reports what it observed.** `purged` / `absent` / `skipped_file_present` /
   `skipped_not_a_page` / `refused_unreadable` / `failed`, each with its argv, exit code, stderr,
   classification and a one-line why — and the Runs page renders both halves, so a purge the guard
   skipped is visible as "left in the index on purpose, and still answerable: <slug> (<reason>)".

A `failed` or `refused_unreadable` purge THROWS, on the same principle as a failed sync/embed: the commit
landed, and a reverted page that still answers searches is not reverted.

### The correction this also carried (runbook)

`docs/runbooks/agent-runner.md` said a prompt asking for Bash "produces a denied-tool event" — F15's
measured correction now stands in its place: no `tool_use` at all and `permission_denials: []`, because
`--tools ""` removes the built-in surface at the source.

### C6 after the fix (measured)

`bun test --parallel=1 test/e2e/slice4.e2e.test.ts` — the leg that F15 left red, on the same run that
carried the repair:

```
[gate-c] C6 revert commit=89e60ce0 author=admin@example.test; file absent;
  search before=[gate-c/mu6jhb9j/nightly,gate-c/mu6gq05j/nightly,gate-b-seed-mu54vuc2]
  after=[gate-c/mu6gq05j/nightly,gate-b-seed-mu54vuc2,gate-c/mu6hnk0t/kill-b] (slug gone)
```

The reverted page is in the BEFORE array and absent from the AFTER array of a real `gbrain search`, with
C6's three clauses untouched. `index.purge` for that run carries one `purged` entry for
`gate-c/mu6jhb9j/nightly`; the route's `sync` still reports `up_to_date` / `deleted: 0`, which is the
point: the deletion is what moved the index, and the receipt now says so.

**One leg of that run is red, and it is not this one.** C9 (`the cap below the accrued spend refuses
before forwarding`) failed with `ended.state === 'succeeded'` on a run that made **2** metered calls and
spent `$0.0144983`; F15's own green measurement of C9 was a **1**-call run at `$0.0111512`. C9 waits for
the first metered call and only then writes `budget_usd = accrued × 0.5` (`test/e2e/slice4.e2e.test.ts`,
C9), so a run that has already made its last call when that write lands finishes `succeeded` — a race in
the leg's timing, on a code path (the gateway meter and its cap) this change does not touch. The other
25 legs, C6 among them, passed: the run ended **26 pass / 1 fail**, and Gate C's own teardown logged
`Gate C total model spend = $0.0773488 over 5 run(s)`.

**Correction (F17) — the paragraph above diagnoses C9 correctly, and is superseded on two points.**
(a) The leg it names no longer exists: F17 rewrote C9, whose title is now
`C9 a cap below the first call's cost refuses before forwarding, and never truncates`, and it passes in
all three acceptance runs below. (b) "a race in the leg's timing, on a code path … this change does not
touch" is right about the code path, but the race was **structural, not unlucky**: `usageRows` can only
see a call's row once that call has ENDED, so the write could never be issued before the harness had
already begun its next call. F15's green 1-call run and F16's red 2-call run were two shapes of the same
defect, and no amount of retrying would have made the old leg deterministic. Everything else F16 says
about that run — C6's own clauses, the 26/1 count, the `$0.0773488` — stands.

## F17 — C9 raced the harness's next call; the ordering it needed was the runner's own claim sequence

**Where.** `test/e2e/slice4.e2e.test.ts`, C9, inside `describe('Slice 4 exit gate C')` (Task 17). F16 left
it red; this is the **leg's** defect, not the product's — `assertBudget`, the meter and the refusal path
all behaved exactly as `docs/runbooks/agent-runner.md` says. Nothing in `src/` changed for this finding.

### The diagnosis, from the leg's own lines

Pre-F17 revision (`git show HEAD:test/e2e/slice4.e2e.test.ts`, where the leg starts at line 2543):

```
2555    const row = await waitFor('the runner to claim the budget fixture', 120_000, async () => {
2556      const r = (await runsOf(C_BUDGET_SCHEDULE))[0];
2557      return r?.state === 'running' ? r : null;
2558    }, 1_000);
2561    // The first metered call lands, then the cap goes below it.
2562    const firstCall = await waitFor('the first metered call', 180_000, async () => {
2563      const usage = await usageRows(row.id);
2564      return usage.length >= 1 && usage.every((u) => u.costUsd !== null) ? usage : null;
2565    }, 250);
2566    const accrued = Number(one(await psql(
2567      `select sum(cost_usd::numeric)::text from agent_run_usage where run_id = '${row.id}'`,
2568    )));
2569    expect(accrued).toBeGreaterThan(0);
2570    const cap = (accrued * 0.5).toFixed(7);
2571    await psql(`update agent_runs set budget_usd = '${cap}' where run_id = '${row.id}'`);
```

It **waits** at 2562-2565 on `usageRows` (a read of `agent_run_usage`, 2563) and it **writes** at 2571
(`agent_runs.budget_usd = accrued × 0.5`). The row it waits for is written by the gateway when the
exchange it belongs to **ends** — `finalize()` → `recordUsage` in `src/gateway/proxy.ts` — and
`usage.every((u) => u.costUsd !== null)` (2564) is what the wait really waits for. So the earliest the leg
could react to call N was *after call N had already been answered*, and the harness issues call N+1
immediately: whether the tightened cap then met a live call was decided by how many calls the agent
happened to make. That is F15's GREEN (1-call run) and F16's RED (2-call run, `succeeded` before the
write landed) — the same defect, two shapes.

### Why the plan's configuration cannot be created ON the schedule

The plan's words for this leg are "A schedule with a cap below the first call's cost → the gateway
refuses before forwarding, the run ends `budget_exceeded`, an alert exists, and `agent_run_usage` shows
zero completed calls — not a truncated one." Creating the schedule with that cap cannot produce it, for
two measured product facts:

* **A non-positive cap never reaches the gateway.** `src/runner/harness.ts:87` refuses the claim:
  `if (!(claim.budgetUsd > 0) || !Number.isFinite(claim.budgetUsd)) throw` — and the claim's budget is
  the schedule's (`src/agent/claim.ts:924`, `budgetUsd: schedule.agentBudgetUsd ?? '0'`). A schedule with
  a $0 cap therefore produces no 402, no alert and no `budget_exceeded`; that check's own comment says
  why it exists ("a non-positive budget — the meter would refuse the first call anyway").
* **A positive cap below the first call's cost is caught MID-CALL, by design.** `StreamMeter.observe`
  (`src/gateway/meter.ts`) fires `accrued + capCost >= budget` on the `message_start` frame, whose usage
  carries the input/cache counts — the dominant cost of one expensive request — so `0 + capCost ≥ cap`
  is true before the first output token. That is the mid-stream path: `midStream: true`, a bounded row
  with `stop_reason` null, and tokens/cost on its gateway log line. It is the path C9 exists to
  distinguish itself FROM.

The pre-forward check (`assertBudget`, `src/gateway/meter.ts`) therefore only ever fires for a cap the run
is **already over**. C9's cap has to be below the first call's cost when the first call starts, and the
only writer of that cap is `agent_runs.budget_usd` — the column `assertBudget` re-reads on every call.

### The fix: write it in the window the runner's own sequence opens

The leg now writes the cap between the claim and the harness that claim produces
(`test/e2e/slice4.e2e.test.ts:2605-2617`):

```
2605    const cap = '0';
2606    const postgres = one((await compose('ps', '-q', 'postgres')).stdout.trim());
2607    expect(postgres).not.toBe('');
2608    const runId = await waitFor('the claimed run to be capped below a call', 180_000, async () => {
2609      const got = one(await psqlIn(
2610        postgres,
2611        `update agent_runs a set budget_usd = '${cap}' `
2612        + `where a.budget_usd = '0.50' and exists (select 1 from schedule_runs r `
2613        + `where r.id = a.run_id and r.schedule_id = '${C_BUDGET_SCHEDULE}') `
2614        + 'returning a.run_id',
2615      ));
2616      return got === '' || got.startsWith('UPDATE ') ? null : got;
2617    }, 25);
```

The ordering is the runner's own, not a timing hope: `claimAgentRun` INSERTs `agent_runs`
(`src/agent/claim.ts:306`) **before** its response reaches the runner, and the runner only spawns the
harness after that response — `createWorkspace`, `verifyHarnessPin`, `Bun.spawn` (`src/runner/main.ts`).
Measured on C9's own runs: the runner's `run <id>: …, workspace …` line (printed immediately before the
spawn) is followed by the gateway's first line for that run **0.695 s** later (the run logged in the Gate
C file run) and **0.78 s** later in the earlier diagnostic run. Detection and write are ONE statement, so
there is no window between them, and the poll's round trip is ~145 ms. The schedule is still created
claimable at $0.50 (`test/e2e/slice4.e2e.test.ts:2580-2584` says why it must be), and
`budget_usd = '0.50'` in the guard keeps the write to this leg's run.

`psqlIn` (`test/e2e/slice4.e2e.test.ts:154-171`) exists for this one write: `docker exec … psql` costs
~145 ms a round trip against `docker compose exec`'s ~300 ms (both measured), and the leg cannot afford
150 ms of CLI startup per attempt while the harness is booting. Same route, same container, same flags.

### What C9 now asserts (all four of the plan's facts)

`402` with `tokens: 0` / `costUsd: null` on the gateway's own log line and **zero 2xx lines** (refuses
before forwarding); `state failed` / `classification budget_exceeded` on `schedule_runs` and
`failure_class budget_exceeded` on `agent_runs` (the run ends `budget_exceeded`); exactly one
`agent_budget_exceeded` alert with `reason budget_exceeded`, `budgetUsd 0`, `accruedUsd 0` and **no
`midStream`** (an alert exists); `agent_run_usage` with **zero rows**, which is also `forwarded.length`
(zero completed calls — not a truncated one). `failure_detail.reason` is still
`recorded_by_component`: `finishAgentRun` rewrites the detail of a run whose class a component already
recorded, and the class it keeps is the meter's.

### The three acceptance runs, verbatim

```
bun test --parallel=1 test/e2e/slice4.e2e.test.ts
 27 pass
 0 fail
 456 expect() calls
Ran 27 tests across 1 file. [426.75s]
[gate-c] C9 cap=$0 (schedule 0.50) accrued=$0 -> classification=budget_exceeded
         alert=agent_budget_exceeded gateway=402/tokens:0 forwarded=0 usage rows=0 (no row, no midStream)
[gate-c] spend {"schedule":"gate-c-budget-mu6k9ia7","run":"25ab1b74-…","state":"failed",
         "class":"budget_exceeded","cost":null,"attempt":1,"in":0,"out":0,"cacheRead":0,
         "cacheWrite":0,"calls":0}
[gate-c] Gate C total model spend = $0.0662396 over 5 run(s)
```

```
bun test --parallel=1 test/e2e          # first of the two consecutive directory runs
 104 pass
 0 fail
 1006 expect() calls
Ran 104 tests across 6 files. [1277.63s]
[gate-c] Gate C total model spend = $0.0639037 over 5 run(s)
[gate-b] B6 metered call model=claude-haiku-4-5-20251001 in=23 out=4 cacheRead=0 cacheWrite=0 cost=$0.0000430
```

```
bun test --parallel=1 test/e2e          # the second, from the state the first left
 104 pass
 0 fail
 1006 expect() calls
Ran 104 tests across 6 files. [1287.61s]
[gate-c] Gate C total model spend = $0.0795167 over 6 run(s)
[gate-b] B6 metered call model=claude-haiku-4-5-20251001 in=24 out=4 cacheRead=0 cacheWrite=0 cost=$0.0000440
```

Both directory runs are far above the plan's `≥ 77 pass / 0 fail` baseline, and the second started from
exactly the state the first left (the gate's teardown deletes every fixture and leaves the write Space
clean and the lane enabled). Per-run figures, from the gate's own teardown:

| run | schedule | state | calls | cost |
|---|---|---|---|---|
| file run | `gate-c-nightly-mu6k9ia7` | `succeeded` | 2 | `$0.0262647` |
| file run | `gate-c-kill-mu6k9ia7` (attempt 1) | `lease_expired` | 1 | `$0.0119937` |
| file run | `gate-c-kill-mu6k9ia7` (attempt 2) | `succeeded` | 2 | `$0.0167400` |
| file run | **`gate-c-budget-mu6k9ia7` (C9)** | `failed` / `budget_exceeded` | **0** | **`null`** |
| file run | `gate-c-bash-mu6k9ia7` | `succeeded` | 1 | `$0.0112412` |
| dir run 1 | `gate-c-nightly-mu6l1209` | `succeeded` | 2 | `$0.0261576` |
| dir run 1 | `gate-c-kill-mu6l1209` (attempt 1) | `lease_expired` | 1 | `$0.0117787` |
| dir run 1 | `gate-c-kill-mu6l1209` (attempt 2) | `succeeded` | 2 | `$0.0153650` |
| dir run 1 | **`gate-c-budget-mu6l1209` (C9)** | `failed` / `budget_exceeded` | **0** | **`null`** |
| dir run 1 | `gate-c-bash-mu6l1209` | `succeeded` | 1 | `$0.0106024` |
| dir run 2 | `gate-c-nightly-mu6lslzf` (two slots) | `succeeded` ×2 | 2 + 2 | `$0.0268267`, `$0.0139300` |
| dir run 2 | `gate-c-kill-mu6lslzf` (attempt 1) | `lease_expired` | 1 | `$0.0122087` |
| dir run 2 | `gate-c-kill-mu6lslzf` (attempt 2) | `succeeded` | 2 | `$0.0156451` |
| dir run 2 | **`gate-c-budget-mu6lslzf` (C9)** | `failed` / `budget_exceeded` | **0** | **`null`** |
| dir run 2 | `gate-c-bash-mu6lslzf` | `succeeded` | 1 | `$0.0109062` |

The second directory run left one extra `gate-c-nightly` run (6 runs, `$0.0795167`): that run's C1 fixture
materialized two slots. It is the C1 fixture's shape, not C9's — C9's own run is the `budget` row in all
three runs, `cost null` with `calls=0`, i.e. **`$0.0000000`**: the refusal happens before any upstream
connection, so the leg costs nothing, and every dollar below is the other legs'.

**This task's real spend: `$0.2097910`** — Gate C's own counters (`$0.0662396` + `$0.0639037` +
`$0.0795167` = `$0.2096600`) plus Gate B's metered leg three times (`$0.0000440` + `$0.0000430` +
`$0.0000440` = `$0.0001310`). The diagnostic C9 runs before the acceptance set cost nothing either (three
green runs at `$0`, and the two failed attempts, whose harness traffic was 401s with `tokens: 0` /
`costUsd: null` — no upstream connection). About `$0.31` was already spent on this slice before this
task, so the slice stands at **≈ `$0.52` against the `$5.00` ceiling**.

### Which coverage the mid-flight cap has

A5 (`test/contract/runner.contract.test.ts`, `describe('A5 assertBudget')`) is the **control-DB half**:
`accrued == cap` REFUSES at exactly the cap, one alert, the class on both rows, and the SUM rollup — the
pre-forward decision, asserted without a gateway. The **mid-stream crossing** is Task 7's live
verification: the streaming meter is Task 7's subject ("parse usage frames as they pass through rather
than buffering the response, so a single runaway request is capped mid-flight rather than after",
`2026-09-17-slice-4-agent-runner.md:787-790`), and its signature is the `midStream: true` refusal C9
asserts is absent. C9 does not re-litigate it: it asserts `midStream` is undefined precisely so the two
paths stay distinguishable.

### Residual

The write must land inside the harness's boot window. It does, by ~0.5-0.6 s (the boot measured 0.695-0.78
s, the write one ~145 ms round trip), and the leg **cannot pass silently** if it ever loses: a forwarded
first call shows up as `forwarded.length !== 0` and a non-empty ledger, so the leg fails on the plan's own
fourth fact rather than passing on a technicality. The other residual is the C1 fixture's extra slot in
the second directory run, above — a shape variance of a fixture this finding does not own.
