"""Loopback OpenAI-compatible proxy fronting the routing policy."""

from __future__ import annotations

import argparse
import hmac
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional

from .inventory import log_routing_event, routing_event
from .lanes import (
    LANE_HEALTH_TTL_SECONDS,
    LaneHealthCache,
    OrchestratorError,
    http_json,
    is_cloud_lane,
    lane_chat_url,
    lane_from_config,
    lane_model_candidates,
    ordered_lane_keys,
    parse_chat_content,
    request_timeout,
    resolve_api_key,
    run_hermes_cli_oneshot,
)
from .routing import model_matches_requirement, primary_lane_order


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
