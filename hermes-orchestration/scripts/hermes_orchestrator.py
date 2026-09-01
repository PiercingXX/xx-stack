#!/usr/bin/env python3
"""Self-hosted-first orchestration runner for OpenAI-compatible endpoints.

Routes work to self-hosted inference lanes first (sglang and ollama on the
example remote GPU box over Tailscale) and only allows cloud on explicit gate.

Lanes are named entries in config with a role ("self_hosted" or "cloud") and a
numeric priority; higher priority is tried first. Cloud lanes are always gated
behind explicit policy regardless of priority.
"""

from __future__ import annotations

import argparse
import sys
import urllib.error
import urllib.request
from pathlib import Path

from hermes_lib.bench import (
    BENCH_FILLER,
    BENCH_MAX_REPEATED_TRIGRAM_RATIO,
    BENCH_MIN_DISTINCT_TOKENS,
    BENCH_MIN_REPLY_TOKENS,
    BENCH_TOKEN_RE,
    bench_word_tokens,
    command_bench,
    evaluate_bench_sample,
    percentile,
    repeated_ngram_ratio,
)
from hermes_lib.commands import (
    auto_split_subtasks,
    command_health,
    command_inventory,
    command_presets,
    command_refresh_cache,
    command_route,
    command_run,
    command_subagents,
    split_subtasks,
)
from hermes_lib.inventory import (
    append_jsonl,
    build_inventory_report,
    cache_has_required_tool_probe_data,
    cache_is_fresh,
    candidate_healthy_from_cache,
    load_json,
    log_escalation,
    log_routing_event,
    maybe_refresh_capability_cache,
    routing_event,
    save_json,
)
from hermes_lib.lanes import (
    API_KEY_COMMAND_TIMEOUT_SECONDS,
    LANE_HEALTH_TTL_SECONDS,
    Lane,
    LaneHealthCache,
    OrchestratorError,
    call_chat,
    check_lane_health,
    cloud_default_enabled,
    cloud_lane_keys,
    health_timeout,
    http_json,
    infer_lane_role,
    is_cloud_lane,
    lane_chat_url,
    lane_from_config,
    lane_health,
    lane_model_candidates,
    lane_models_url,
    lane_priority,
    lane_role,
    list_lane_models,
    load_config,
    ordered_lane_keys,
    parse_chat_content,
    parse_finish_reason,
    primary_lane_order,
    probe_tool_call_support,
    request_timeout,
    resolve_api_key,
    run_hermes_cli_oneshot,
    select_probe_model,
    self_hosted_first_enabled,
    self_hosted_lane_keys,
)
from hermes_lib.proxy import (
    MAX_REQUEST_BODY_BYTES,
    PROXY_PASSTHROUGH_KEYS,
    REQUEST_SOCKET_TIMEOUT_SECONDS,
    ProxyHandler,
    ProxyServer,
    command_serve,
    flatten_messages_for_cli,
)
from hermes_lib.routing import (
    choose_primary_lane,
    cloud_allowed_for_subagents,
    model_matches_requirement,
    resolve_named_preset,
    resolve_subagent_lane,
    resolve_subagent_request,
    subagent_candidate_order,
)
from hermes_lib.safety import (
    DENIED_ARGUMENTS,
    UNSAFE_TOKEN_CHARS,
    command_allowed,
    command_rejection_reason,
    parse_command_argv,
    parse_executable_plan,
    run_actions,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Hermes self-hosted-first orchestration controller")
    parser.add_argument(
        "--config",
        default="config/orchestration.json",
        help="Path to orchestration JSON config",
    )

    sub = parser.add_subparsers(dest="command", required=True)

    health = sub.add_parser("health", help="Check health of all configured lanes")
    health.set_defaults(handler=command_health)

    route = sub.add_parser("route", help="Resolve which primary lane would be selected")
    route.add_argument("--allow-cloud", action="store_true", help="Allow cloud fallback for this decision")
    route.add_argument("--reason-code", default="MANUAL_CHECK", help="Reason code for cloud gate context")
    route.set_defaults(handler=command_route)

    run = sub.add_parser("run", help="Run one task on selected primary lane")
    run.add_argument("--task", required=True, help="Task prompt")
    run.add_argument("--temperature", type=float, default=0.1)
    run.add_argument("--allow-cloud", action="store_true", help="Allow cloud fallback for this run")
    run.add_argument("--reason-code", default="MANUAL_RUN", help="Reason code if cloud is selected")
    run.add_argument("--task-id", default="")
    run.add_argument("--decomposition-attempted", action="store_true")
    run.add_argument("--local-capacity-snapshot", default="")
    run.add_argument("--remote-capacity-snapshot", default="")
    run.add_argument("--escalation-approved-by", default="operator")
    run.add_argument("--escalation-log", default="logs/cloud-escalations.jsonl")
    run.add_argument("--require-executable-plan", action="store_true")
    run.add_argument("--execute-approved", action="store_true")
    run.set_defaults(handler=command_run)

    subagents = sub.add_parser("subagents", help="Run subagent slices on capability-aware delegated lane")
    subagents.add_argument("--task", required=True, help="Task text. Use '||' to provide explicit slices.")
    subagents.add_argument(
        "--parts",
        type=int,
        default=2,
        help="Max subtasks when --auto-split decomposes a task without explicit '||' slices",
    )
    subagents.add_argument(
        "--auto-split",
        action="store_true",
        help="Ask the selected lane model to decompose the task into parallel slices",
    )
    subagents.add_argument("--temperature", type=float, default=0.1)
    subagents.add_argument("--allow-cloud", action="store_true", help="Allow cloud delegation for eligible profiles")
    subagents.add_argument("--preset", default="", help="Named routing preset from config execution.routing_presets")
    subagents.add_argument(
        "--task-profile",
        choices=["default", "hardware-constrained", "specialized-model"],
        default=None,
        help="Override routing profile used to decide when cloud delegation is eligible",
    )
    subagents.add_argument(
        "--required-model",
        default="",
        help="Override case-insensitive substring that must match a lane model before that lane is considered suitable",
    )
    subagents.add_argument("--task-id", default="")
    subagents.add_argument("--reason-code", default="", help="Override reason code for cloud escalation logging")
    subagents.add_argument("--local-capacity-snapshot", default="")
    subagents.add_argument("--remote-capacity-snapshot", default="")
    subagents.add_argument("--escalation-approved-by", default="operator")
    subagents.add_argument("--escalation-log", default="logs/cloud-escalations.jsonl")
    subagents.set_defaults(handler=command_subagents)

    presets = sub.add_parser("presets", help="List named routing presets")
    presets.set_defaults(handler=command_presets)

    inventory = sub.add_parser(
        "inventory",
        help="Discover lane models, probe tool-call support, and compute subagent recommendation",
    )
    inventory.add_argument("--include-cloud", action="store_true", help="Include cloud lanes in inventory")
    inventory.add_argument("--probe-tool-calls", action="store_true", help="Probe function/tool-call behavior")
    inventory.add_argument("--force-probe", action="store_true", help="Ignore previous probe results (no reuse)")
    inventory.add_argument("--output", default="logs/capability-cache.json", help="Output JSON cache/report path")
    inventory.set_defaults(handler=command_inventory)

    refresh = sub.add_parser("refresh-cache", help="Force-refresh capability cache for automation")
    refresh.add_argument("--include-cloud", action="store_true", help="Include cloud lanes in refresh report")
    refresh.add_argument("--probe-tool-calls", action="store_true", help="Probe function/tool-call behavior")
    refresh.add_argument("--force-probe", action="store_true", help="Ignore previous probe results (no reuse)")
    refresh.add_argument("--output", default="", help="Output path (defaults to config execution.capability_cache_file)")
    refresh.set_defaults(handler=command_refresh_cache)

    bench = sub.add_parser("bench", help="Benchmark a lane: latency percentiles and throughput")
    bench.add_argument("--lane", default="", help="Lane key to benchmark (default: highest-priority self-hosted)")
    bench.add_argument("--parallel", type=int, default=2, help="Concurrent requests per iteration")
    bench.add_argument("--iterations", type=int, default=3, help="Number of timed iterations")
    bench.add_argument(
        "--warmup",
        type=int,
        default=1,
        help="Warmup iterations run before timing starts (excluded from timing; 0 disables)",
    )
    bench.add_argument("--context-tokens", type=int, default=4000, help="Approximate prompt size in tokens")
    bench.add_argument("--max-tokens", type=int, default=256, help="Max completion tokens per request")
    bench.add_argument("--profile", default="synthesis-long", help="Prompt profile label for the report")
    bench.add_argument("--output", default="logs/bench", help="Output directory for bench reports")
    bench.set_defaults(handler=command_bench)

    serve = sub.add_parser("serve", help="Run loopback OpenAI-compatible proxy fronting the routing policy")
    serve.add_argument("--host", default="", help="Bind host (default from config proxy.bind_host, 127.0.0.1)")
    serve.add_argument("--port", type=int, default=0, help="Bind port (default from config proxy.port, 8180)")
    serve.add_argument("--token", default="", help="Bearer token (default from env named by proxy.auth_token_env)")
    serve.add_argument("--allow-cloud", action="store_true", help="Allow proxied requests to reach cloud lanes")
    serve.add_argument("--no-auth", action="store_true", help="Explicitly run without auth (not recommended)")
    serve.set_defaults(handler=command_serve)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    config_path = Path(args.config)
    cfg = load_config(config_path)

    try:
        return int(args.handler(args, cfg))
    except OrchestratorError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
