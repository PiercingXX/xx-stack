"""CLI command handlers for health, routing, run, subagents, and inventory."""

from __future__ import annotations

import argparse
import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .inventory import (
    build_inventory_report,
    load_json,
    log_escalation,
    log_routing_event,
    routing_event,
    save_json,
)
from .lanes import (
    Lane,
    OrchestratorError,
    call_chat,
    check_lane_health,
    cloud_default_enabled,
    is_cloud_lane,
    lane_from_config,
    ordered_lane_keys,
    primary_lane_order,
    request_timeout,
)
from .routing import choose_primary_lane, resolve_subagent_lane, resolve_subagent_request
from .safety import parse_executable_plan, run_actions


def split_subtasks(task: str) -> List[str]:
    """Explicit '||' separators only; implicit sentence splitting was removed
    because round-robin sentence buckets produce incoherent slices."""
    explicit = [t.strip() for t in task.split("||") if t.strip()]
    if explicit:
        return explicit
    return [task.strip()]


def auto_split_subtasks(cfg: Dict[str, Any], lane: Lane, task: str, parts: int) -> List[str]:
    system_prompt = (
        f"Split the user's task into at most {parts} independent subtasks that can run in parallel "
        "without depending on each other's output. Return a strict JSON array of strings only, "
        "no markdown. If the task cannot be split, return a JSON array with the original task."
    )
    try:
        reply, _, _ = call_chat(lane, request_timeout(cfg), system_prompt, task, temperature=0.0)
        parsed = json.loads(reply)
    except (OrchestratorError, json.JSONDecodeError):
        return [task.strip()]
    if not isinstance(parsed, list):
        return [task.strip()]
    subtasks = [item.strip() for item in parsed if isinstance(item, str) and item.strip()]
    if not subtasks:
        return [task.strip()]
    return subtasks[: max(1, parts)]


def command_health(args: argparse.Namespace, cfg: Dict[str, Any]) -> int:
    summary = {}
    for key in ordered_lane_keys(cfg):
        lane = lane_from_config(cfg, key)
        ok, reason = check_lane_health(cfg, lane)
        summary[key] = {
            "lane": lane.name,
            "role": lane.role,
            "priority": lane.priority,
            "healthy": ok,
            "reason": reason,
            "model": lane.model,
            "fallback_models": lane.fallback_models or [],
            "base_url": lane.base_url,
        }
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


def command_route(args: argparse.Namespace, cfg: Dict[str, Any]) -> int:
    lane_key, lane = choose_primary_lane(cfg, args.allow_cloud, args.reason_code)
    print(
        json.dumps(
            {
                "selected_lane": lane_key,
                "lane": lane.name,
                "model": lane.model,
                "fallback_models": lane.fallback_models or [],
            },
            indent=2,
        )
    )
    return 0


