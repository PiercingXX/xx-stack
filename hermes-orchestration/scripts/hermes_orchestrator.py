#!/usr/bin/env python3
"""Self-hosted-first orchestration runner for OpenAI-compatible endpoints.

Routes work to self-hosted inference lanes first (sglang and ollama on the
skippy-debian-5090 rig over Tailscale) and only allows cloud on explicit gate.

Lanes are named entries in config with a role ("self_hosted" or "cloud") and a
numeric priority; higher priority is tried first. Cloud lanes are always gated
behind explicit policy regardless of priority.
"""

from __future__ import annotations

import argparse
import hmac
import http.client
import json
import os
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


@dataclass
class Lane:
    key: str
    name: str
    base_url: str
    model: str
    enabled: bool
    role: str = "self_hosted"
    priority: int = 50
    endpoint_type: str = "openai_compatible"
    provider: Optional[str] = None
    api_key_env: Optional[str] = None
    api_key_command: Optional[str] = None
    fallback_models: Optional[List[str]] = None
    catalog_models: Optional[List[str]] = None
    chat_probe_on_models_failure: bool = False


class OrchestratorError(RuntimeError):
    pass


def load_config(path: Path) -> Dict[str, Any]:
    if not path.exists():
        raise OrchestratorError(f"Config file does not exist: {path}")
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def infer_lane_role(lane_cfg: Dict[str, Any]) -> str:
    role = lane_cfg.get("role")
    if isinstance(role, str) and role:
        return role
    return "cloud" if lane_cfg.get("endpoint_type") == "hermes_cli" else "self_hosted"


def lane_from_config(cfg: Dict[str, Any], key: str) -> Lane:
    lane_cfg = cfg["lanes"].get(key)
    if not lane_cfg:
        raise OrchestratorError(f"Missing lane '{key}' in config")
    return Lane(
        key=key,
        name=lane_cfg["name"],
        base_url=str(lane_cfg.get("base_url", "")),
        model=lane_cfg["model"],
        enabled=bool(lane_cfg.get("enabled", True)),
        role=infer_lane_role(lane_cfg),
        priority=int(lane_cfg.get("priority", 50)),
        endpoint_type=str(lane_cfg.get("endpoint_type", "openai_compatible")),
        provider=lane_cfg.get("provider"),
        api_key_env=lane_cfg.get("api_key_env"),
        api_key_command=lane_cfg.get("api_key_command"),
        fallback_models=lane_cfg.get("fallback_models"),
        catalog_models=lane_cfg.get("catalog_models"),
        chat_probe_on_models_failure=bool(lane_cfg.get("chat_probe_on_models_failure", False)),
    )


def lane_role(cfg: Dict[str, Any], key: str) -> str:
    lane_cfg = cfg.get("lanes", {}).get(key)
    if not isinstance(lane_cfg, dict):
        return "self_hosted"
    return infer_lane_role(lane_cfg)


def is_cloud_lane(cfg: Dict[str, Any], key: str) -> bool:
    return lane_role(cfg, key) == "cloud"


def lane_priority(cfg: Dict[str, Any], key: str) -> int:
    lane_cfg = cfg.get("lanes", {}).get(key)
    if not isinstance(lane_cfg, dict):
        return 0
    return int(lane_cfg.get("priority", 50))


def _priority_sorted(cfg: Dict[str, Any], keys: List[str]) -> List[str]:
    original_index = {key: index for index, key in enumerate(keys)}
    return sorted(keys, key=lambda key: (-lane_priority(cfg, key), original_index[key]))


def self_hosted_lane_keys(cfg: Dict[str, Any]) -> List[str]:
    keys = [key for key in cfg.get("lanes", {}) if not is_cloud_lane(cfg, key)]
    return _priority_sorted(cfg, keys)


def cloud_lane_keys(cfg: Dict[str, Any]) -> List[str]:
    keys = [key for key in cfg.get("lanes", {}) if is_cloud_lane(cfg, key)]
    return _priority_sorted(cfg, keys)


def ordered_lane_keys(cfg: Dict[str, Any]) -> List[str]:
    return self_hosted_lane_keys(cfg) + cloud_lane_keys(cfg)


