"""Unit tests for hermes_orchestrator routing, safety, and proxy behavior.

Run with either:
    python3 -m unittest discover -s tests -v
    python3 -m pytest tests/ -v

Safety tests run against the **shipped** allowlist in `config/orchestration.json`,
not a hand-picked one: a hand-picked list is what hid HERMES-1.
"""

from __future__ import annotations

import email.message
import http.client
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import hermes_orchestrator as ho  # noqa: E402

HERMES_DIR = Path(__file__).resolve().parent.parent
SHIPPED_CONFIG_PATH = HERMES_DIR / "config" / "orchestration.json"
SHIPPED_CFG = json.loads(SHIPPED_CONFIG_PATH.read_text(encoding="utf-8"))
SHIPPED_ALLOWLIST = list(SHIPPED_CFG["execution"]["allowed_command_prefixes"])
SHIPPED_PRESETS = SHIPPED_CFG["execution"]["routing_presets"]


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


class TempDirMixin(unittest.TestCase):
    def make_tempdir(self) -> str:
        path = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, path, ignore_errors=True)
        return path


class CommandSafetyTests(TempDirMixin):
    """HERMES-TEST-1: parametrized over the SHIPPED allowlist, not a stand-in."""

    ALLOWED = SHIPPED_ALLOWLIST

    def setUp(self):
        self.workspace = Path(self.make_tempdir()).resolve()
        (self.workspace / "README.md").write_text("hello", encoding="utf-8")
        (self.workspace / "sub").mkdir()

    def allowed(self, command, allowlist=None):
        return ho.command_allowed(command, allowlist or self.ALLOWED, workspace=self.workspace)

    def reason(self, command, allowlist=None):
        return ho.command_rejection_reason(command, allowlist or self.ALLOWED, workspace=self.workspace)

    # --- the allowlist stays genuinely useful -------------------------------

    def test_shipped_allowlist_permits_ordinary_readers(self):
        for command in [
            "pwd",
            "ls",
            "ls -la",
            "ls sub",
            "cat README.md",
            "git status",
            "git status --short",
            "git diff",
            "git log --oneline -n 5",
            "python3 -m pytest",
            "python3 -m pytest sub",
            "npm test",
        ]:
            with self.subTest(command=command):
                self.assertTrue(self.allowed(command), self.reason(command))

    def test_every_shipped_prefix_is_itself_permitted(self):
        for prefix in self.ALLOWED:
            with self.subTest(prefix=prefix):
                self.assertTrue(self.allowed(prefix), self.reason(prefix))

    # --- HERMES-1: the confirmed bypasses -----------------------------------

    def test_find_exec_bypass_rejected(self):
        command = "find . -maxdepth 0 -exec /bin/sh -c 'echo PWNED' {} +"
        self.assertFalse(self.allowed(command))
        # Also rejected if an operator re-adds `find` to their allowlist.
        self.assertFalse(self.allowed(command, self.ALLOWED + ["find"]))

    def test_find_delete_bypass_rejected(self):
        self.assertFalse(self.allowed("find / -delete"))
        self.assertFalse(self.allowed("find / -delete", self.ALLOWED + ["find"]))
        self.assertFalse(self.allowed("find . -fprintf /tmp/x %p", self.ALLOWED + ["find"]))

    def test_rg_preprocessor_bypass_rejected(self):
        command = "rg --pre /bin/sh --pre-glob '*' x ."
        self.assertFalse(self.allowed(command))
        self.assertFalse(self.allowed(command, self.ALLOWED + ["rg"]))

    def test_cat_home_credentials_bypass_rejected(self):
        # The docs state premium credentials live in ~/.hermes/config.yaml.
        self.assertEqual(self.reason("cat ~/.hermes/config.yaml"), "argument_outside_workspace:~/.hermes/config.yaml")
        self.assertFalse(self.allowed("cat /etc/passwd"))
        self.assertFalse(self.allowed("cat ../outside.txt"))
        self.assertFalse(self.allowed("ls /"))
        self.assertFalse(self.allowed("ls -la /tmp"))

    def test_git_external_diff_bypass_rejected(self):
        self.assertEqual(self.reason("git log --ext-diff"), "denied_argument:--ext-diff")
        self.assertFalse(self.allowed("git log -c diff.external=/bin/sh"))
        # `git -c ...` never matches the "git log" prefix in the first place.
        self.assertEqual(self.reason("git -c diff.external=/bin/sh log"), "not_allowlisted")

    def test_plus_terminator_is_an_unsafe_token(self):
        self.assertIsNone(ho.parse_command_argv("find . -exec sh {} +"))
        self.assertIn("+", ho.UNSAFE_TOKEN_CHARS)

    def test_process_spawning_flags_rejected_for_every_command(self):
        for command in [
            "npm test --prefix /tmp",
            "npm test --node-options=--require=/tmp/x.js",
            "python3 -m pytest -p evil_plugin",
            "python3 -m pytest -c /tmp/pytest.ini",
        ]:
            with self.subTest(command=command):
                reason = self.reason(command)
                self.assertIsNotNone(reason)
                self.assertTrue(reason.startswith("denied_argument"), reason)

    def test_shipped_allowlist_has_no_argument_spawning_readers(self):
        # find/rg were dropped: their escape hatches are numerous and version
        # dependent, so a denylist alone is not a safe boundary for them.
        self.assertNotIn("find", SHIPPED_ALLOWLIST)
        self.assertNotIn("rg", SHIPPED_ALLOWLIST)

    # --- pre-existing guarantees --------------------------------------------

    def test_non_allowlisted_commands_rejected(self):
        self.assertFalse(self.allowed("rm -rf /"))
        self.assertFalse(self.allowed("git push"))
        self.assertFalse(self.allowed(""))
        self.assertFalse(self.allowed("python3 -c 'import os'"))

    def test_shell_injection_rejected(self):
        for command in [
            "git status; rm -rf ~",
            "git status && rm -rf ~",
            "git status | tee /etc/passwd",
            "git status $(rm -rf ~)",
            "git status `rm -rf ~`",
            "git status > /etc/shadow",
        ]:
            with self.subTest(command=command):
                self.assertFalse(self.allowed(command))

    def test_prefix_must_match_whole_tokens(self):
        self.assertFalse(self.allowed("git statusx"))

    def test_run_actions_executes_without_shell(self):
        results = ho.run_actions(
            ["pwd", "pwd; echo pwned", "echo hi", "cat /etc/passwd"],
            self.ALLOWED,
            workspace=self.workspace,
        )
        self.assertEqual(results[0]["status"], "ok")
        self.assertEqual(results[1]["status"], "rejected")
        self.assertEqual(results[2]["status"], "rejected")
        self.assertEqual(results[3]["status"], "rejected")
        self.assertTrue(results[3]["reason"].startswith("argument_outside_workspace"))