def command_run(args: argparse.Namespace, cfg: Dict[str, Any]) -> int:
    timeout = request_timeout(cfg)

    system_prompt = (
        "You are a coding execution assistant. Give direct, concrete output. "
        "Do not claim actions that were not completed."
    )
    if args.require_executable_plan:
        system_prompt = (
            "Return strict JSON only, no markdown. JSON schema: "
            "{\"final_answer\": string, \"actions\": string[]} where actions are optional shell commands. "
            "Only include commands that are safe and idempotent."
        )

    attempts: List[Dict[str, str]] = []
    selected: Optional[Tuple[str, Lane, str, str, Dict[str, Any]]] = None

    for lane_key in primary_lane_order(cfg):
        lane = lane_from_config(cfg, lane_key)
        if not lane.enabled:
            attempts.append({"lane": lane.name, "skipped": "disabled"})
            continue
        if is_cloud_lane(cfg, lane_key):
            if not args.allow_cloud:
                attempts.append({"lane": lane.name, "skipped": "cloud_not_allowed"})
                continue
        else:
            ok, reason = check_lane_health(cfg, lane)
            if not ok:
                attempts.append({"lane": lane.name, "skipped": f"unhealthy:{reason}"})
                continue
        try:
            response, selected_model, meta = call_chat(
                lane, timeout, system_prompt, args.task, temperature=args.temperature
            )
        except OrchestratorError as exc:
            attempts.append({"lane": lane.name, "error": str(exc)})
            log_routing_event(cfg, routing_event("run", lane, lane.model, ok=False, error=str(exc)))
            continue
        selected = (lane_key, lane, response, selected_model, meta)
        break

    if selected is None:
        raise OrchestratorError(f"No lane completed the task. Attempts: {attempts}")

    lane_key, lane, response, selected_model, meta = selected
    log_routing_event(
        cfg,
        routing_event(
            "run",
            lane,
            selected_model,
            ok=True,
            latency_ms=meta.get("latency_ms"),
            usage=meta.get("usage"),
            extra={"task_id": args.task_id or ""},
        ),
    )

    fallback_attempts = [a for a in attempts if "error" in a]
    if fallback_attempts:
        print(json.dumps({"fallback_attempts": fallback_attempts}, indent=2))

    if args.require_executable_plan:
        plan = parse_executable_plan(response)
        print(plan["final_answer"])
        if args.execute_approved and bool(cfg["execution"].get("allow_shell_execution", False)):
            allowed = list(cfg["execution"].get("allowed_command_prefixes", []))
            action_results = run_actions(plan.get("actions", []), allowed)
            print(json.dumps({"action_results": action_results}, indent=2))
    else:
        print(response)

    if is_cloud_lane(cfg, lane_key):
        event = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "task_id": args.task_id or f"task-{int(time.time())}",
            "reason_code": args.reason_code,
            "selected_model": selected_model,
            "decomposition_attempted": bool(args.decomposition_attempted),
            "local_capacity_snapshot": args.local_capacity_snapshot,
            "remote_capacity_snapshot": args.remote_capacity_snapshot,
            "escalation_approved_by": args.escalation_approved_by,
        }
        log_escalation(cfg, event, Path(args.escalation_log))

    return 0