def primary_lane_order(cfg: Dict[str, Any]) -> List[str]:
    configured = cfg.get("policy", {}).get("primary_lane_order")
    if isinstance(configured, list) and configured:
        return [str(key) for key in configured if str(key) in cfg.get("lanes", {})]
    return ordered_lane_keys(cfg)


def request_timeout(cfg: Dict[str, Any]) -> int:
    return int(cfg["execution"].get("request_timeout_seconds", 120))


def health_timeout(cfg: Dict[str, Any]) -> int:
    return int(cfg["execution"].get("health_check_timeout_seconds", 8))


def resolve_api_key(lane: Lane) -> str:
    if lane.api_key_env:
        value = os.environ.get(lane.api_key_env, "")
        if value:
            return value

    if lane.api_key_command:
        completed = subprocess.run(
            lane.api_key_command,
            shell=True,
            text=True,
            capture_output=True,
        )
        if completed.returncode == 0:
            return completed.stdout.strip()

    return ""


def lane_model_candidates(lane: Lane) -> List[str]:
    candidates: List[str] = []
    for model in [lane.model, *(lane.fallback_models or [])]:
        if isinstance(model, str) and model and model not in candidates:
            candidates.append(model)
    return candidates


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
    if not bool(cfg["execution"].get("allow_cloud_subagent_delegation", True)):
        return False
    allowed_profiles = cfg["execution"].get(
        "cloud_subagent_profiles",
        ["hardware-constrained", "specialized-model"],
    )
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


def http_json(
    method: str,
    url: str,
    payload: Optional[Dict[str, Any]],
    timeout: int,
    api_key: Optional[str] = None,
) -> Tuple[int, Dict[str, Any]]:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")

    req = urllib.request.Request(url=url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return resp.getcode(), json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = {"error": body}
        return e.code, parsed
    except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException) as e:
        return 599, {"error": str(e)}