class CloudGateDefaultTests(unittest.TestCase):
    """HERMES-2 / HERMES-10: the cloud opt-in must fail closed."""

    def test_missing_keys_fail_closed(self):
        self.assertFalse(ho.cloud_default_enabled({}))
        self.assertFalse(ho.cloud_default_enabled({"policy": {}, "execution": {}}))
        self.assertFalse(
            ho.cloud_default_enabled(
                {"policy": {"require_manual_cloud_escalation": False}, "execution": {}}
            )
        )
        self.assertFalse(
            ho.cloud_default_enabled(
                {
                    "policy": {"require_manual_cloud_escalation": False, "cloud_enabled_by_default": True},
                    "execution": {},
                }
            )
        )

    def test_all_three_opt_ins_enable_it(self):
        cfg = {
            "policy": {"require_manual_cloud_escalation": False, "cloud_enabled_by_default": True},
            "execution": {"subagents_allow_cloud_default": True},
        }
        self.assertTrue(ho.cloud_default_enabled(cfg))

    def test_shipped_config_keeps_cloud_off_by_default(self):
        self.assertFalse(ho.cloud_default_enabled(SHIPPED_CFG))

    def test_policy_cloud_key_is_wired_not_decorative(self):
        # HERMES-10: flipping policy.cloud_enabled_by_default must change behavior.
        cfg = {
            "policy": {"require_manual_cloud_escalation": False, "cloud_enabled_by_default": False},
            "execution": {"subagents_allow_cloud_default": True},
        }
        self.assertFalse(ho.cloud_default_enabled(cfg))
        cfg["policy"]["cloud_enabled_by_default"] = True
        self.assertTrue(ho.cloud_default_enabled(cfg))

    def test_dead_policy_keys_removed_from_shipped_config(self):
        for key in ("preferred_cloud_model", "fallback_cloud_model"):
            self.assertNotIn(key, SHIPPED_CFG["policy"])

    def test_subagent_delegation_keys_fail_closed(self):
        lanes = {"cloud": lane_cfg("cloud", "cli://x", "m", role="cloud", enabled=True)}
        cfg = {"execution": {}, "lanes": lanes, "policy": {}}
        self.assertFalse(
            ho.cloud_allowed_for_subagents(cfg, allow_cloud=True, task_profile="hardware-constrained")
        )
        cfg["execution"] = {"allow_cloud_subagent_delegation": True}
        self.assertFalse(
            ho.cloud_allowed_for_subagents(cfg, allow_cloud=True, task_profile="hardware-constrained")
        )
        cfg["execution"]["cloud_subagent_profiles"] = ["hardware-constrained"]
        self.assertTrue(
            ho.cloud_allowed_for_subagents(cfg, allow_cloud=True, task_profile="hardware-constrained")
        )


