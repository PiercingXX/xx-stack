"""Capability cache, inventory reports, and routing/escalation logging."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from .lanes import (
    cloud_lane_keys,
    health_timeout,
    lane_from_config,
    lane_model_candidates,
    list_lane_models,
    probe_tool_call_support,
    request_timeout,
    select_probe_model,
    self_hosted_lane_keys,
    check_lane_health,
)


def candidate_healthy_from_cache(meta: Optional[Dict[str, Any]]) -> bool:
    return isinstance(meta, dict) and bool(meta.get("healthy", False))


def cache_has_required_tool_probe_data(cache: Dict[str, Any], lane_keys: List[str]) -> bool:
    lanes_meta = cache.get("lanes", {}) if isinstance(cache, dict) else {}
    if not isinstance(lanes_meta, dict):
        return False

    for lane_key in lane_keys:
        meta = lanes_meta.get(lane_key)
        if not isinstance(meta, dict):
            continue
        if not bool(meta.get("healthy", False)):
            continue
        if meta.get("tool_call_supported") is None:
            return False
    return True


def append_jsonl(path: Path, event: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, sort_keys=True) + "\n")


def log_escalation(cfg: Dict[str, Any], event: Dict[str, Any], log_path: Path) -> None:
    append_jsonl(log_path, event)


def log_routing_event(cfg: Dict[str, Any], event: Dict[str, Any]) -> None:
    path = Path(cfg.get("execution", {}).get("routing_log_file", "logs/routing.jsonl"))
    record = {"timestamp": datetime.now(timezone.utc).isoformat(), **event}
    try:
        append_jsonl(path, record)
    except OSError as exc:
        print(f"WARN: failed to write routing log {path}: {exc}", file=sys.stderr)


def routing_event(
    source: str,
    lane: Optional[Lane],
    model: str,
    ok: bool,
    latency_ms: Optional[int] = None,
    usage: Optional[Dict[str, Any]] = None,
    error: str = "",
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    usage = usage if isinstance(usage, dict) else {}
    # lane is None for total-failure events, where no lane was ever selected.
    event: Dict[str, Any] = {
        "source": source,
        "lane_key": lane.key if lane else "",
        "lane": lane.name if lane else "",
        "model": model,
        "ok": ok,
        "latency_ms": latency_ms,
        "prompt_tokens": usage.get("prompt_tokens"),
        "completion_tokens": usage.get("completion_tokens"),
    }
    if error:
        event["error"] = error[:500]
    if extra:
        event.update(extra)
    return event



def save_json(path: Path, obj: Dict[str, Any]) -> None:
    """Write JSON atomically so a concurrent reader never sees torn content.

    The capability cache is read on the proxy/subagent path while refreshes
    rewrite it. Writing a temp file in the same directory and renaming keeps
    every reader on either the previous file or the complete new one.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(obj, indent=2, sort_keys=True) + "\n"
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as tmp:
            tmp.write(payload)
        os.replace(tmp_name, path)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise


def load_json(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def cache_is_fresh(path: Path, max_age_seconds: int) -> bool:
    if not path.exists():
        return False
    if max_age_seconds <= 0:
        return True
    age_seconds = time.time() - path.stat().st_mtime
    return age_seconds <= max_age_seconds


def build_inventory_report(
    cfg: Dict[str, Any],
    include_cloud: bool,
    probe_tool_calls: bool,
    previous: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    lane_keys = list(self_hosted_lane_keys(cfg))
    if include_cloud:
        lane_keys.extend(cloud_lane_keys(cfg))

    reuse_probe = bool(cfg["execution"].get("reuse_tool_probe_for_same_model", True))
    previous_lanes = previous.get("lanes", {}) if isinstance(previous, dict) else {}
    if not isinstance(previous_lanes, dict):
        previous_lanes = {}

    inventory: Dict[str, Any] = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "lanes": {},
        "recommended_subagent": None,
    }

    candidates: List[Dict[str, Any]] = []

    for key in lane_keys:
        lane = lane_from_config(cfg, key)
        healthy, health_reason = check_lane_health(cfg, lane)
        models: List[str] = []
        models_reason = "skipped_unhealthy"
        if healthy:
            models, models_reason = list_lane_models(lane, health_timeout(cfg))

        selected_model = select_probe_model(lane, models)
        tool_supported = None
        tool_reason = "not_requested"
        if probe_tool_calls and healthy and selected_model:
            previous_meta = previous_lanes.get(key)
            if (
                reuse_probe
                and isinstance(previous_meta, dict)
                and previous_meta.get("selected_probe_model") == selected_model
                and previous_meta.get("tool_call_supported") is not None
            ):
                tool_supported = bool(previous_meta.get("tool_call_supported"))
                tool_reason = "reused_previous_probe"
            else:
                ok, reason = probe_tool_call_support(lane, request_timeout(cfg), selected_model)
                tool_supported = ok
                tool_reason = reason

        score = 0
        if healthy:
            score += 50
        score += min(len(models), 10)
        score += lane.priority
        if tool_supported is True:
            score += 40
        elif probe_tool_calls and tool_supported is False:
            score -= 30

        lane_record = {
            "lane": lane.name,
            "key": key,
            "role": lane.role,
            "priority": lane.priority,
            "healthy": healthy,
            "health_reason": health_reason,
            "base_url": lane.base_url,
            "configured_model": lane.model,
            "model_candidates": lane_model_candidates(lane),
            "models": models,
            "models_reason": models_reason,
            "selected_probe_model": selected_model,
            "tool_call_supported": tool_supported,
            "tool_probe_reason": tool_reason,
            "subagent_score": score,
        }
        inventory["lanes"][key] = lane_record

        if healthy:
            require_tools = bool(cfg["execution"].get("require_tool_call_for_subagents", False)) and bool(probe_tool_calls)
            if not require_tools or lane.role == "cloud" or tool_supported is True:
                candidates.append(lane_record)

    if candidates:
        best = sorted(candidates, key=lambda item: item["subagent_score"], reverse=True)[0]
        inventory["recommended_subagent"] = {
            "lane": best["key"],
            "lane_name": best["lane"],
            "model": best["selected_probe_model"],
            "tool_call_supported": best["tool_call_supported"],
            "score": best["subagent_score"],
        }

    return inventory


def maybe_refresh_capability_cache(cfg: Dict[str, Any], force: bool = False) -> Dict[str, Any]:
    cache_path = Path(cfg["execution"].get("capability_cache_file", "logs/capability-cache.json"))
    auto_refresh = bool(cfg["execution"].get("auto_refresh_capability_cache", True))
    max_age_seconds = int(cfg["execution"].get("capability_cache_max_age_seconds", 600))

    if not force and cache_path.exists() and cache_is_fresh(cache_path, max_age_seconds):
        return load_json(cache_path)

    if force or auto_refresh:
        include_cloud = any(
            bool(cfg["lanes"][key].get("enabled", False)) for key in cloud_lane_keys(cfg)
        )
        refreshed = build_inventory_report(
            cfg,
            include_cloud=include_cloud,
            probe_tool_calls=True,
            previous=load_json(cache_path),
        )
        save_json(cache_path, refreshed)
        return refreshed

    return load_json(cache_path)