def run_hermes_cli_oneshot(lane: Lane, timeout: int, model: str, prompt: str) -> Tuple[bool, str]:
    if not lane.provider:
        return False, "missing_provider"

    command = ["hermes", "--provider", lane.provider, "-m", model, "-z", prompt]
    try:
        completed = subprocess.run(
            command,
            text=True,
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return False, "timeout"
    except FileNotFoundError:
        return False, "hermes_cli_not_installed"
    except OSError as exc:
        return False, f"hermes_cli_error:{exc}"

    if completed.returncode != 0:
        error = completed.stderr.strip() or completed.stdout.strip() or f"exit_{completed.returncode}"
        return False, error

    output = completed.stdout.strip()
    if not output:
        return False, "empty_output"
    return True, output


def lane_models_url(lane: Lane) -> str:
    return lane.base_url.rstrip("/") + "/models"


def lane_chat_url(lane: Lane) -> str:
    return lane.base_url.rstrip("/") + "/chat/completions"


def parse_chat_content(lane_name: str, data: Dict[str, Any]) -> str:
    choices = data.get("choices") or []
    if not choices:
        raise OrchestratorError(f"{lane_name} returned no choices: {data}")

    message = choices[0].get("message", {})
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: List[str] = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                parts.append(part.get("text", ""))
        return "\n".join(parts).strip()
    return str(content)


def select_probe_model(lane: Lane, models: List[str]) -> str:
    for candidate in lane_model_candidates(lane):
        if candidate in models:
            return candidate
    return models[0] if models else lane.model


def lane_health(lane: Lane, http_probe_timeout: int, cli_timeout: int) -> Tuple[bool, str]:
    if not lane.enabled:
        return False, "disabled"
    if "REPLACE_WITH" in lane.base_url:
        return False, "unconfigured_endpoint"
    if lane.endpoint_type == "hermes_cli":
        last_error = "not_attempted"
        for candidate_model in lane_model_candidates(lane):
            ok, detail = run_hermes_cli_oneshot(
                lane,
                cli_timeout,
                candidate_model,
                "Reply with exactly: ok",
            )
            if ok:
                return True, f"hermes_cli_ok:{candidate_model}"
            last_error = detail
        return False, f"hermes_cli_failed:{last_error}"

    api_key = resolve_api_key(lane)
    status, data = http_json("GET", lane_models_url(lane), None, http_probe_timeout, api_key or None)
    error_block = data.get("error") if isinstance(data, dict) else None
    error_code = ""
    if isinstance(error_block, dict):
        error_code = str(error_block.get("code", ""))

    # 401/403 often indicate auth policy while endpoint is alive (mainly cloud lanes).
    if status in (401, 403):
        return True, f"reachable_http_{status}"
    if status == 400 and error_code == "no_model_name" and lane.catalog_models:
        return True, "catalog_api_quirk"
    if status == 400 and lane.chat_probe_on_models_failure:
        for candidate_model in lane_model_candidates(lane):
            probe_payload = {
                "model": candidate_model,
                "messages": [{"role": "user", "content": "Reply with exactly: ok"}],
                "temperature": 0,
                "max_tokens": 8,
            }
            probe_status, probe_data = http_json(
                "POST", lane_chat_url(lane), probe_payload, cli_timeout, api_key or None
            )
            probe_error = probe_data.get("error") if isinstance(probe_data, dict) else None
            probe_code = ""
            if isinstance(probe_error, dict):
                probe_code = str(probe_error.get("code", ""))
            if probe_status < 400:
                return True, f"chat_probe_ok:{candidate_model}"
            if probe_status == 400 and probe_code == "RateLimitReached":
                return True, f"chat_probe_rate_limited:{candidate_model}"
    if status >= 400:
        return False, f"http_{status}"
    if "data" not in data:
        return False, "missing_models_payload"
    return True, "ok"


def check_lane_health(cfg: Dict[str, Any], lane: Lane) -> Tuple[bool, str]:
    return lane_health(lane, health_timeout(cfg), request_timeout(cfg))


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
    lane: Lane,
    model: str,
    ok: bool,
    latency_ms: Optional[int] = None,
    usage: Optional[Dict[str, Any]] = None,
    error: str = "",
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    usage = usage if isinstance(usage, dict) else {}
    event: Dict[str, Any] = {
        "source": source,
        "lane_key": lane.key,
        "lane": lane.name,
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


def call_chat(
    lane: Lane,
    timeout: int,
    system_prompt: str,
    user_prompt: str,
    temperature: float = 0.1,
    max_tokens: Optional[int] = None,
) -> Tuple[str, str, Dict[str, Any]]:
    """Returns (content, model_used, meta) where meta has latency_ms and usage."""
    if lane.endpoint_type == "hermes_cli":
        failures: List[str] = []
        combined_prompt = f"System instructions:\n{system_prompt}\n\nUser task:\n{user_prompt}"
        for candidate_model in lane_model_candidates(lane):
            start = time.monotonic()
            ok, detail = run_hermes_cli_oneshot(lane, timeout, candidate_model, combined_prompt)
            latency_ms = int((time.monotonic() - start) * 1000)
            if ok:
                return detail, candidate_model, {"latency_ms": latency_ms, "usage": {}}
            failures.append(f"{candidate_model}:{detail}")
        raise OrchestratorError(
            f"{lane.name} chat call failed for configured models {lane_model_candidates(lane)}: {failures}"
        )

    api_key = resolve_api_key(lane)
    failures = []
    for candidate_model in lane_model_candidates(lane):
        payload: Dict[str, Any] = {
            "model": candidate_model,
            "temperature": temperature,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        }
        if max_tokens is not None:
            payload["max_tokens"] = int(max_tokens)
        start = time.monotonic()
        status, data = http_json("POST", lane_chat_url(lane), payload, timeout, api_key or None)
        latency_ms = int((time.monotonic() - start) * 1000)
        if status >= 400:
            failures.append(f"{candidate_model}:{status}:{data}")
            continue
        usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        return parse_chat_content(lane.name, data), candidate_model, {"latency_ms": latency_ms, "usage": usage}

    raise OrchestratorError(
        f"{lane.name} chat call failed for configured models {lane_model_candidates(lane)}: {failures}"
    )


def list_lane_models(lane: Lane, timeout: int) -> Tuple[List[str], str]:
    if lane.endpoint_type == "hermes_cli":
        if lane.catalog_models:
            return sorted(set(lane.catalog_models)), "configured_catalog"
        return lane_model_candidates(lane), "configured_candidates"

    api_key = resolve_api_key(lane)
    status, data = http_json("GET", lane_models_url(lane), None, timeout, api_key or None)
    if status >= 400:
        if lane.catalog_models:
            return sorted(set(lane.catalog_models)), f"catalog_fallback_http_{status}"
        return [], f"http_{status}"

    raw_models = data.get("data")
    if not isinstance(raw_models, list):
        # Some servers return {"models": [...]} only.
        raw_models = data.get("models", [])

    model_ids: List[str] = []
    for item in raw_models:
        if isinstance(item, dict):
            model_id = item.get("id") or item.get("model") or item.get("name")
            if isinstance(model_id, str) and model_id:
                model_ids.append(model_id)

    if not model_ids:
        if lane.catalog_models:
            return sorted(set(lane.catalog_models)), "catalog_fallback_no_models"
        return [], "no_models"
    return sorted(set(model_ids)), "ok"


def probe_tool_call_support(lane: Lane, timeout: int, model: str) -> Tuple[bool, str]:
    if lane.endpoint_type == "hermes_cli":
        return False, "unsupported_endpoint_type"

    api_key = resolve_api_key(lane)
    payload = {
        "model": model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": "You must call the ping tool exactly once."},
            {"role": "user", "content": "Call ping with value 'ok'."},
        ],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "ping",
                    "description": "Returns connectivity confirmation.",
                    "parameters": {
                        "type": "object",
                        "properties": {"value": {"type": "string"}},
                        "required": ["value"],
                    },
                },
            }
        ],
        "tool_choice": "auto",
    }

    status, data = http_json("POST", lane_chat_url(lane), payload, timeout, api_key or None)
    if status >= 400:
        return False, f"http_{status}"

    choices = data.get("choices") or []
    if not choices or not isinstance(choices[0], dict):
        return False, "no_choices"

    message = choices[0].get("message")
    if not isinstance(message, dict):
        return False, "no_message"

    tool_calls = message.get("tool_calls")
    if not isinstance(tool_calls, list) or not tool_calls:
        return False, "no_tool_calls"

    first = tool_calls[0]
    if not isinstance(first, dict):
        return False, "invalid_tool_call"
    fn = first.get("function")
    if not isinstance(fn, dict):
        return False, "missing_function_block"
    if fn.get("name") != "ping":
        return False, "unexpected_tool_name"
    return True, "ok"


