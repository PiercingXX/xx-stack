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
import hmac
import http.client
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union


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
    api_key_command: Optional[Union[str, List[str]]] = None
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


def self_hosted_first_enabled(cfg: Dict[str, Any]) -> bool:
    """policy.self_hosted_first — self-hosted lanes are tried before cloud lanes.

    Defaults to True: dropping the key must not turn the local-first ordering off.
    """
    policy = cfg.get("policy", {})
    if not isinstance(policy, dict):
        return True
    return bool(policy.get("self_hosted_first", True))


def _apply_lane_policy_order(cfg: Dict[str, Any], keys: List[str]) -> List[str]:
    """Order lane keys by priority, keeping cloud last when local-first is on."""
    if not self_hosted_first_enabled(cfg):
        return _priority_sorted(cfg, keys)
    self_hosted = [key for key in keys if not is_cloud_lane(cfg, key)]
    cloud = [key for key in keys if is_cloud_lane(cfg, key)]
    return _priority_sorted(cfg, self_hosted) + _priority_sorted(cfg, cloud)


def ordered_lane_keys(cfg: Dict[str, Any]) -> List[str]:
    return _apply_lane_policy_order(cfg, list(cfg.get("lanes", {})))


def primary_lane_order(cfg: Dict[str, Any]) -> List[str]:
    """Lane order for primary tasks.

    ``policy.primary_lane_order`` is machine-generated from raw object insertion
    order, so it selects *which* lanes participate, never their order — the order
    is always re-derived from ``priority`` (and the local-first policy). Adding a
    machine in the wrong position in the generated list therefore cannot silently
    demote a higher-priority lane.
    """
    configured = cfg.get("policy", {}).get("primary_lane_order")
    if isinstance(configured, list) and configured:
        known = [str(key) for key in configured if str(key) in cfg.get("lanes", {})]
        if known:
            return _apply_lane_policy_order(cfg, known)
    return ordered_lane_keys(cfg)


def cloud_default_enabled(cfg: Dict[str, Any]) -> bool:
    """Config-level default for cloud delegation, with no explicit --allow-cloud.

    Fails **closed**: every one of the three keys must be present and explicitly
    permissive. If any is missing (config/orchestration.json is partly
    machine-generated, so keys can be dropped on regeneration) cloud stays off.
    """
    policy = cfg.get("policy", {})
    policy = policy if isinstance(policy, dict) else {}
    execution = cfg.get("execution", {})
    execution = execution if isinstance(execution, dict) else {}

    if bool(policy.get("require_manual_cloud_escalation", True)):
        return False
    if not bool(policy.get("cloud_enabled_by_default", False)):
        return False
    return bool(execution.get("subagents_allow_cloud_default", False))


def request_timeout(cfg: Dict[str, Any]) -> int:
    return int(cfg["execution"].get("request_timeout_seconds", 120))


def health_timeout(cfg: Dict[str, Any]) -> int:
    return int(cfg["execution"].get("health_check_timeout_seconds", 8))


# A credential helper that hangs must not park the calling thread: resolve_api_key
# is on the proxy hot path (one call per upstream request).
API_KEY_COMMAND_TIMEOUT_SECONDS = 10