class ApiKeyResolutionTests(unittest.TestCase):
    """HERMES-7: a hanging credential helper must not park the thread."""

    def test_api_key_command_timeout_is_bounded(self):
        lane = ho.Lane(
            key="x",
            name="x",
            base_url="",
            model="m",
            enabled=True,
            api_key_command="sleep 30",
        )
        start = time.monotonic()
        self.assertEqual(ho.resolve_api_key(lane, timeout=1), "")
        self.assertLess(time.monotonic() - start, 10)

    def test_env_var_short_circuits_command(self):
        os.environ["HERMES_TEST_KEY"] = "from-env"
        self.addCleanup(os.environ.pop, "HERMES_TEST_KEY", None)
        lane = ho.Lane(
            key="x",
            name="x",
            base_url="",
            model="m",
            enabled=True,
            api_key_env="HERMES_TEST_KEY",
            api_key_command="sleep 30",
        )
        self.assertEqual(ho.resolve_api_key(lane, timeout=1), "from-env")


class _RecordingHTTPError(urllib.error.HTTPError):
    def __init__(self, body: bytes):
        super().__init__("http://example.invalid", 500, "err", email.message.Message(), io.BytesIO(body))
        self.close_calls = 0

    def close(self):
        self.close_calls += 1
        super().close()


class HttpJsonResourceTests(unittest.TestCase):
    """HERMES-4: the HTTPError body must be closed, not just read."""

    def test_http_error_is_closed(self):
        error = _RecordingHTTPError(b'{"error": "boom"}')

        def fake_urlopen(*_args, **_kwargs):
            raise error

        original = ho.urllib.request.urlopen
        ho.urllib.request.urlopen = fake_urlopen
        self.addCleanup(setattr, ho.urllib.request, "urlopen", original)

        status, parsed = ho.http_json("GET", "http://example.invalid/v1/models", None, 5)
        self.assertEqual(status, 500)
        self.assertEqual(parsed, {"error": "boom"})
        self.assertGreaterEqual(error.close_calls, 1)


class SplitTests(unittest.TestCase):
    def test_explicit_split(self):
        self.assertEqual(ho.split_subtasks("a || b ||c"), ["a", "b", "c"])

    def test_no_implicit_sentence_split(self):
        task = "Do one thing. Then check another. Then report."
        self.assertEqual(ho.split_subtasks(task), [task])


