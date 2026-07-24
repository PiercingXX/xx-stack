# Model Qualification Matrix

> **2026-07-05 topology note:** production lanes moved to `skippy-debian-5090`
> (8x RTX 5090) running sglang (port 30000) and ollama (port 11434) over Tailscale.
> The Debian dual-4080 / Arch dual-5090 llama.cpp hosts below are historical; the
> matrix methodology still applies and should be re-run against the new lanes.
> Current qualified default: `qwen3-coder-next` on sglang (262k context,
> tool-call probe PASS on 2026-07-05).

Purpose
- Qualify models for production lanes and reject models that offload to CPU/RAM for declared production profiles.

## Test dimensions

### A) Context sizes
- 8k
- 16k
- 32k
- 64k (only where host/model fit suggests feasible)

### B) Parallel slice counts
- 1
- 2
- 4

### C) Prompt profiles
- coding-long (multi-file code reasoning)
- planner-long (architecture decomposition)
- tool-heavy (structured tool call style workload)
- synthesis-long (long context summarization)

### D) Hosts
- server-debian-ai (dual RTX 4080)
- test-bench-archlinux (dual RTX 5090)

## Mandatory runtime telemetry
- per-second nvidia-smi sample:
  - timestamp,index,utilization.gpu,utilization.memory,memory.used,memory.total
- llama-server logs:
  - model load behavior
  - offload/fallback indicators
  - OOM/context errors
- request metrics:
  - p50/p95 latency
  - tokens/sec
  - error rate

## Pass/fail policy

PASS (P0/P1 eligible) only if all are true:
- No CPU fallback/offload behavior for declared profile.
- No OOM/context abort for declared profile.
- Stable run across N=5 repeated trials.
- Meets minimum throughput and latency threshold for lane.

SOFT-PASS (P2 constrained) if:
- Passes at reduced context or reduced parallel slices.
- Fails only outside declared constrained envelope.

FAIL if any are true:
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
- CPU offload needed, unstable, or poor perf.

## Threshold template

Per lane thresholds (fill with measured values after baseline runs):

- Orchestrator lane (Debian local)
  - min_tokens_per_sec: TBD
  - max_p95_latency_ms: TBD
  - required_gpu_resident: true

- Delegated parallel lane (Arch remote)
  - min_tokens_per_sec: TBD
  - max_p95_latency_ms: TBD
  - required_gpu_resident: true

- Fast fallback lane (Debian local)
  - min_tokens_per_sec: TBD
  - max_p95_latency_ms: TBD
  - required_gpu_resident: true

## Candidate baseline queue

Debian dual 4080 baseline
- qwen3-coder:30b-a3b-tq2_0
- qwen3.5:27b-tq2_0
- gpt-oss:20b-tq2_0
- ministral-3:14b-tq2_0

Arch dual 5090 baseline
- qwen3-coder:30b-a3b-tq2_0
- qwen3.5:35b-tq2_0
- qwq:32b-tq2_0

## Result schema (required)
Each run must produce machine-readable JSON with:
- host
- model
- context
- parallel_slices
- prompt_profile
- gpu_residency_pass
- p50_latency_ms
- p95_latency_ms
- tokens_per_sec
- error_count
- lane_classification
- notes

## Promotion workflow
1. Run full matrix on host.
2. Classify model (P0/P1/P2/Rejected).
3. Update routing + recommendation files only for promoted models.
4. Re-run smoke tests with promoted defaults.

## Current qualified baseline (2026-05-26)

Arch dual 5090 (llama.cpp, 18081, precheck conflict stop enabled)
- qwen3.6-35b-a3b-ud-q4_k_m: PASS at context=32768, parallel=2, iterations=3
- qwen2.5-coder-32b-instruct-q4_k_m: PASS at context=32768, parallel=2, iterations=3

Debian dual 4080 (llama.cpp, 18081, local conflict precheck enabled)
- qwen2.5-coder-7b-instruct-q6_k: PASS at context=32768, parallel=2, iterations=3
- qwen2.5-coder-14b-instruct-q5_k_m: PASS at context=32768, parallel=2, iterations=3

Evidence artifacts
- ~/Documents/opencode-orchestration/scripts/model_stress/results/20260526-194249-test-bench-archlinux-qwen3.6-35b-a3b-ud-q4_k_m
- ~/Documents/opencode-orchestration/scripts/model_stress/results/20260526-194207-test-bench-archlinux-qwen2.5-coder-32b-instruct-q4_k_m
- ~/Documents/opencode-orchestration/scripts/model_stress/results/20260526-195433-debian-qwen2.5-coder-7b-instruct-q6_k
- ~/Documents/opencode-orchestration/scripts/model_stress/results/20260526-202540-debian-qwen2.5-coder-14b-instruct-q5_k_m

Additional evidence artifact
- ~/Documents/opencode-orchestration/scripts/model_stress/results/20260526-202540-debian-qwen2.5-coder-14b-instruct-q5_k_m

## Orchestration defaults derived from this matrix

Based on current qualification status and self-hosted-first policy:

- Primary lane (sglang on skippy-debian-5090): `qwen3-coder-next`
- Fallback lane (ollama on skippy-debian-5090): `qwen3-coder:30b` (pending qualification once the ollama lane is exposed over Tailscale)

These are encoded in `config/orchestration.json`. The llama.cpp-era defaults
(`qwen2.5-coder-14b/7b`, `qwen3.6-35b`, `qwen2.5-coder-32b`) are retired.