def resolve_api_key(lane: Lane, timeout: int = API_KEY_COMMAND_TIMEOUT_SECONDS) -> str:
    if lane.api_key_env:
        value = os.environ.get(lane.api_key_env, "")
        if value:
            return value

    if lane.api_key_command:
        # The string form is the documented operator-owned pattern and stays
        # shell-interpreted. The argv-list form runs without a shell, so no
        # config content can ever be expanded by one.
        shell = not isinstance(lane.api_key_command, list)
        command: Any = lane.api_key_command
        if not shell:
            command = [str(part) for part in lane.api_key_command]
        try:
            completed = subprocess.run(
                command,
                shell=shell,
                text=True,
                capture_output=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            print(
                f"WARN: api_key_command for lane {lane.key} timed out after {timeout}s",
                file=sys.stderr,
            )
            return ""
        except OSError as exc:
            print(f"WARN: api_key_command for lane {lane.key} failed: {exc}", file=sys.stderr)
            return ""
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
        # HTTPError is file-like: closing it releases the socket/fd. Without this
        # every failed upstream call leaks one fd in a long-running proxy.
        try:
            body = e.read().decode("utf-8", errors="replace")
        finally:
            e.close()
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


def parse_finish_reason(data: Dict[str, Any]) -> Optional[str]:
    """Return choices[0].finish_reason, or None when the provider omits it.

    Absent is NOT the same as "stop": several OpenAI-compatible servers (and the
    hermes CLI lane, which has no HTTP envelope at all) never populate the field.
    Callers must distinguish "ended normally" from "we were not told".
    """
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    first = choices[0]
    if not isinstance(first, dict):
        return None
    reason = first.get("finish_reason")
    if isinstance(reason, str) and reason:
        return reason
    return None


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


# Default freshness window for proxied-request health results. A live probe
# costs up to the models GET timeout (health_check_timeout_seconds) and up to
# the full request timeout when a chat probe engages, so the proxy must not
# pay that on every request.
LANE_HEALTH_TTL_SECONDS = 30


class LaneHealthCache:
    """Short-TTL memo around check_lane_health for the proxy hot path.

    Outcomes are cached per lane key — including failures, since a dead lane
    is exactly where a per-request probe hurts most. A non-positive TTL
    disables memoization. Probes run outside the lock: concurrent requests may
    duplicate one probe after expiry, but never block each other's network I/O.
    """

    def __init__(self, ttl_seconds: int = LANE_HEALTH_TTL_SECONDS):
        self.ttl_seconds = int(ttl_seconds)
        self._entries: Dict[str, Tuple[float, Tuple[bool, str]]] = {}
        self._lock = threading.Lock()

    def get(self, cfg: Dict[str, Any], lane: Lane) -> Tuple[bool, str]:
        if self.ttl_seconds > 0:
            now = time.monotonic()
            with self._lock:
                entry = self._entries.get(lane.key)
                if entry is not None and now - entry[0] <= self.ttl_seconds:
                    return entry[1]
        ok, reason = check_lane_health(cfg, lane)
        if self.ttl_seconds > 0:
            with self._lock:
                self._entries[lane.key] = (time.monotonic(), (ok, reason))
        return ok, reason


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
                # The CLI lane has no completion envelope, so finish_reason is
                # genuinely unknown rather than "stop".
                return detail, candidate_model, {"latency_ms": latency_ms, "usage": {}, "finish_reason": None}
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
        meta = {
            "latency_ms": latency_ms,
            "usage": usage,
            "finish_reason": parse_finish_reason(data),
        }
        return parse_chat_content(lane.name, data), candidate_model, meta

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


# "+" is here because it is the terminator of `find -exec cmd {} +`. The cost is
# that no argument may contain a literal "+" (regexes, "g++"); that is deliberate.
UNSAFE_TOKEN_CHARS = ";|&<>`$\n\r+"

# Arguments that turn an otherwise read-only command into an execution or
# escape primitive. Matched exactly, and against the option half of "--opt=value".
#
#   find:   -exec/-execdir/-ok/-okdir spawn processes, -delete/-fprint* write,
#           -o/-or lets a denied branch be reached past an earlier filter
#   rg:     --pre/--pre-glob run a preprocessor binary, -z/--search-zip shells
#           out to decompressors, --hostname-bin runs a binary
#   git:    -c/--config-env inject config (diff.external, core.pager),
#           --ext-diff runs the configured external differ, --exec-path,
#           --upload-pack/--receive-pack name programs to run
#   node/npm: --node-options/--require load arbitrary modules, --prefix escapes
#           the workspace
#   python/pytest: -c executes a literal program, -p/--plugins imports a module
#
# Collateral: `ls -o`, `ls -p`, `ls -r`, `git diff -z` are rejected too. Accepted
# — the point of this list is that a denied token is never reasoned about again.
DENIED_ARGUMENTS = frozenset(
    {
        "-exec", "-execdir", "-ok", "-okdir",
        "-delete", "-fprint", "-fprint0", "-fprintf", "-fls",
        "-o", "-or", "--output",
        "--pre", "--pre-glob", "--hostname-bin", "-z", "--search-zip",
        "-c", "--config-env", "--exec-path", "--ext-diff",
        "--upload-pack", "--receive-pack",
        "--prefix", "--node-options", "--require", "-r",
        "-p", "--plugins",
    }
)


# Residual limits of the allowlist — stated so nobody mistakes it for a sandbox:
#
#  * `npm test` and `python3 -m pytest` execute code the repository controls
#    (package.json scripts, conftest.py). Allowlisting them trusts the checkout,
#    not the model. Remove them if the checkout is not trusted.
#  * `cat`/`ls` can read any file *inside* the workspace, including a stray .env.
#    Containment is a workspace boundary, not a secrets boundary.
#  * The denylist enumerates known-bad flags. A future flag of an allowlisted
#    command that spawns a process is not covered until it is added here — which
#    is why `find` and `rg`, whose escape hatches are numerous and version-
#    dependent, were dropped from the shipped default list entirely.
#  * The real boundary remains the double gate: `execution.allow_shell_execution`
#    (shipped false) AND `--execute-approved`. Both must be on before any of this
#    code path runs at all.
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


def _argument_escapes_workspace(token: str, workspace: Path) -> bool:
    """True if a non-flag argument can address a file outside the workspace.

    Resolution-based, not string-based, so "a..b" and "HEAD~5" are fine while
    "..", "/etc/passwd" and a symlink pointing outside are not.
    """
    if not token:
        return False
    if token.startswith("~"):
        # shlex does not expand "~", but several commands do it themselves.
        return True
    try:
        candidate = Path(token)
        resolved = (candidate if candidate.is_absolute() else workspace / candidate).resolve()
        resolved.relative_to(workspace.resolve())
    except (ValueError, OSError):
        return True
    return False


def command_rejection_reason(
    command: str,
    allowed_prefixes: List[str],
    workspace: Optional[Path] = None,
) -> Optional[str]:
    """Return why a command is rejected, or None if it is permitted.

    Three layers, all of which must pass:

    1. argv parse with no shell metacharacter in any token (`parse_command_argv`)
    2. whole-token prefix match against the configured allowlist
    3. per-argument screening of *every* remaining argument: no token from
       DENIED_ARGUMENTS, and no path argument that leaves the workspace

    Layer 3 is the HERMES-1 fix. Previously a prefix match permitted every
    remaining argument unchecked, so an allowlisted `find` or `rg` was a general
    execution primitive and an allowlisted `cat` read any file on the host.
    """
    workspace = Path.cwd() if workspace is None else Path(workspace)
    argv = parse_command_argv(command)
    if argv is None:
        return "unparseable_or_unsafe"

    matched = False
    for prefix in allowed_prefixes:
        try:
            prefix_argv = shlex.split(prefix)
        except ValueError:
            continue
        if prefix_argv and argv[: len(prefix_argv)] == prefix_argv:
            matched = True
            break
    if not matched:
        return "not_allowlisted"

    for token in argv[1:]:
        option, _, value = token.partition("=")
        if token in DENIED_ARGUMENTS or (value and option in DENIED_ARGUMENTS):
            return f"denied_argument:{token}"
        checked = value if (value and token.startswith("-")) else token
        if checked.startswith("-"):
            continue
        if _argument_escapes_workspace(checked, workspace):
            return f"argument_outside_workspace:{token}"
    return None


def command_allowed(
    command: str,
    allowed_prefixes: List[str],
    workspace: Optional[Path] = None,
) -> bool:
    return command_rejection_reason(command, allowed_prefixes, workspace) is None


def run_actions(
    actions: List[str],
    allowed_prefixes: List[str],
    workspace: Optional[Path] = None,
) -> List[Dict[str, Any]]:
    workspace = Path.cwd() if workspace is None else Path(workspace)
    results = []
    for command in actions:
        if not isinstance(command, str):
            results.append({"command": str(command), "status": "rejected", "reason": "not_string"})
            continue
        argv = parse_command_argv(command)
        if argv is None:
            results.append({"command": command, "status": "rejected", "reason": "unparseable_or_unsafe"})
            continue
        reason = command_rejection_reason(command, allowed_prefixes, workspace)
        if reason is not None:
            results.append({"command": command, "status": "rejected", "reason": reason})
            continue
        try:
            completed = subprocess.run(
                argv,
                shell=False,
                text=True,
                capture_output=True,
                timeout=120,
                cwd=str(workspace),
            )
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

    def __init__(self, address, handler, cfg, token, allow_cloud):
        super().__init__(address, handler)
        self.cfg = cfg
        self.token = token
        self.allow_cloud = allow_cloud
        proxy_cfg = cfg.get("proxy", {}) if isinstance(cfg.get("proxy"), dict) else {}
        self.health_cache = LaneHealthCache(
            int(proxy_cfg.get("health_check_ttl_seconds", LANE_HEALTH_TTL_SECONDS))
        )


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


MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024
REQUEST_SOCKET_TIMEOUT_SECONDS = 30
_DRAIN_CHUNK_BYTES = 64 * 1024


class ProxyHandler(BaseHTTPRequestHandler):
    server: ProxyServer  # narrowed type for attribute access

    protocol_version = "HTTP/1.1"
    # StreamRequestHandler.setup() applies this to the connection socket. Without
    # it a client that sends headers and then stalls parks a handler thread
    # forever (HERMES-6).
    timeout = REQUEST_SOCKET_TIMEOUT_SECONDS

    def log_message(self, format: str, *log_args: Any) -> None:  # noqa: A002
        # Suppress per-request stderr noise; routing telemetry covers requests.
        pass

    def _send_json(self, code: int, obj: Dict[str, Any], close: bool = False) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if close:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        self.wfile.write(body)

    def _content_length(self) -> int:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return -1
        return length if length >= 0 else -1

    def _drain_request_body(self) -> bool:
        """Consume the request body so keep-alive stays in sync.

        With HTTP/1.1 keep-alive an undrained body is parsed as the next request
        line (HERMES-5). Returns False when the body is too large to drain, in
        which case the caller must close the connection instead.
        """
        length = self._content_length()
        if length <= 0:
            return True
        if length > MAX_REQUEST_BODY_BYTES:
            return False
        remaining = length
        while remaining > 0:
            chunk = self.rfile.read(min(_DRAIN_CHUNK_BYTES, remaining))
            if not chunk:
                return False
            remaining -= len(chunk)
        return True

    def _reject(self, code: int, message: str) -> None:
        """Answer an early-return error, keeping the connection consistent."""
        drained = self._drain_request_body()
        self._send_json(code, {"error": {"message": message}}, close=not drained)

    def _authorized(self) -> bool:
        if self.server.token is None:
            return True
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return False
        # Compare bytes: hmac.compare_digest on str raises TypeError for any
        # non-ASCII input, which crashed the handler thread pre-auth (HERMES-3).
        presented = header[len("Bearer "):].strip().encode("utf-8", errors="surrogateescape")
        expected = str(self.server.token).encode("utf-8", errors="surrogateescape")
        return hmac.compare_digest(presented, expected)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self._send_json(200, {"status": "ok"})
            return
        if not self._authorized():
            self._reject(401, "missing or invalid bearer token")
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
        self._reject(404, f"unknown path {self.path}")

    def do_POST(self) -> None:  # noqa: N802
        if not self._authorized():
            self._reject(401, "missing or invalid bearer token")
            return
        if self.path != "/v1/chat/completions":
            self._reject(404, f"unknown path {self.path}")
            return

        length = self._content_length()
        if length < 0:
            self._send_json(400, {"error": {"message": "invalid Content-Length"}}, close=True)
            return
        if length > MAX_REQUEST_BODY_BYTES:
            # Do not read it; answer and close rather than stream megabytes we
            # already know we will discard (HERMES-6).
            self._send_json(
                413,
                {"error": {"message": f"request body exceeds {MAX_REQUEST_BODY_BYTES} bytes"}},
                close=True,
            )
            return

        try:
            raw = self.rfile.read(length) if length else b""
            if len(raw) != length:
                self._send_json(400, {"error": {"message": "truncated request body"}}, close=True)
                return
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except (ValueError, json.JSONDecodeError, OSError):
            self._send_json(400, {"error": {"message": "invalid JSON body"}}, close=True)
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
                ok, reason = self.server.health_cache.get(cfg, lane)
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
                    if status in (401, 403, 404):
                        # Auth and missing-endpoint failures are lane problems:
                        # every fallback model hits the same credentials and
                        # URL, so retrying them cannot succeed.
                        break
                if data is None:
                    continue

            latency_ms = int((time.monotonic() - start) * 1000)
            usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
            model_used = str(data.get("model", lane.model))
            log_routing_event(
                cfg,
                routing_event(
                    "proxy", lane, model_used, ok=True, latency_ms=latency_ms, usage=usage,
                    extra={
                        "requested_model": requested_model,
                        "stream": stream,
                        # Reasons every earlier lane was skipped or failed. Empty
                        # when the first lane served the request (HERMES-DOC-1).
                        "attempts": list(attempts),
                    },
                ),
            )
            if stream:
                self._send_stream_shim(data, model_used)
            else:
                self._send_json(200, data)
            return

        # Total failure used to write no telemetry at all, so failed requests were
        # invisible in routing.jsonl (HERMES-12).
        log_routing_event(
            cfg,
            routing_event(
                "proxy",
                None,
                requested_model,
                ok=False,
                error="no lane could serve the request",
                extra={
                    "requested_model": requested_model,
                    "stream": stream,
                    "attempts": list(attempts),
                },
            ),
        )
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

    # No prompt-logging switch exists by design: request bodies are never written
    # anywhere, so there is nothing to gate (HERMES-9).
    server = ProxyServer((host, port), ProxyHandler, cfg, token, allow_cloud)
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