class LaneOrderingTests(TempDirMixin):
    def setUp(self):
        self.cfg = make_cfg(
            self.make_tempdir(),
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

    def test_primary_lane_order_resorts_generated_order_by_priority(self):
        # HERMES-11: the generated list is raw object insertion order.
        self.cfg["policy"]["primary_lane_order"] = ["beta", "cloud", "alpha"]
        self.assertEqual(ho.primary_lane_order(self.cfg), ["alpha", "beta", "cloud"])

    def test_primary_lane_order_selects_membership_only(self):
        self.cfg["policy"]["primary_lane_order"] = ["beta", "ghost"]
        self.assertEqual(ho.primary_lane_order(self.cfg), ["beta"])

    def test_primary_lane_order_falls_back_when_list_is_junk(self):
        self.cfg["policy"]["primary_lane_order"] = ["ghost"]
        self.assertEqual(ho.primary_lane_order(self.cfg), ["alpha", "beta", "cloud"])

    def test_self_hosted_first_policy_key_is_wired(self):
        self.cfg["policy"]["self_hosted_first"] = False
        self.cfg["lanes"]["cloud"]["priority"] = 200
        self.assertEqual(ho.ordered_lane_keys(self.cfg), ["cloud", "alpha", "beta"])

    def test_cloud_role_inferred_from_endpoint_type(self):
        cfg = make_cfg(
            self.make_tempdir(),
            {"c": {"name": "c", "endpoint_type": "hermes_cli", "base_url": "x", "model": "m"}},
        )
        self.assertTrue(ho.is_cloud_lane(cfg, "c"))

    def test_model_matches_requirement(self):
        self.assertTrue(ho.model_matches_requirement("", [], "anything"))
        self.assertTrue(ho.model_matches_requirement("codex", ["gpt-5.3-codex"], ""))
        self.assertTrue(ho.model_matches_requirement("qwen", [], "qwen3-coder-next"))
        self.assertFalse(ho.model_matches_requirement("llama", ["qwen"], "qwen"))


class RoutingTests(TempDirMixin):
    def setUp(self):
        self.tmpdir = self.make_tempdir()
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

    def test_no_shipped_preset_uses_the_default_profile(self):
        # Why the old `and task_profile == "default"` gate was dead (HERMES-8).
        profiles = {preset["task_profile"] for preset in SHIPPED_PRESETS.values()}
        self.assertNotIn("default", profiles)

    def test_strict_tool_gate_engages_for_every_shipped_preset(self):
        cfg = self._cfg(require_tool_call_for_subagents=True)
        self.assertEqual(len(SHIPPED_PRESETS), 5)
        for name, preset in SHIPPED_PRESETS.items():
            with self.subTest(preset=name):
                key, _ = ho.resolve_subagent_lane(
                    cfg,
                    allow_cloud=False,
                    task_profile=preset["task_profile"],
                    required_model="",
                )
                # lane-a is healthy and higher priority but fails the tool probe.
                self.assertEqual(key, "b")

    def test_strict_tool_gate_refuses_when_no_lane_passes_probe(self):
        cfg = make_cfg(
            self.tmpdir,
            {"a": lane_cfg("lane-a", self.stub_a.base_url, "model-a", priority=100)},
            require_tool_call_for_subagents=True,
        )
        for profile in sorted({p["task_profile"] for p in SHIPPED_PRESETS.values()}):
            with self.subTest(profile=profile):
                with self.assertRaises(ho.OrchestratorError) as ctx:
                    ho.resolve_subagent_lane(
                        cfg, allow_cloud=False, task_profile=profile, required_model=""
                    )
                self.assertIn("tool-call probe", str(ctx.exception))

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


class ProxyTests(TempDirMixin):
    TOKEN = "test-secret-token"

    def setUp(self):
        self.tmpdir = self.make_tempdir()
        self.stub = StubLaneServer(["model-a"], reply="proxied-reply")
        self.addCleanup(self.stub.stop)
        self.cfg = make_cfg(
            self.tmpdir,
            {"a": lane_cfg("lane-a", self.stub.base_url, "model-a", priority=100)},
        )
        self.cfg["policy"]["primary_lane_order"] = ["a"]
        self.routing_log = Path(self.cfg["execution"]["routing_log_file"])
        self.proxy = ho.ProxyServer(
            ("127.0.0.1", 0), ho.ProxyHandler, self.cfg, self.TOKEN, allow_cloud=False
        )
        self.thread = threading.Thread(target=self.proxy.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self._stop_proxy)
        self.port = self.proxy.server_address[1]
        self.base = f"http://127.0.0.1:{self.port}"

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

    def _connection(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        self.addCleanup(conn.close)
        return conn

    def _routing_records(self):
        if not self.routing_log.exists():
            return []
        return [
            json.loads(line)
            for line in self.routing_log.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def test_healthz_needs_no_auth(self):
        code, body = self._request("/healthz")
        self.assertEqual(code, 200)
        self.assertEqual(body["status"], "ok")

    def test_models_requires_auth(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self._request("/v1/models")
        self.assertEqual(ctx.exception.code, 401)
        ctx.exception.close()

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
        ctx.exception.close()

    # --- HERMES-3 -----------------------------------------------------------

    def test_non_ascii_bearer_token_is_rejected_not_crashed(self):
        conn = self._connection()
        conn.request(
            "GET",
            "/v1/models",
            headers={"Authorization": "Bearer tökén"},
        )
        resp = conn.getresponse()
        self.assertEqual(resp.status, 401)
        resp.read()
        # The handler thread survived: the connection still serves requests.
        conn.request("GET", "/healthz")
        follow_up = conn.getresponse()
        self.assertEqual(follow_up.status, 200)
        follow_up.read()

    # --- HERMES-5 -----------------------------------------------------------

    def test_unauthorized_post_body_does_not_desync_keepalive(self):
        conn = self._connection()
        body = json.dumps({"messages": [{"role": "user", "content": "x" * 2048}]}).encode("utf-8")
        conn.request(
            "POST",
            "/v1/chat/completions",
            body=body,
            headers={"Authorization": "Bearer wrong", "Content-Type": "application/json"},
        )
        resp = conn.getresponse()
        self.assertEqual(resp.status, 401)
        resp.read()
        # Next request on the same connection must be parsed as a request, not as
        # leftover body bytes.
        conn.request("GET", "/healthz")
        follow_up = conn.getresponse()
        self.assertEqual(follow_up.status, 200)
        self.assertEqual(json.loads(follow_up.read().decode("utf-8"))["status"], "ok")

    def test_unknown_post_path_body_does_not_desync_keepalive(self):
        conn = self._connection()
        body = json.dumps({"messages": [{"role": "user", "content": "y" * 2048}]}).encode("utf-8")
        conn.request(
            "POST",
            "/v1/nope",
            body=body,
            headers={"Authorization": f"Bearer {self.TOKEN}", "Content-Type": "application/json"},
        )
        resp = conn.getresponse()
        self.assertEqual(resp.status, 404)
        resp.read()
        conn.request("GET", "/healthz")
        follow_up = conn.getresponse()
        self.assertEqual(follow_up.status, 200)
        follow_up.read()

    # --- HERMES-6 -----------------------------------------------------------

    def test_oversized_body_rejected_with_413_without_reading_it(self):
        conn = self._connection()
        conn.putrequest("POST", "/v1/chat/completions")
        conn.putheader("Authorization", f"Bearer {self.TOKEN}")
        conn.putheader("Content-Type", "application/json")
        conn.putheader("Content-Length", str(ho.MAX_REQUEST_BODY_BYTES + 1))
        conn.endheaders()  # deliberately never send the body
        resp = conn.getresponse()
        self.assertEqual(resp.status, 413)
        resp.read()

    def test_handler_has_socket_timeout(self):
        self.assertIsNotNone(ho.ProxyHandler.timeout)
        self.assertLessEqual(ho.ProxyHandler.timeout, 120)

    # --- HERMES-9 -----------------------------------------------------------

    def test_no_log_prompts_surface(self):
        self.assertFalse(hasattr(self.proxy, "log_prompts"))
        self.assertNotIn("log_prompts", SHIPPED_CFG.get("proxy", {}))

    # --- HERMES-12 ----------------------------------------------------------

    def test_total_failure_writes_routing_event(self):
        self.stub.fail = True
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self._request(
                "/v1/chat/completions",
                payload={"model": "auto", "messages": [{"role": "user", "content": "hi"}]},
                token=self.TOKEN,
            )
        self.assertEqual(ctx.exception.code, 502)
        ctx.exception.close()

        failures = [r for r in self._routing_records() if r["source"] == "proxy" and r["ok"] is False]
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["error"], "no lane could serve the request")
        self.assertTrue(failures[0]["attempts"])
        self.assertTrue(any("lane-a" in attempt for attempt in failures[0]["attempts"]))

    def test_success_event_carries_attempts_field(self):
        self._request(
            "/v1/chat/completions",
            payload={"model": "auto", "messages": [{"role": "user", "content": "hi"}]},
            token=self.TOKEN,
        )
        successes = [r for r in self._routing_records() if r["ok"] is True]
        self.assertEqual(len(successes), 1)
        self.assertIn("attempts", successes[0])
        self.assertEqual(successes[0]["attempts"], [])


if __name__ == "__main__":
    unittest.main()