def save_json(path: Path, obj: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, sort_keys=True)
        f.write("\n")


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
    strict_tools = bool(cfg["execution"].get("require_tool_call_for_subagents", False)) and task_profile == "default"
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


def parse_executable_plan(raw: str) -> Dict[str, Any]:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise OrchestratorError(
            "Model output is not JSON. Use a stricter system prompt or disable --require-executable-plan."
        ) from exc

    if "final_answer" not in parsed:
        raise OrchestratorError("Executable plan JSON must contain 'final_answer'")
    actions = parsed.get("actions", [])
    if not isinstance(actions, list):
        raise OrchestratorError("'actions' must be a list")
    return parsed


UNSAFE_TOKEN_CHARS = ";|&<>`$\n"


def parse_command_argv(command: str) -> Optional[List[str]]:
    """Parse a command string into argv, rejecting shell metacharacters.

    Commands run without a shell, so metacharacters can never expand — but any
    token containing one is rejected outright to fail closed on injection
    attempts like "git status; rm -rf ~".
    """
    try:
        tokens = shlex.split(command)
    except ValueError:
        return None
    if not tokens:
        return None
    for token in tokens:
        if any(ch in token for ch in UNSAFE_TOKEN_CHARS):
            return None
    return tokens


def command_allowed(command: str, allowed_prefixes: List[str]) -> bool:
    argv = parse_command_argv(command)
    if argv is None:
        return False
    for prefix in allowed_prefixes:
        try:
            prefix_argv = shlex.split(prefix)
        except ValueError:
            continue
        if prefix_argv and argv[: len(prefix_argv)] == prefix_argv:
            return True
    return False


