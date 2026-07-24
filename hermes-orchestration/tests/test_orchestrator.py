"""Unit tests for hermes_orchestrator routing, safety, and proxy behavior.

Run with either:
    python3 -m unittest discover -s tests -v
    python3 -m pytest tests/ -v
"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import hermes_orchestrator as ho  # noqa: E402


class StubLaneHandler(BaseHTTPRequestHandler):
    """Minimal OpenAI-compatible stub. Behavior flags live on the server object."""

    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):  # noqa: A002
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.server.fail:
            self._send(500, {"error": "stub_down"})
            return
        if self.path.endswith("/models"):
            self._send(200, {"object": "list", "data": [{"id": m} for m in self.server.models]})
            return
        self._send(404, {"error": "not_found"})

    def do_POST(self):
        if self.server.fail:
            self._send(500, {"error": "stub_down"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        if payload.get("tools") and self.server.tool_support:
            message = {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "ping", "arguments": "{\"value\": \"ok\"}"},
                    }
                ],
            }
        else:
            message = {"role": "assistant", "content": self.server.reply}
        self._send(
            200,
            {
                "id": "chatcmpl-stub",
                "object": "chat.completion",
                "created": 0,
                "model": payload.get("model", "stub-model"),
                "choices": [{"index": 0, "message": message, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 7, "total_tokens": 12},
            },
        )


class StubLaneServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, models, reply="stub-reply", tool_support=False):
        super().__init__(("127.0.0.1", 0), StubLaneHandler)
        self.models = models
        self.reply = reply
        self.tool_support = tool_support
        self.fail = False
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self):
        return f"http://127.0.0.1:{self.server_address[1]}/v1"

    def stop(self):
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=5)


def make_cfg(tmpdir, lanes, **execution_overrides):
    execution = {
        "request_timeout_seconds": 10,
        "health_check_timeout_seconds": 3,
        "max_parallel_subagents": 4,
        "use_capability_cache_for_subagents": True,
        "capability_cache_file": str(Path(tmpdir) / "capability-cache.json"),
        "auto_refresh_capability_cache": True,
        "capability_cache_max_age_seconds": 600,
        "reuse_tool_probe_for_same_model": True,
        "require_tool_call_for_subagents": False,
        "allow_cloud_subagent_delegation": True,
        "cloud_subagent_profiles": ["hardware-constrained", "specialized-model"],
        "routing_log_file": str(Path(tmpdir) / "routing.jsonl"),
        "routing_presets": {},
        "allow_shell_execution": False,
        "allowed_command_prefixes": ["pwd", "git status"],
    }
    execution.update(execution_overrides)
    return {
        "version": 3,
        "policy": {"self_hosted_first": True},
        "execution": execution,
        "lanes": lanes,
    }


def lane_cfg(name, base_url, model, role="self_hosted", priority=50, enabled=True, **extra):
    cfg = {
        "name": name,
        "role": role,
        "priority": priority,
        "endpoint_type": "openai_compatible",
        "base_url": base_url,
        "model": model,
        "enabled": enabled,
    }
    cfg.update(extra)
    return cfg


class CommandSafetyTests(unittest.TestCase):
    ALLOWED = ["pwd", "ls", "git status", "git log"]

    def test_plain_allowlisted_commands_pass(self):
        self.assertTrue(ho.command_allowed("pwd", self.ALLOWED))
        self.assertTrue(ho.command_allowed("git status", self.ALLOWED))
        self.assertTrue(ho.command_allowed("git status --short", self.ALLOWED))
        self.assertTrue(ho.command_allowed("ls -la /tmp", self.ALLOWED))

    def test_non_allowlisted_commands_rejected(self):
        self.assertFalse(ho.command_allowed("rm -rf /", self.ALLOWED))
        self.assertFalse(ho.command_allowed("git push", self.ALLOWED))
        self.assertFalse(ho.command_allowed("", self.ALLOWED))

    def test_shell_injection_rejected(self):
        self.assertFalse(ho.command_allowed("git status; rm -rf ~", self.ALLOWED))
        self.assertFalse(ho.command_allowed("git status && rm -rf ~", self.ALLOWED))
        self.assertFalse(ho.command_allowed("git status | tee /etc/passwd", self.ALLOWED))
        self.assertFalse(ho.command_allowed("git status $(rm -rf ~)", self.ALLOWED))
        self.assertFalse(ho.command_allowed("git status `rm -rf ~`", self.ALLOWED))
        self.assertFalse(ho.command_allowed("git status > /etc/shadow", self.ALLOWED))

    def test_prefix_must_match_whole_tokens(self):
        # "git statusx" must not match the "git status" prefix.
        self.assertFalse(ho.command_allowed("git statusx", self.ALLOWED))

    def test_run_actions_executes_without_shell(self):
        results = ho.run_actions(["pwd", "pwd; echo pwned", "echo hi"], self.ALLOWED)
        self.assertEqual(results[0]["status"], "ok")
        self.assertEqual(results[1]["status"], "rejected")
        self.assertEqual(results[2]["status"], "rejected")


class SplitTests(unittest.TestCase):
    def test_explicit_split(self):
        self.assertEqual(ho.split_subtasks("a || b ||c"), ["a", "b", "c"])

    def test_no_implicit_sentence_split(self):
        task = "Do one thing. Then check another. Then report."
        self.assertEqual(ho.split_subtasks(task), [task])


class LaneOrderingTests(unittest.TestCase):
    def setUp(self):
        self.cfg = make_cfg(
            tempfile.mkdtemp(),
            {
                "beta": lane_cfg("beta", "http://x/v1", "m-beta", priority=70),
                "alpha": lane_cfg("alpha", "http://x/v1", "m-alpha", priority=100),
                "cloud": lane_cfg("cloud", "cli://x", "m-cloud", role="cloud", priority=50),
            },
        )

    def test_self_hosted_sorted_by_priority(self):
        self.assertEqual(ho.self_hosted_lane_keys(self.cfg), ["alpha", "beta"])

    def test_ordered_keys_put_cloud_last(self):
        self.assertEqual(ho.ordered_lane_keys(self.cfg), ["alpha", "beta", "cloud"])

    def test_cloud_role_inferred_from_endpoint_type(self):
        cfg = make_cfg(
            tempfile.mkdtemp(),
            {"c": {"name": "c", "endpoint_type": "hermes_cli", "base_url": "x", "model": "m"}},
        )
        self.assertTrue(ho.is_cloud_lane(cfg, "c"))

    def test_model_matches_requirement(self):
        self.assertTrue(ho.model_matches_requirement("", [], "anything"))
        self.assertTrue(ho.model_matches_requirement("codex", ["gpt-5.3-codex"], ""))
        self.assertTrue(ho.model_matches_requirement("qwen", [], "qwen3-coder-next"))
        self.assertFalse(ho.model_matches_requirement("llama", ["qwen"], "qwen"))


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.stub_a = StubLaneServer(["model-a"], reply="reply-a")
        self.stub_b = StubLaneServer(["model-b", "beta-model"], reply="reply-b", tool_support=True)
        self.addCleanup(self.stub_a.stop)
        self.addCleanup(self.stub_b.stop)

    def _cfg(self, **execution_overrides):
        return make_cfg(
            self.tmpdir,
            {
                "a": lane_cfg("lane-a", self.stub_a.base_url, "model-a", priority=100),
                "b": lane_cfg("lane-b", self.stub_b.base_url, "model-b", priority=70),
                "cloud": lane_cfg(
                    "cloud-lane",
                    "cli://none",
                    "gpt-5.3-codex",
                    role="cloud",
                    priority=50,
                    endpoint_type="hermes_cli",
                    provider="github-copilot",
                ),
            },
            **execution_overrides,
        )

    def test_primary_prefers_highest_priority(self):
        key, lane = ho.choose_primary_lane(self._cfg(), allow_cloud=False, reason_code="TEST")
        self.assertEqual(key, "a")
        self.assertEqual(lane.name, "lane-a")

    def test_primary_falls_back_when_first_lane_down(self):
        self.stub_a.fail = True
        key, _ = ho.choose_primary_lane(self._cfg(), allow_cloud=False, reason_code="TEST")
        self.assertEqual(key, "b")

    def test_primary_blocks_cloud_without_flag(self):
        self.stub_a.fail = True
        self.stub_b.fail = True
        with self.assertRaises(ho.OrchestratorError):
            ho.choose_primary_lane(self._cfg(), allow_cloud=False, reason_code="TEST")

    def test_primary_allows_cloud_with_flag(self):
        self.stub_a.fail = True
        self.stub_b.fail = True
        key, _ = ho.choose_primary_lane(self._cfg(), allow_cloud=True, reason_code="TEST")
        self.assertEqual(key, "cloud")

    def test_subagents_prefer_priority_lane(self):
        key, _ = ho.resolve_subagent_lane(
            self._cfg(), allow_cloud=False, task_profile="hardware-constrained", required_model=""
        )
        self.assertEqual(key, "a")

    def test_subagents_required_model_filters_lanes(self):
        key, _ = ho.resolve_subagent_lane(
            self._cfg(), allow_cloud=False, task_profile="hardware-constrained", required_model="beta-model"
        )
        self.assertEqual(key, "b")

    def test_strict_tool_gate_skips_lane_without_tool_support(self):
        cfg = self._cfg(require_tool_call_for_subagents=True)
        key, _ = ho.resolve_subagent_lane(
            cfg, allow_cloud=False, task_profile="default", required_model=""
        )
        self.assertEqual(key, "b")

    def test_call_chat_returns_usage_and_latency(self):
        cfg = self._cfg()
        lane = ho.lane_from_config(cfg, "a")
        content, model, meta = ho.call_chat(lane, 10, "sys", "user")
        self.assertEqual(content, "reply-a")
        self.assertEqual(model, "model-a")
        self.assertEqual(meta["usage"]["completion_tokens"], 7)
        self.assertIsInstance(meta["latency_ms"], int)

    def test_probe_reuse_skips_second_probe(self):
        cfg = self._cfg(require_tool_call_for_subagents=True)
        first = ho.build_inventory_report(cfg, include_cloud=False, probe_tool_calls=True)
        second = ho.build_inventory_report(cfg, include_cloud=False, probe_tool_calls=True, previous=first)
        self.assertEqual(second["lanes"]["b"]["tool_probe_reason"], "reused_previous_probe")
        self.assertEqual(
            second["lanes"]["b"]["tool_call_supported"],
            first["lanes"]["b"]["tool_call_supported"],
        )


class ProxyTests(unittest.TestCase):
    TOKEN = "test-secret-token"

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.stub = StubLaneServer(["model-a"], reply="proxied-reply")
        self.addCleanup(self.stub.stop)
        cfg = make_cfg(
            self.tmpdir,
            {"a": lane_cfg("lane-a", self.stub.base_url, "model-a", priority=100)},
        )
        cfg["policy"]["primary_lane_order"] = ["a"]
        self.proxy = ho.ProxyServer(
            ("127.0.0.1", 0), ho.ProxyHandler, cfg, self.TOKEN, allow_cloud=False, log_prompts=False
        )
        self.thread = threading.Thread(target=self.proxy.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self._stop_proxy)
        self.base = f"http://127.0.0.1:{self.proxy.server_address[1]}"

    def _stop_proxy(self):
        self.proxy.shutdown()
        self.proxy.server_close()
        self.thread.join(timeout=5)

    def _request(self, path, payload=None, token=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(self.base + path, data=data, headers=headers)
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.getcode(), json.loads(resp.read().decode("utf-8"))

    def test_healthz_needs_no_auth(self):
        code, body = self._request("/healthz")
        self.assertEqual(code, 200)
        self.assertEqual(body["status"], "ok")

    def test_models_requires_auth(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self._request("/v1/models")
        self.assertEqual(ctx.exception.code, 401)

    def test_models_lists_lane_models(self):
        code, body = self._request("/v1/models", token=self.TOKEN)
        self.assertEqual(code, 200)
        ids = [m["id"] for m in body["data"]]
        self.assertIn("auto", ids)
        self.assertIn("model-a", ids)

    def test_chat_completion_routes_to_lane(self):
        code, body = self._request(
            "/v1/chat/completions",
            payload={"model": "auto", "messages": [{"role": "user", "content": "hi"}]},
            token=self.TOKEN,
        )
        self.assertEqual(code, 200)
        self.assertEqual(body["choices"][0]["message"]["content"], "proxied-reply")

    def test_chat_rejects_bad_token(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self._request(
                "/v1/chat/completions",
                payload={"messages": [{"role": "user", "content": "hi"}]},
                token="wrong",
            )
        self.assertEqual(ctx.exception.code, 401)


if __name__ == "__main__":
    unittest.main()
