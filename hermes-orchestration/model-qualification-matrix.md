# Model Qualification Matrix

Purpose
- Qualify models for production lanes and reject models that offload to CPU/RAM
  for declared production profiles.

**Source of truth.** Hosts and runtimes come from the repo-root `inventory.json`
and nothing else. `hermes-orchestration/config/orchestration.json` is generated
from it by `npm run inventory:sync`; both are regenerated, so never hand-edit
lane definitions here or there. If a host name appears in this document that is
not in `inventory.json`, this document is wrong.

**Reconciled 2026-08-03.** This file had drifted badly. It named three
dual-GPU llama.cpp hosts as current lanes when none of them appears in
`inventory.json`; it pointed its evidence artifacts at a `model_stress/results`
directory that exists nowhere in or under this repo; and it required two result
fields the shipped bench provably cannot produce. All three are corrected below,
and the retired hosts are named only under "Historical record".

## Hosts (from `inventory.json`)

| Host id | Scope | Hardware | Runtimes |
|---|---|---|---|
| `local-workstation` | `localhost` (127.0.0.1) | detected at setup | ollama :11434 (enabled, primary), llama-cpp :8080 (disabled) |
| `example-gpu-box` | `tailscale` | 2x RTX 4090, 24 GB each (48 GB total VRAM) | sglang :30000 (disabled), ollama :11434 (disabled) |

## Lanes (from `config/orchestration.json`)

`hermes bench --lane <key>` takes a **lane key**, not a host name.

| Lane key | Lane name | Role | Priority | Model | Enabled |
|---|---|---|---|---|---|
| `sglang` | `example-gpu-box-sglang` | self_hosted | 100 | TBD (none declared) | no |
| `ollama` | `example-gpu-box-ollama` | self_hosted | 70 | TBD (none declared) | no |

A cloud lane (`hermes_cli`, gated behind explicit policy) is not part of the
shipped template; declare it under `cloud.hermesCli` in your `inventory.json`
and re-run `npm run inventory:sync` to generate one.

Two things follow from the generator and are easy to trip over:

- **`local-workstation` has no Hermes lane.** `generate-registries.mjs` skips
  runtimes whose machine scope is `localhost` or `loopback` — Hermes dials out
  to remote inference, and the loopback runtime is the orchestrator's own host.
  It is therefore not benchable through `hermes bench`. Qualifying it means
  benching it directly, or giving that machine a non-loopback scope in
  `inventory.json`.
- **The `cloud` lane is not a qualification target.** It is `hermes_cli`, it
  returns no completion envelope (so no `finish_reason` and no `usage`), and
  cloud is opt-in policy rather than a capacity lane. `bench` with no `--lane`
  picks the highest-priority *self-hosted* lane.

## Test dimensions

### A) Context sizes
- 8k
- 16k
- 32k
- 64k (only where host/model fit suggests feasible)

No model ships qualified with the template, so no default context window is
promised. Once you have qualified a sglang model, extend the ladder toward its
declared window only where you are prepared to hold the VRAM.

### B) Parallel slice counts
- 1
- 2
- 4

`example-gpu-box` declares `maxParallelSlices: 4`; sglang batches concurrent
requests across the GPUs, so parallel slices there are close to free relative to
sequential execution. Slice counts above 4 are worth measuring on that lane.

### C) Prompt profiles
- coding-long (multi-file code reasoning)
- planner-long (architecture decomposition)
- tool-heavy (structured tool call style workload)
- synthesis-long (long context summarization)

`bench` takes the profile as a `--profile` **label** and always sends its own
synthesis-style prompt. The label records intent; it does not change the
workload. Treat cross-profile comparisons from `bench` alone as unsupported.

## Mandatory runtime telemetry

Collected **on the host**, alongside the bench — not by the bench:

- per-second `nvidia-smi` sample:
  - `timestamp,index,utilization.gpu,utilization.memory,memory.used,memory.total`
- server logs (sglang or ollama):
  - model load behavior
  - offload/fallback indicators
  - OOM/context errors