def run_actions(actions: List[str], allowed_prefixes: List[str]) -> List[Dict[str, Any]]:
    results = []
    for command in actions:
        if not isinstance(command, str):
            results.append({"command": str(command), "status": "rejected", "reason": "not_string"})
            continue
        argv = parse_command_argv(command)
        if argv is None:
            results.append({"command": command, "status": "rejected", "reason": "unparseable_or_unsafe"})
            continue
        if not command_allowed(command, allowed_prefixes):
            results.append({"command": command, "status": "rejected", "reason": "not_allowlisted"})
            continue
        try:
            completed = subprocess.run(argv, shell=False, text=True, capture_output=True, timeout=120)
        except subprocess.TimeoutExpired:
            results.append({"command": command, "status": "error", "reason": "timeout"})
            continue
        except FileNotFoundError:
            results.append({"command": command, "status": "error", "reason": "command_not_found"})
            continue
        results.append(
            {
                "command": command,
                "status": "ok" if completed.returncode == 0 else "error",
                "exit_code": completed.returncode,
                "stdout": completed.stdout[-4000:],
                "stderr": completed.stderr[-4000:],
            }
        )
    return results


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
    default_allow_cloud = bool(cfg["execution"].get("subagents_allow_cloud_default", True))
    allow_cloud = bool(args.allow_cloud) or default_allow_cloud
    max_parallel = max(1, int(cfg["execution"].get("max_parallel_subagents", 4)))
    explicit_tasks = split_subtasks(args.task)

    attempt_cfg = json.loads(json.dumps(cfg))
    outputs: List[Dict[str, Any]] = []
    chosen_lane_key = ""
    chosen_lane: Optional[Lane] = None
    chosen_models: List[str] = []
    lane_failures: List[Dict[str, str]] = []
    workers = 1

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
            "decomposition_attempted": True,
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

    latencies_ms: List[float] = []
    completion_tokens = 0
    errors = 0
    total_wall_seconds = 0.0

    def one_request(_: int) -> Tuple[Optional[float], int]:
        try:
            reply, _, meta = call_chat(
                lane,
                request_timeout(cfg),
                "You are a benchmark responder. Be concise.",
                prompt,
                temperature=0.1,
                max_tokens=args.max_tokens,
            )
        except OrchestratorError:
            return None, 0
        usage = meta.get("usage") or {}
        tokens = usage.get("completion_tokens")
        if not isinstance(tokens, int):
            tokens = max(1, len(reply) // 4)
        return float(meta.get("latency_ms") or 0), tokens

    for iteration in range(1, args.iterations + 1):
        start = time.monotonic()
        with ThreadPoolExecutor(max_workers=args.parallel) as pool:
            results = list(pool.map(one_request, range(args.parallel)))
        total_wall_seconds += time.monotonic() - start
        for latency, tokens in results:
            if latency is None:
                errors += 1
                continue
            latencies_ms.append(latency)
            completion_tokens += tokens
        print(f"iteration {iteration}/{args.iterations} done", file=sys.stderr)

    latencies_ms.sort()
    result = {
        "host": lane.name,
        "lane_key": lane_key,
        "model": lane.model,
        "context": args.context_tokens,
        "parallel_slices": args.parallel,
        "iterations": args.iterations,
        "prompt_profile": args.profile,
        "gpu_residency_pass": None,
        "p50_latency_ms": percentile(latencies_ms, 0.50),
        "p95_latency_ms": percentile(latencies_ms, 0.95),
        "tokens_per_sec": round(completion_tokens / total_wall_seconds, 2) if total_wall_seconds > 0 else 0.0,
        "completion_tokens_total": completion_tokens,
        "error_count": errors,
        "lane_classification": "",
        "notes": "gpu_residency requires on-host nvidia-smi telemetry; run alongside this bench",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    output_dir = Path(args.output)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    output_path = output_dir / f"{stamp}-{lane_key}-{lane.model.replace('/', '_').replace(':', '_')}.json"
    save_json(output_path, result)
    print(json.dumps({**result, "output": str(output_path)}, indent=2))
    return 0


# ---------------------------------------------------------------------------
# Local loopback proxy (serve command)
# ---------------------------------------------------------------------------

PROXY_PASSTHROUGH_KEYS = (
    "messages",
    "temperature",
    "top_p",
    "max_tokens",
    "tools",
    "tool_choice",
    "stop",
    "response_format",
    "frequency_penalty",
    "presence_penalty",
    "seed",
)


class ProxyServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, handler, cfg, token, allow_cloud, log_prompts):
        super().__init__(address, handler)
        self.cfg = cfg
        self.token = token
        self.allow_cloud = allow_cloud
        self.log_prompts = log_prompts


def flatten_messages_for_cli(messages: List[Dict[str, Any]]) -> str:
    parts: List[str] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role", "user"))
        content = message.get("content")
        if isinstance(content, list):
            text = "\n".join(
                part.get("text", "")
                for part in content
                if isinstance(part, dict) and part.get("type") == "text"
            )
        else:
            text = str(content or "")
        parts.append(f"{role}: {text}")
    return "\n\n".join(parts)


class ProxyHandler(BaseHTTPRequestHandler):
    server: ProxyServer  # narrowed type for attribute access

    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *log_args: Any) -> None:  # noqa: A002
        # Suppress per-request stderr noise; routing telemetry covers requests.
        pass

    def _send_json(self, code: int, obj: Dict[str, Any]) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        if self.server.token is None:
            return True
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return False
        return hmac.compare_digest(header[len("Bearer "):].strip(), self.server.token)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self._send_json(200, {"status": "ok"})
            return
        if not self._authorized():
            self._send_json(401, {"error": {"message": "missing or invalid bearer token"}})
            return
        if self.path == "/v1/models":
            cfg = self.server.cfg
            model_ids: List[str] = ["auto"]
            for key in ordered_lane_keys(cfg):
                lane = lane_from_config(cfg, key)
                if not lane.enabled:
                    continue
                for candidate in lane_model_candidates(lane):
                    if candidate not in model_ids:
                        model_ids.append(candidate)
            data = [{"id": model_id, "object": "model", "owned_by": "hermes-orchestrator"} for model_id in model_ids]
            self._send_json(200, {"object": "list", "data": data})
            return
        self._send_json(404, {"error": {"message": f"unknown path {self.path}"}})

    def do_POST(self) -> None:  # noqa: N802
        if not self._authorized():
            self._send_json(401, {"error": {"message": "missing or invalid bearer token"}})
            return
        if self.path != "/v1/chat/completions":
            self._send_json(404, {"error": {"message": f"unknown path {self.path}"}})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        except (ValueError, json.JSONDecodeError):
            self._send_json(400, {"error": {"message": "invalid JSON body"}})
            return

        messages = payload.get("messages")
        if not isinstance(messages, list) or not messages:
            self._send_json(400, {"error": {"message": "'messages' must be a non-empty list"}})
            return

        cfg = self.server.cfg
        requested_model = str(payload.get("model") or "auto")
        stream = bool(payload.get("stream", False))

        order = [key for key in primary_lane_order(cfg)]
        if requested_model not in ("auto", "", "hermes-orchestrator"):
            matching = []
            for key in order:
                lane = lane_from_config(cfg, key)
                if model_matches_requirement(requested_model, lane_model_candidates(lane), lane.model):
                    matching.append(key)
            if matching:
                order = matching

        attempts: List[str] = []
        for lane_key in order:
            lane = lane_from_config(cfg, lane_key)
            if not lane.enabled:
                continue
            if is_cloud_lane(cfg, lane_key) and not self.server.allow_cloud:
                attempts.append(f"{lane.name}:cloud_not_allowed")
                continue
            if not is_cloud_lane(cfg, lane_key):
                ok, reason = check_lane_health(cfg, lane)
                if not ok:
                    attempts.append(f"{lane.name}:unhealthy:{reason}")
                    continue

            start = time.monotonic()
            if lane.endpoint_type == "hermes_cli":
                prompt = flatten_messages_for_cli(messages)
                success = False
                for candidate_model in lane_model_candidates(lane):
                    ok, detail = run_hermes_cli_oneshot(lane, request_timeout(cfg), candidate_model, prompt)
                    if ok:
                        data = {
                            "id": f"chatcmpl-hermes-{int(time.time() * 1000)}",
                            "object": "chat.completion",
                            "created": int(time.time()),
                            "model": candidate_model,
                            "choices": [
                                {
                                    "index": 0,
                                    "message": {"role": "assistant", "content": detail},
                                    "finish_reason": "stop",
                                }
                            ],
                            "usage": {},
                        }
                        success = True
                        break
                if not success:
                    attempts.append(f"{lane.name}:cli_failed")
                    continue
            else:
                forward = {key: payload[key] for key in PROXY_PASSTHROUGH_KEYS if key in payload}
                api_key = resolve_api_key(lane)
                data = None
                for candidate_model in lane_model_candidates(lane):
                    forward["model"] = candidate_model
                    status, upstream = http_json(
                        "POST", lane_chat_url(lane), forward, request_timeout(cfg), api_key or None
                    )
                    if status < 400:
                        data = upstream
                        break
                    attempts.append(f"{lane.name}:{candidate_model}:http_{status}")
                if data is None:
                    continue

            latency_ms = int((time.monotonic() - start) * 1000)
            usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
            model_used = str(data.get("model", lane.model))
            log_routing_event(
                cfg,
                routing_event(
                    "proxy", lane, model_used, ok=True, latency_ms=latency_ms, usage=usage,
                    extra={"requested_model": requested_model, "stream": stream},
                ),
            )
            if stream:
                self._send_stream_shim(data, model_used)
            else:
                self._send_json(200, data)
            return

        self._send_json(
            502,
            {"error": {"message": "no lane could serve the request", "attempts": attempts}},
        )

    def _send_stream_shim(self, data: Dict[str, Any], model_used: str) -> None:
        """Non-streaming upstream call delivered as minimal SSE for stream clients."""
        try:
            content = parse_chat_content("proxy", data)
        except OrchestratorError:
            content = ""
        completion_id = str(data.get("id", f"chatcmpl-hermes-{int(time.time() * 1000)}"))
        created = int(data.get("created", time.time()))

        def chunk(delta: Dict[str, Any], finish_reason: Optional[str]) -> bytes:
            body = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model_used,
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
            }
            return f"data: {json.dumps(body)}\n\n".encode("utf-8")

        frames = (
            chunk({"role": "assistant"}, None)
            + chunk({"content": content}, None)
            + chunk({}, "stop")
            + b"data: [DONE]\n\n"
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(frames)))
        self.end_headers()
        self.wfile.write(frames)


