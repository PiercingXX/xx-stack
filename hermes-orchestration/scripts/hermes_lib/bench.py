"""Lane latency/throughput benchmarking and output-validity gate."""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .inventory import save_json
from .lanes import (
    OrchestratorError,
    call_chat,
    check_lane_health,
    lane_from_config,
    request_timeout,
    self_hosted_lane_keys,
)


def percentile(sorted_values: List[float], fraction: float) -> float:
    if not sorted_values:
        return 0.0
    index = min(len(sorted_values) - 1, max(0, int(round(fraction * (len(sorted_values) - 1)))))
    return sorted_values[index]


BENCH_FILLER = (
    "The orchestration control plane routes inference requests across self-hosted lanes "
    "before considering any cloud escalation. Each lane exposes an OpenAI-compatible API "
    "and is scored on health, available models, configured priority, and tool-call support. "
)


# ---------------------------------------------------------------------------
# Bench output-validity gate
#
# Rule borrowed (idea only, no code) from drumih/turbo-fieldfare,
# docs/COMMUNITY_BENCHMARKS.md, Apache-2.0: a benchmark run is only publishable
# if the output is coherent and ended normally, "so a repetition loop cannot
# become a published speed result".
#
# Why this exists: tokens_per_sec is the qualification input in
# model-qualification-matrix.md. Without a gate, a model stuck in a repetition
# loop emits many tokens very fast and scores as the BEST lane, and a reply
# truncated at --max-tokens scores identically to a complete one.
# ---------------------------------------------------------------------------

# Below this many word tokens the n-gram statistics below are not meaningful, so
# non-degeneracy cannot be certified in either direction. The bench prompt asks
# for a one-paragraph summary; a reply under 12 words did not produce one.
BENCH_MIN_REPLY_TOKENS = 12

# A >=12-token reply built from fewer than 8 distinct words is not a paragraph.
# Real English prose has a type-token ratio near 1.0 at this length, so this
# floor only bites on short loops, where the trigram statistic is still weak.
BENCH_MIN_DISTINCT_TOKENS = 8

# Repeated-trigram ceiling (seq-rep-3). In the neural text degeneration
# literature the repeated-n-gram rate for human prose sits near zero (low single
# digit percent) while greedy-decoded repetition loops run ~0.7-1.0. Rejecting
# above 0.5 therefore leaves an order-of-magnitude margin against false
# positives while still catching any true loop, which drives the ratio toward
# 1.0. A model that legitimately repeats one boilerplate sentence inside a
# 200-token answer lands near 0.1 and passes.
BENCH_MAX_REPEATED_TRIGRAM_RATIO = 0.5

BENCH_TOKEN_RE = re.compile(r"[0-9a-z]+(?:'[0-9a-z]+)?")


def bench_word_tokens(text: str) -> List[str]:
    """Deterministic, offline word tokenizer for the degeneracy check."""
    return BENCH_TOKEN_RE.findall(text.lower())


def repeated_ngram_ratio(tokens: List[str], n: int = 3) -> float:
    """Fraction of n-gram positions occupied by an n-gram seen earlier.

    0.0 means every n-gram is unique (normal prose); values approaching 1.0 mean
    the text is a loop. Returns 0.0 when there are too few tokens to form an
    n-gram, so callers must apply their own length floor first.
    """
    if len(tokens) < n + 1:
        return 0.0
    grams = [tuple(tokens[i : i + n]) for i in range(len(tokens) - n + 1)]
    return 1.0 - (len(set(grams)) / len(grams))