Collected **by `hermes bench`**:

- p50/p95 latency, aggregate tokens/sec, error count
- output-validity verdicts per sample (see below)

## Output validity gate

`tokens_per_sec` is the qualification input for the throughput thresholds below,
so the bench refuses to publish a speed number for output it cannot certify.
The rule is borrowed as an idea (no code) from `drumih/turbo-fieldfare`,
`docs/COMMUNITY_BENCHMARKS.md`, Apache-2.0: a run is publishable only if the
output is coherent and ended normally, *so a repetition loop cannot become a
published speed result*. This matters here specifically because a model stuck in
a repetition loop emits many tokens very fast and would otherwise score as the
**best** lane.

A sample is excluded when any of these holds:

| Reason | Rule |
|---|---|
| `truncated` | `finish_reason == "length"` — cut off at `--max-tokens`, not a complete measurement |
| `abnormal_finish` | `finish_reason` present and not `"stop"` (e.g. `content_filter`) |
| `too_short` | fewer than 12 word tokens — n-gram statistics are not meaningful, so non-degeneracy cannot be certified either way |
| `degenerate_output` | fewer than 8 distinct word tokens, **or** repeated-trigram ratio above 0.5 |

A **missing** `finish_reason` is not a failure — several OpenAI-compatible
servers omit it. Those samples still count, and the report carries
`finish_reason_unreported_samples` so a reader knows how many were unverified.

Excluded samples are listed individually in `excluded_samples` and counted in
`exclusions_by_reason`. Nothing is silently dropped or capped.

`warmup_iterations` (default 1) run before timing starts and are excluded from
`total_wall_seconds`, latencies and token totals, but their wall time is
recorded in `warmup_seconds`. Cold model load on the sglang lane is seconds; the
thresholds below describe production steady state with the model already
resident, so the qualification number must be the warm one — while the cold cost
stays visible rather than discarded.

## Pass/fail policy

PASS (P0/P1 eligible) only if all are true:
- The bench run reports `publishable: true` (no excluded samples, no errors, and
  provider-reported token counts present).
- No CPU fallback/offload behavior for declared profile, per host telemetry.
- No OOM/context abort for declared profile.
- Stable across N=5 repeated trials.
- Meets minimum throughput and latency threshold for lane.

SOFT-PASS (P2 constrained) if:
- Passes at reduced context or reduced parallel slices.
- Fails only outside declared constrained envelope.

FAIL if any are true:
- Any run reports `publishable: false` for output-validity reasons — a
  repetition loop or systematic truncation is a model defect, not a slow lane.
- Requires CPU offload to complete declared profile.
- Repeated instability/error under declared profile.
- Latency/throughput below lane minimum after warmup.

## Lane assignment rules

P0 production-default
- Fully GPU-resident under target profile.
- Meets strict p95 latency and throughput thresholds.

P1 production-optional
- GPU-resident and stable, slightly weaker perf.

P2 constrained
- Stable only with reduced context and/or slice count.

Rejected
- CPU offload needed, unstable, degenerate output, or poor perf.

## Thresholds — UNSET, and why

The three lane blocks below carry nine threshold values, of which **six are
`TBD`**. That is a real, open gap and it is stated here rather than left as a
bare placeholder: **no model can currently be qualified P0 or P1 by throughput
or latency, because there is no number to compare against.** Everything above
this line is enforceable today; this section is not.

They are unset because no defensible value can be invented from this repo. A
throughput floor is a property of one model on one runtime on one host at one
context size and slice count — one model on sglang across the previous
production rig's 8x RTX 5090 has no shared scale with `qwen3-coder:30b` on ollama, and the historical
llama.cpp numbers at the bottom of this file were measured on hardware that is
no longer in `inventory.json`. Copying a number across any of those boundaries
would be fabrication.

**The measurement that sets them.** For each lane, at each declared
(context, parallel) point, on the model being qualified:

```bash
python3 scripts/hermes_orchestrator.py bench \
  --lane sglang --parallel 2 --iterations 5 --warmup 1 \
  --context-tokens 32000 --max-tokens 256 --profile synthesis-long
```

1. Discard any run with `publishable: false` and fix the cause before reading
   any number off it.
2. Take the median `tokens_per_sec` and the max `p95_latency_ms` across five
   publishable runs at the lane's declared production operating point.
3. Set `min_tokens_per_sec` to **0.7x the median** and `max_p95_latency_ms` to
   **1.4x the observed p95**. The margin exists so that ordinary run-to-run
   variance does not de-qualify a healthy lane; it is a policy choice, and it is
   written here so that it is not re-invented differently next time.
4. Record the run directory the values came from, next to the value.

Until step 4 has been done for a lane, leave it `TBD`. A guessed floor that
everything passes is worse than an absent one, because it looks enforced.

**Read `min_tokens_per_sec` as aggregate lane throughput, not per-stream.**
`bench` divides total completion tokens across all parallel slices by total wall
time, so the figure rises with `--parallel` on a batching runtime like sglang.
A threshold is only meaningful paired with the slice count it was measured at.

### Threshold template

- Lane `sglang` (`example-gpu-box-sglang`, primary self-hosted)
  - min_tokens_per_sec: TBD — see above
  - max_p95_latency_ms: TBD — see above
  - required_gpu_resident: true
- Lane `ollama` (`example-gpu-box-ollama`, compatibility/fallback)
  - min_tokens_per_sec: TBD — see above
  - max_p95_latency_ms: TBD — see above
  - required_gpu_resident: true
- Host `local-workstation` (ollama :11434 — no Hermes lane; bench directly)
  - min_tokens_per_sec: TBD — see above
  - max_p95_latency_ms: TBD — see above
  - required_gpu_resident: true

## Candidate baseline queue

`example-gpu-box`, sglang lane — blocked
- Nothing queued. The runtime ships `enabled: false` with no models declared;
  point the machine at hardware you own, declare a model, enable the lane, and
  queue a candidate here.

`example-gpu-box`, ollama lane — blocked
- `qwen3-coder:30b` is the shape of a candidate, but the runtime is
  `enabled: false`: Ollama binds to 127.0.0.1 by default and is not reachable
  over Tailscale until `OLLAMA_HOST` is set on the box and it is restarted.
  Nothing on this lane can be qualified until that is done.

`local-workstation`, ollama lane
- No models are declared in `inventory.json`. Populate that list first.

## Result schema

Each run produces one machine-readable JSON file at
`hermes-orchestration/logs/bench/<timestamp>-<lane_key>-<model>.json`
(override the directory with `--output`).

### Required — produced by `hermes bench`

| Field | Notes |
|---|---|
| `host` | lane name, e.g. `example-gpu-box-sglang` |
| `lane_key` | lane key, e.g. `sglang` |
| `model` | model benched |
| `context` | `--context-tokens` |
| `parallel_slices` | `--parallel` |
| `iterations` | timed iterations (excludes warmup) |
| `prompt_profile` | `--profile` label |
| `p50_latency_ms` | publishable samples only |
| `p95_latency_ms` | publishable samples only |
| `tokens_per_sec` | **provider-reported** completion tokens / warm wall seconds; `null` when the provider reported none |
| `tokens_per_sec_estimated` | same rate computed from `len(reply)//4` estimates; `null` when nothing was estimated |
| `completion_tokens_measured` | provider-reported only |
| `completion_tokens_estimated` | estimated only |
| `tokens_estimated` | true if any publishable sample lacked a usage block |
| `error_count` | failed requests |
| `samples_total`, `samples_publishable`, `samples_excluded` | |
| `exclusions_by_reason` | `{reason: count}` |
| `excluded_samples` | every excluded sample, with iteration, slice, verdict and detail |
| `finish_reason_unreported_samples` | provider omitted `finish_reason` |
| `validity_gate` | the thresholds actually applied to this run |
| `publishable`, `publish_blockers` | run-level verdict |
| `warmup_iterations`, `warmup_seconds`, `warmup_errors` | excluded from timing |
| `total_wall_seconds` | timed iterations only |
| `notes`, `timestamp` | |