def command_subagents(args: argparse.Namespace, cfg: Dict[str, Any]) -> int:
    timeout = request_timeout(cfg)
    request = resolve_subagent_request(cfg, args)
    # Fails closed: cloud is off unless policy AND execution both opt in (HERMES-2).
    allow_cloud = bool(args.allow_cloud) or cloud_default_enabled(cfg)
    max_parallel = max(1, int(cfg["execution"].get("max_parallel_subagents", 4)))
    explicit_tasks = split_subtasks(args.task)

    attempt_cfg = json.loads(json.dumps(cfg))
    outputs: List[Dict[str, Any]] = []
    chosen_lane_key = ""
    chosen_lane: Optional[Lane] = None
    chosen_models: List[str] = []
    lane_failures: List[Dict[str, str]] = []
    workers = 1
    # Real escalation telemetry (cloud-escalation-policy.md): whether the
    # delegation actually went out as multiple subtasks, not a hardcoded True.
    decomposition_attempted = False

    for _ in range(len(ordered_lane_keys(cfg))):
        lane_key, lane = resolve_subagent_lane(
            attempt_cfg,
            allow_cloud=allow_cloud,
            task_profile=request["task_profile"],
            required_model=request["required_model"],
        )

        if len(explicit_tasks) > 1:
            tasks = explicit_tasks
        elif args.auto_split and args.parts > 1:
            tasks = auto_split_subtasks(cfg, lane, args.task, args.parts)
        else:
            tasks = [args.task.strip()]
        decomposition_attempted = len(tasks) > 1

        def run_slice(item: Tuple[int, str]) -> Dict[str, Any]:
            index, subtask = item
            system_prompt = (
                "You are subagent {idx}. Execute your assigned slice only, output concrete result."
            ).format(idx=index)
            try:
                reply, used_model, meta = call_chat(lane, timeout, system_prompt, subtask, temperature=args.temperature)
            except OrchestratorError as exc:
                log_routing_event(
                    cfg,
                    routing_event(
                        "subagents", lane, lane.model, ok=False, error=str(exc),
                        extra={"subtask_index": index, "preset": request["preset"]},
                    ),
                )
                raise
            log_routing_event(
                cfg,
                routing_event(
                    "subagents", lane, used_model, ok=True,
                    latency_ms=meta.get("latency_ms"), usage=meta.get("usage"),
                    extra={"subtask_index": index, "preset": request["preset"]},
                ),
            )
            return {
                "subtask_index": index,
                "lane": lane.name,
                "model": used_model,
                "input": subtask,
                "output": reply,
            }

        try:
            workers = min(max_parallel, len(tasks))
            with ThreadPoolExecutor(max_workers=workers) as pool:
                outputs = list(pool.map(run_slice, list(enumerate(tasks, start=1))))
            chosen_models = []
            for record in outputs:
                if record["model"] not in chosen_models:
                    chosen_models.append(record["model"])
            chosen_lane_key = lane_key
            chosen_lane = lane
            break
        except OrchestratorError as exc:
            lane_failures.append({"lane": lane.name, "error": str(exc)})
            if lane_key in attempt_cfg.get("lanes", {}):
                attempt_cfg["lanes"][lane_key]["enabled"] = False
            continue

    if chosen_lane is None:
        raise OrchestratorError(f"All delegated lanes failed: {lane_failures}")

    if is_cloud_lane(cfg, chosen_lane_key):
        event = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "task_id": args.task_id or f"subagents-{int(time.time())}",
            "reason_code": request["reason_code"],
            "selected_model": chosen_models[0] if chosen_models else chosen_lane.model,
            "decomposition_attempted": decomposition_attempted,
            "local_capacity_snapshot": args.local_capacity_snapshot,
            "remote_capacity_snapshot": args.remote_capacity_snapshot,
            "escalation_approved_by": args.escalation_approved_by,
        }
        log_escalation(cfg, event, Path(args.escalation_log))

    payload: Dict[str, Any] = {
        "lane": chosen_lane.name,
        "preset": request["preset"],
        "task_profile": request["task_profile"],
        "required_model": request["required_model"],
        "selected_models": chosen_models,
        "parallel_workers": workers,
        "count": len(outputs),
        "results": outputs,
    }
    if lane_failures:
        payload["fallback_failures"] = lane_failures
    print(json.dumps(payload, indent=2))
    return 0


def command_presets(args: argparse.Namespace, cfg: Dict[str, Any]) -> int:
    presets = cfg.get("execution", {}).get("routing_presets", {})
    default_preset = cfg.get("execution", {}).get("default_subagent_preset", "general")
    print(json.dumps({"default_preset": default_preset, "routing_presets": presets}, indent=2, sort_keys=True))
    return 0


def command_inventory(args: argparse.Namespace, cfg: Dict[str, Any]) -> int:
    previous = {} if args.force_probe else load_json(Path(args.output))
    inventory = build_inventory_report(
        cfg,
        include_cloud=bool(args.include_cloud),
        probe_tool_calls=bool(args.probe_tool_calls),
        previous=previous,
    )

    cache_path = Path(args.output)
    save_json(cache_path, inventory)
    print(json.dumps(inventory, indent=2, sort_keys=True))
    return 0


def command_refresh_cache(args: argparse.Namespace, cfg: Dict[str, Any]) -> int:
    output = Path(args.output or cfg["execution"].get("capability_cache_file", "logs/capability-cache.json"))
    previous = {} if args.force_probe else load_json(output)
    refreshed = build_inventory_report(
        cfg,
        include_cloud=bool(args.include_cloud),
        probe_tool_calls=bool(args.probe_tool_calls),
        previous=previous,
    )
    save_json(output, refreshed)
    print(json.dumps({"refreshed": True, "output": str(output), "timestamp": refreshed.get("timestamp")}, indent=2))
    return 0