def evaluate_bench_sample(reply: str, finish_reason: Optional[str]) -> Dict[str, Any]:
    """Decide whether one bench reply may contribute to a published speed number.

    Returns a verdict dict that is embedded verbatim in the bench report, so an
    excluded sample is always visible with its reason rather than dropped.
    """
    tokens = bench_word_tokens(reply or "")
    distinct = len(set(tokens))
    repeated = repeated_ngram_ratio(tokens, 3)
    verdict: Dict[str, Any] = {
        "finish_reason": finish_reason,
        "finish_reason_reported": finish_reason is not None,
        "reply_word_tokens": len(tokens),
        "distinct_word_tokens": distinct,
        "repeated_trigram_ratio": round(repeated, 4),
        "publishable": False,
        "exclusion_reason": "",
        "exclusion_detail": "",
    }

    # 1. End-of-turn check. "length" means the reply was cut at --max-tokens, so
    #    it is a truncated measurement, not a complete one.
    if finish_reason == "length":
        verdict["exclusion_reason"] = "truncated"
        verdict["exclusion_detail"] = "finish_reason=length: reply hit --max-tokens"
        return verdict
    if finish_reason is not None and finish_reason != "stop":
        verdict["exclusion_reason"] = "abnormal_finish"
        verdict["exclusion_detail"] = f"finish_reason={finish_reason}"
        return verdict

    # 2. Degeneracy checks (deterministic and offline; no model judges this).
    if len(tokens) < BENCH_MIN_REPLY_TOKENS:
        verdict["exclusion_reason"] = "too_short"
        verdict["exclusion_detail"] = (
            f"{len(tokens)} word tokens < {BENCH_MIN_REPLY_TOKENS}; non-degeneracy not certifiable"
        )
        return verdict
    if distinct < BENCH_MIN_DISTINCT_TOKENS:
        verdict["exclusion_reason"] = "degenerate_output"
        verdict["exclusion_detail"] = (
            f"{distinct} distinct word tokens < {BENCH_MIN_DISTINCT_TOKENS}"
        )
        return verdict
    if repeated > BENCH_MAX_REPEATED_TRIGRAM_RATIO:
        verdict["exclusion_reason"] = "degenerate_output"
        verdict["exclusion_detail"] = (
            f"repeated-trigram ratio {repeated:.3f} > {BENCH_MAX_REPEATED_TRIGRAM_RATIO}"
        )
        return verdict

    # finish_reason absent is not a failure, but it is not a clean stop either.
    # The sample counts, and the report says how many samples were unverified.
    verdict["publishable"] = True
    return verdict