**Estimates and measurements never share a field.** `tokens_per_sec` is
provider-reported usage only. When the provider sends no `usage` block the
estimate lands in `tokens_per_sec_estimated`, `tokens_per_sec` is `null`, and
`publish_blockers` carries `no_provider_reported_token_counts`. A qualification
decision must read `tokens_per_sec`; a `null` there means *not measured*, which
is not the same as *slow*.

### Operator-supplied — NOT required of the bench

These two were previously listed as required. The shipped bench emitted them
unconditionally as `None` and `""`, so no run could ever produce a compliant
record for 2 of 12 required fields. They are moved here rather than faked:

| Field | Emitted by bench | Why the bench cannot produce it |
|---|---|---|
| `gpu_residency_pass` | `null`, with `gpu_residency_method: "not_measured_by_bench"` | The bench is an HTTP client. GPU residency is an on-host `nvidia-smi` fact, and the production lane (`example-gpu-box`) is remote over Tailscale, so a local probe would be measuring the wrong machine. Collect it on the rig per "Mandatory runtime telemetry" and attach it to the run directory. |
| `lane_classification` | `null`, with `lane_classification_reason` | P0/P1/P2 is derived by comparing the run against the lane thresholds — which are `TBD`. The bench cannot classify against a threshold that does not exist. Once a lane's thresholds are set per the procedure above, classification becomes derivable and can move back into the required set. |

Both are `null` rather than `""`, so a consumer can distinguish "not measured"
from "measured as empty".

## Promotion workflow

1. Run the full matrix on the lane.
2. Confirm every run reports `publishable: true`.
3. Attach host GPU telemetry to the run directory and record
   `gpu_residency_pass`.
4. Classify (P0/P1/P2/Rejected) against the lane thresholds — blocked until
   those are set.
5. Update routing + recommendation files only for promoted models. Lane
   definitions come from `inventory.json` via `npm run inventory:sync`.
6. Re-run smoke tests with promoted defaults.

## Current qualified baseline

None. The shipped template enables no remote lanes and declares no models, so
nothing is qualified. The previous production baseline — `qwen3-coder-next` on
sglang (262k context, tool-call probe PASS 2026-07-05; capability only, no
throughput or latency qualification because thresholds were unset) — was
measured on a retired rig and is kept under Historical record below.

Lane definitions come from `inventory.json` via `npm run inventory:sync` and
are encoded in `config/orchestration.json`.

## Historical record (superseded, not current)

Kept as a record of method. **None of these hosts is in `inventory.json`**, and
the evidence artifacts were written under
`~/Documents/opencode-orchestration/scripts/model_stress/results/`, a path
outside this repository that is not reproducible from it. Do not treat any
number below as a baseline for the current lanes; the hardware, the runtime
(llama.cpp on :18081) and the bench itself have all changed, and none of these
runs passed an output-validity gate because there was none.

2026-05-26, llama.cpp on port 18081:

- `test-bench-archlinux` (dual RTX 5090) — `qwen3.6-35b-a3b-ud-q4_k_m` and
  `qwen2.5-coder-32b-instruct-q4_k_m`: PASS at context=32768, parallel=2,
  iterations=3.
- `server-debian-ai` (dual RTX 4080) — `qwen2.5-coder-7b-instruct-q6_k` and
  `qwen2.5-coder-14b-instruct-q5_k_m`: PASS at context=32768, parallel=2,
  iterations=3.

2026-07-05: production moved to the then-current tailscale GPU box (8x RTX 5090)
running sglang :30000 and ollama :11434 over Tailscale. That box is retired from
this tree; its host id survives nowhere in the shipped configuration. The
llama.cpp-era defaults
(`qwen2.5-coder-14b/7b`, `qwen3.6-35b`, `qwen2.5-coder-32b`) are retired.
