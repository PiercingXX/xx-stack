"""Primary-task and subagent lane selection."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any, Dict, List, Tuple

from .inventory import (
    build_inventory_report,
    cache_has_required_tool_probe_data,
    candidate_healthy_from_cache,
    load_json,
    maybe_refresh_capability_cache,
    save_json,
)
from .lanes import (
    Lane,
    OrchestratorError,
    check_lane_health,
    cloud_lane_keys,
    is_cloud_lane,
    lane_from_config,
    ordered_lane_keys,
    primary_lane_order,
    self_hosted_lane_keys,
)


def resolve_named_preset(cfg: Dict[str, Any], preset_name: str) -> Dict[str, Any]:
    presets = cfg.get("execution", {}).get("routing_presets", {})
    if not isinstance(presets, dict):
        return {}
    if not preset_name:
        return {}

    preset = presets.get(preset_name)
    if not isinstance(preset, dict):
        raise OrchestratorError(f"Unknown routing preset: {preset_name}")
    return preset


def resolve_subagent_request(cfg: Dict[str, Any], args: argparse.Namespace) -> Dict[str, str]:
    default_preset = str(cfg.get("execution", {}).get("default_subagent_preset", "general"))
    preset_name = args.preset or default_preset
    preset = resolve_named_preset(cfg, preset_name)

    task_profile = args.task_profile or str(preset.get("task_profile", "default"))
    required_model = args.required_model or str(preset.get("required_model", ""))
    reason_code = args.reason_code or str(preset.get("reason_code", "SUBAGENT_MANUAL"))

    return {
        "preset": preset_name,
        "task_profile": task_profile,
        "required_model": required_model,
        "reason_code": reason_code,
    }


def cloud_allowed_for_subagents(cfg: Dict[str, Any], allow_cloud: bool, task_profile: str) -> bool:
    if not allow_cloud:
        return False
    enabled_cloud = [
        key
        for key in cloud_lane_keys(cfg)
        if bool(cfg["lanes"][key].get("enabled", False))
    ]
    if not enabled_cloud:
        return False
    # Both keys are cloud opt-ins and both fail closed: a dropped key must never
    # widen cloud eligibility (HERMES-2).
    if not bool(cfg["execution"].get("allow_cloud_subagent_delegation", False)):
        return False
    allowed_profiles = cfg["execution"].get("cloud_subagent_profiles", [])
    if not isinstance(allowed_profiles, list):
        return False
    return task_profile in allowed_profiles


def subagent_candidate_order(cfg: Dict[str, Any], allow_cloud_for_profile: bool, task_profile: str) -> List[str]:
    configured_orders = cfg["execution"].get("subagent_profile_orders", {})

    if isinstance(configured_orders, dict) and isinstance(configured_orders.get(task_profile), list):
        order = [str(item) for item in configured_orders[task_profile]]
    elif isinstance(configured_orders, dict) and isinstance(configured_orders.get("default"), list):
        order = [str(item) for item in configured_orders["default"]]
    else:
        order = ordered_lane_keys(cfg)

    if not allow_cloud_for_profile:
        order = [key for key in order if not is_cloud_lane(cfg, key)]

    return [key for key in order if key in cfg.get("lanes", {})]


def model_matches_requirement(required_model: str, model_names: List[str], configured_model: str) -> bool:
    if not required_model:
        return True

    needle = required_model.strip().lower()
    if not needle:
        return True

    haystack = list(model_names)
    if configured_model:
        haystack.append(configured_model)

    return any(needle in model_name.lower() for model_name in haystack if isinstance(model_name, str))


def choose_primary_lane(cfg: Dict[str, Any], allow_cloud: bool, reason_code: str) -> Tuple[str, Lane]:
    for lane_key in primary_lane_order(cfg):
        lane = lane_from_config(cfg, lane_key)
        if is_cloud_lane(cfg, lane_key):
            if lane.enabled and allow_cloud:
                return lane_key, lane
            continue
        ok, _ = check_lane_health(cfg, lane)
        if ok:
            return lane_key, lane

    raise OrchestratorError(
        "No healthy lane is available. Self-hosted lanes are unhealthy; cloud is blocked by policy. "
        f"reason_code={reason_code}"
    )


def resolve_subagent_lane(
    cfg: Dict[str, Any],
    allow_cloud: bool,
    task_profile: str,
    required_model: str,
) -> Tuple[str, Lane]:
    lane_map = {key: lane_from_config(cfg, key) for key in ordered_lane_keys(cfg)}
    # Strict mode is profile-independent. It used to also require
    # task_profile == "default", which no shipped preset uses, so the whole strict
    # branch was dead in production while the docs promised it was on (HERMES-8).
    strict_tools = bool(cfg["execution"].get("require_tool_call_for_subagents", False))
    cloud_for_profile = cloud_allowed_for_subagents(cfg, allow_cloud=allow_cloud, task_profile=task_profile)
    require_live_inventory = bool(required_model.strip()) or task_profile != "default"
    cache_path = Path(cfg["execution"].get("capability_cache_file", "logs/capability-cache.json"))

    cached: Dict[str, Any] = {}
    if bool(cfg["execution"].get("use_capability_cache_for_subagents", True)):
        if require_live_inventory:
            cached = build_inventory_report(
                cfg,
                include_cloud=cloud_for_profile,
                probe_tool_calls=strict_tools,
                previous=load_json(cache_path),
            )
            save_json(cache_path, cached)
        else:
            cached = maybe_refresh_capability_cache(cfg)
        if strict_tools and not cache_has_required_tool_probe_data(cached, self_hosted_lane_keys(cfg)):
            cached = maybe_refresh_capability_cache(cfg, force=True)
    elif strict_tools or require_live_inventory:
        cached = build_inventory_report(
            cfg,
            include_cloud=cloud_for_profile,
            probe_tool_calls=strict_tools,
            previous=load_json(cache_path),
        )

    if strict_tools:
        lanes_meta = cached.get("lanes", {}) if isinstance(cached, dict) else {}
        strict_candidates: List[Tuple[int, str]] = []
        for lane_key in subagent_candidate_order(cfg, allow_cloud_for_profile=cloud_for_profile, task_profile=task_profile):
            meta = lanes_meta.get(lane_key) if isinstance(lanes_meta, dict) else None
            if not isinstance(meta, dict):
                continue
            if not bool(meta.get("healthy", False)):
                continue
            if not is_cloud_lane(cfg, lane_key) and meta.get("tool_call_supported") is not True:
                continue
            if not model_matches_requirement(
                required_model,
                list(meta.get("models", [])) if isinstance(meta.get("models"), list) else [],
                str(meta.get("configured_model", "")),
            ):
                continue
            score = int(meta.get("subagent_score", 0))
            strict_candidates.append((score, lane_key))

        for _, lane_key in sorted(strict_candidates, reverse=True):
            candidate = lane_map[lane_key]
            meta = lanes_meta.get(lane_key) if isinstance(lanes_meta, dict) else None
            if candidate.enabled and candidate_healthy_from_cache(meta):
                return lane_key, candidate
            ok, _ = check_lane_health(cfg, candidate)
            if ok:
                return lane_key, candidate

        raise OrchestratorError(
            "Strict subagent tool-call mode is enabled but no healthy lane passed tool-call probe. "
            "Run 'inventory --probe-tool-calls' and verify model tool support."
        )

    if bool(cfg["execution"].get("use_capability_cache_for_subagents", True)):
        recommendation = cached.get("recommended_subagent") if isinstance(cached, dict) else None
        if isinstance(recommendation, dict):
            recommended_lane = recommendation.get("lane")
            if isinstance(recommended_lane, str) and recommended_lane in lane_map:
                if is_cloud_lane(cfg, recommended_lane) and not cloud_for_profile:
                    pass
                else:
                    lanes_meta = cached.get("lanes", {}) if isinstance(cached, dict) else {}
                    recommended_meta = lanes_meta.get(recommended_lane) if isinstance(lanes_meta, dict) else None
                    if isinstance(recommended_meta, dict) and not model_matches_requirement(
                        required_model,
                        list(recommended_meta.get("models", [])) if isinstance(recommended_meta.get("models"), list) else [],
                        str(recommended_meta.get("configured_model", "")),
                    ):
                        pass
                    else:
                        recommended = lane_map[recommended_lane]
                        if recommended.enabled and candidate_healthy_from_cache(recommended_meta):
                            return recommended_lane, recommended
                        recommended_ok, _ = check_lane_health(cfg, recommended)
                        if recommended_ok:
                            return recommended_lane, recommended

    lanes_meta = cached.get("lanes", {}) if isinstance(cached, dict) else {}
    for lane_key in subagent_candidate_order(cfg, allow_cloud_for_profile=cloud_for_profile, task_profile=task_profile):
        meta = lanes_meta.get(lane_key) if isinstance(lanes_meta, dict) else None
        if isinstance(meta, dict) and not model_matches_requirement(
            required_model,
            list(meta.get("models", [])) if isinstance(meta.get("models"), list) else [],
            str(meta.get("configured_model", "")),
        ):
            continue
        lane = lane_map[lane_key]
        if lane.enabled and candidate_healthy_from_cache(meta):
            return lane_key, lane
        ok, _ = check_lane_health(cfg, lane)
        if ok:
            return lane_key, lane

    raise OrchestratorError("No healthy lane for subagent execution")