def command_bench(args: argparse.Namespace, cfg: Dict[str, Any]) -> int:
    lane_key = args.lane or (self_hosted_lane_keys(cfg)[0] if self_hosted_lane_keys(cfg) else "")
    if not lane_key or lane_key not in cfg.get("lanes", {}):
        raise OrchestratorError(f"Unknown bench lane: {lane_key!r}")
    lane = lane_from_config(cfg, lane_key)
    ok, reason = check_lane_health(cfg, lane)
    if not ok:
        raise OrchestratorError(f"Bench lane {lane.name} is unhealthy: {reason}")

    # ~4 chars per token is a rough but adequate sizing heuristic for filler text.
    target_chars = max(0, args.context_tokens * 4 - 200)
    filler = (BENCH_FILLER * (target_chars // len(BENCH_FILLER) + 1))[:target_chars]
    prompt = (
        "Read the following operational notes and reply with a one-paragraph summary.\n\n"
        + filler
    )

    def one_request(_: int) -> Dict[str, Any]:
        try:
            reply, _, meta = call_chat(
                lane,
                request_timeout(cfg),
                "You are a benchmark responder. Be concise.",
                prompt,
                temperature=0.1,
                max_tokens=args.max_tokens,
            )
        except OrchestratorError as exc:
            return {"error": str(exc)}
        usage = meta.get("usage") or {}
        reported = usage.get("completion_tokens")
        sample = evaluate_bench_sample(reply, meta.get("finish_reason"))
        # Estimates and measurements never share a field. A consumer reading
        # completion_tokens_measured is reading provider-reported usage only.
        if isinstance(reported, int) and not isinstance(reported, bool):
            sample["completion_tokens"] = reported
            sample["completion_tokens_estimated"] = None
            sample["tokens_estimated"] = False
        else:
            sample["completion_tokens"] = None
            sample["completion_tokens_estimated"] = max(1, len(reply) // 4)
            sample["tokens_estimated"] = True
        sample["latency_ms"] = float(meta.get("latency_ms") or 0)
        return sample

    def run_iteration() -> Tuple[List[Dict[str, Any]], float]:
        start = time.monotonic()
        with ThreadPoolExecutor(max_workers=args.parallel) as pool:
            results = list(pool.map(one_request, range(args.parallel)))
        return results, time.monotonic() - start

    # Warmup: recorded separately rather than discarded. The first request pays
    # cold model load (seconds on the sglang lane); folding that into
    # total_wall_seconds understates steady-state throughput, and the matrix
    # thresholds describe production steady state with the model already
    # resident. Keeping the cold number visible makes load cost a lane property
    # you can read, instead of a silently dropped iteration.
    warmup_seconds = 0.0
    warmup_errors = 0
    warmup_iterations = max(0, int(getattr(args, "warmup", 1)))
    for _ in range(warmup_iterations):
        warm_results, elapsed = run_iteration()
        warmup_seconds += elapsed
        warmup_errors += sum(1 for s in warm_results if s.get("error"))
    if warmup_iterations:
        print(
            f"warmup {warmup_iterations} iteration(s) in {warmup_seconds:.2f}s "
            f"(excluded from timing; {warmup_errors} error(s))",
            file=sys.stderr,
        )

    latencies_ms: List[float] = []
    measured_tokens = 0
    estimated_tokens = 0
    errors = 0
    total_wall_seconds = 0.0
    samples_total = 0
    excluded_samples: List[Dict[str, Any]] = []
    exclusions_by_reason: Dict[str, int] = {}
    finish_reason_unreported = 0
    any_estimated = False

    for iteration in range(1, args.iterations + 1):
        results, elapsed = run_iteration()
        total_wall_seconds += elapsed
        for index, sample in enumerate(results):
            if sample.get("error"):
                errors += 1
                continue
            samples_total += 1
            if not sample["finish_reason_reported"]:
                finish_reason_unreported += 1
            if not sample["publishable"]:
                reason = sample["exclusion_reason"]
                exclusions_by_reason[reason] = exclusions_by_reason.get(reason, 0) + 1
                excluded_samples.append({"iteration": iteration, "slice": index, **sample})
                print(
                    f"  EXCLUDED iteration {iteration} slice {index}: "
                    f"{reason} ({sample['exclusion_detail']})",
                    file=sys.stderr,
                )
                continue
            latencies_ms.append(sample["latency_ms"])
            if sample["tokens_estimated"]:
                any_estimated = True
                estimated_tokens += sample["completion_tokens_estimated"]
            else:
                measured_tokens += sample["completion_tokens"]
        print(f"iteration {iteration}/{args.iterations} done", file=sys.stderr)

    samples_publishable = samples_total - len(excluded_samples)

    def rate(tokens: int) -> Optional[float]:
        if tokens <= 0 or total_wall_seconds <= 0:
            return None
        return round(tokens / total_wall_seconds, 2)

    # A run only qualifies a model if every sample ended normally, was coherent,
    # and nothing errored. Exclusions are reported either way; they just cannot
    # become a published speed result.
    blockers: List[str] = []
    if samples_publishable <= 0:
        blockers.append("no_publishable_samples")
    if excluded_samples:
        blockers.append("excluded_samples_present")
    if errors:
        blockers.append("request_errors")
    if measured_tokens <= 0:
        blockers.append("no_provider_reported_token_counts")

    latencies_ms.sort()
    result = {
        "host": lane.name,
        "lane_key": lane_key,
        "model": lane.model,
        "context": args.context_tokens,
        "parallel_slices": args.parallel,
        "iterations": args.iterations,
        "prompt_profile": args.profile,
        "p50_latency_ms": percentile(latencies_ms, 0.50),
        "p95_latency_ms": percentile(latencies_ms, 0.95),
        # Measured and estimated throughput are separate fields on purpose.
        # tokens_per_sec is provider-reported usage only; it is null when the
        # provider reported none, so a consumer can never mistake an estimate
        # for a measurement.
        "tokens_per_sec": rate(measured_tokens),
        "tokens_per_sec_estimated": rate(estimated_tokens),
        "completion_tokens_measured": measured_tokens,
        "completion_tokens_estimated": estimated_tokens,
        "tokens_estimated": any_estimated,
        "error_count": errors,
        "samples_total": samples_total,
        "samples_publishable": samples_publishable,
        "samples_excluded": len(excluded_samples),
        "exclusions_by_reason": exclusions_by_reason,
        "excluded_samples": excluded_samples,
        "finish_reason_unreported_samples": finish_reason_unreported,
        "validity_gate": {
            "min_reply_tokens": BENCH_MIN_REPLY_TOKENS,
            "min_distinct_tokens": BENCH_MIN_DISTINCT_TOKENS,
            "max_repeated_trigram_ratio": BENCH_MAX_REPEATED_TRIGRAM_RATIO,
        },
        "publishable": not blockers,
        "publish_blockers": blockers,
        "warmup_iterations": warmup_iterations,
        "warmup_seconds": round(warmup_seconds, 3),
        "warmup_errors": warmup_errors,
        "total_wall_seconds": round(total_wall_seconds, 3),
        # Operator-supplied fields; see model-qualification-matrix.md for why the
        # bench provably cannot produce these two.
        "gpu_residency_pass": None,
        "gpu_residency_method": "not_measured_by_bench",
        "lane_classification": None,
        "lane_classification_reason": "lane thresholds are unset; see model-qualification-matrix.md",
        "notes": "gpu_residency requires on-host nvidia-smi telemetry; run alongside this bench",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    if not result["publishable"]:
        print(
            f"NOT PUBLISHABLE: {', '.join(blockers)} "
            f"({len(excluded_samples)} of {samples_total} samples excluded, {errors} error(s))",
            file=sys.stderr,
        )

    output_dir = Path(args.output)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    output_path = output_dir / f"{stamp}-{lane_key}-{lane.model.replace('/', '_').replace(':', '_')}.json"
    save_json(output_path, result)
    print(json.dumps({**result, "output": str(output_path)}, indent=2))
    return 0