def command_serve(args: argparse.Namespace, cfg: Dict[str, Any]) -> int:
    proxy_cfg = cfg.get("proxy", {}) if isinstance(cfg.get("proxy"), dict) else {}
    host = args.host or str(proxy_cfg.get("bind_host", "127.0.0.1"))
    port = int(args.port or proxy_cfg.get("port", 8180))
    allow_cloud = bool(args.allow_cloud or proxy_cfg.get("allow_cloud", False))
    log_prompts = bool(proxy_cfg.get("log_prompts", False))

    token: Optional[str] = args.token or os.environ.get(str(proxy_cfg.get("auth_token_env", "HERMES_PROXY_TOKEN")), "")
    if not token:
        token = None
    if token is None and not args.no_auth:
        raise OrchestratorError(
            "No proxy auth token. Set the env var named by proxy.auth_token_env "
            "(default HERMES_PROXY_TOKEN), pass --token, or explicitly pass --no-auth."
        )

    if host not in ("127.0.0.1", "localhost", "::1"):
        print(
            f"WARNING: proxy binding to non-loopback host {host}. "
            "Policy requires loopback-only exposure.",
            file=sys.stderr,
        )

    server = ProxyServer((host, port), ProxyHandler, cfg, token, allow_cloud, log_prompts)
    actual_port = server.server_address[1]
    print(
        json.dumps(
            {
                "listening": f"http://{host}:{actual_port}",
                "auth": "bearer_token" if token else "DISABLED",
                "allow_cloud": allow_cloud,
                "endpoints": ["/healthz", "/v1/models", "/v1/chat/completions"],
            },
            indent=2,
        ),
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("shutting down", file=sys.stderr)
    finally:
        server.server_close()
    return 0


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
    bench.add_argument("--iterations", type=int, default=3, help="Number of iterations")
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
