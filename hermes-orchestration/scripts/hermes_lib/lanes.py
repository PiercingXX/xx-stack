"""Lane configuration, health probes, and OpenAI-compatible HTTP helpers."""

from __future__ import annotations

import http.client
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
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
    # The public module is the documented monkeypatch point
    # (`hermes_orchestrator.run_hermes_cli_oneshot`). After the split, call
    # sites live in this package, so honor a replacement bound there.
    ho_mod = sys.modules.get("hermes_orchestrator")
    patched = getattr(ho_mod, "run_hermes_cli_oneshot", None) if ho_mod is not None else None
    if patched is not None and patched is not run_hermes_cli_oneshot:
        return patched(lane, timeout, model, prompt)

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

