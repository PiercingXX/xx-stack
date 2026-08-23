"""Unit tests for hermes_orchestrator routing, safety, and proxy behavior.

Run with either:
    python3 -m unittest discover -s tests -v
    python3 -m pytest tests/ -v

Safety tests run against the **shipped** allowlist in `config/orchestration.json`,
not a hand-picked one: a hand-picked list is what hid HERMES-1.
"""

from __future__ import annotations

import argparse
import contextlib
import email.message
import http.client
import io
import json
import os
import re
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
        with self.server.counter_lock:
            self.server.get_count += 1
        if self.server.fail:
            self._send(500, {"error": "stub_down"})
            return
        if self.path.endswith("/models"):
            self._send(200, {"object": "list", "data": [{"id": m} for m in self.server.models]})
            return
        self._send(404, {"error": "not_found"})

    def do_POST(self):
        with self.server.counter_lock:
            self.server.post_count += 1
        if self.server.fail:
            self._send(500, {"error": "stub_down"})
            return
        if self.server.post_status != 200:
            self._send(self.server.post_status, {"error": f"http_{self.server.post_status}"})
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
        choice = {"index": 0, "message": message}
        # `finish_reason = None` on the server models a provider that omits the
        # field entirely, which is different from one that reports a failure.
        if self.server.finish_reason is not None:
            choice["finish_reason"] = self.server.finish_reason
        body = {
            "id": "chatcmpl-stub",
            "object": "chat.completion",
            "created": 0,
            "model": payload.get("model", "stub-model"),
            "choices": [choice],
        }
        if self.server.usage is not None:
            body["usage"] = self.server.usage
        self._send(200, body)


class StubLaneServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, models, reply="stub-reply", tool_support=False):
        super().__init__(("127.0.0.1", 0), StubLaneHandler)
        self.models = models
        self.reply = reply
        self.tool_support = tool_support
        self.finish_reason = "stop"
        self.usage = {"prompt_tokens": 5, "completion_tokens": 7, "total_tokens": 12}
        self.fail = False
        self.post_status = 200
        self.get_count = 0
        self.post_count = 0
        self.counter_lock = threading.Lock()
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

    def test_api_key_command_list_form_runs_without_shell(self):
        lane = ho.Lane(
            key="x",
            name="x",
            base_url="",
            model="m",
            enabled=True,
            api_key_command=["printf", "from-argv"],
        )
        self.assertEqual(ho.resolve_api_key(lane), "from-argv")

    def test_api_key_command_list_form_does_not_expand_metacharacters(self):
        # With shell=False the argument reaches the program verbatim; a shell
        # would have expanded "$HOME" into something else entirely.
        lane = ho.Lane(
            key="x",
            name="x",
            base_url="",
            model="m",
            enabled=True,
            api_key_command=["printf", "%s", "$HOME;`id`"],
        )
        self.assertEqual(ho.resolve_api_key(lane), "$HOME;`id`")

    def test_api_key_command_string_form_still_interpreted_by_shell(self):
        # Arithmetic expansion only happens under a shell: pins the documented
        # string form to its existing shell=True behavior.
        lane = ho.Lane(
            key="x",
            name="x",
            base_url="",
            model="m",
            enabled=True,
            api_key_command='echo "shell-$((6*7))"',
        )
        self.assertEqual(ho.resolve_api_key(lane), "shell-42")


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

    def test_call_chat_surfaces_finish_reason(self):
        cfg = self._cfg()
        lane = ho.lane_from_config(cfg, "a")
        _, _, meta = ho.call_chat(lane, 10, "sys", "user")
        self.assertEqual(meta["finish_reason"], "stop")

    def test_call_chat_reports_absent_finish_reason_as_none(self):
        self.stub_a.finish_reason = None
        cfg = self._cfg()
        lane = ho.lane_from_config(cfg, "a")
        _, _, meta = ho.call_chat(lane, 10, "sys", "user")
        self.assertIsNone(meta["finish_reason"])

    def test_probe_reuse_skips_second_probe(self):
        cfg = self._cfg(require_tool_call_for_subagents=True)
        first = ho.build_inventory_report(cfg, include_cloud=False, probe_tool_calls=True)
        second = ho.build_inventory_report(cfg, include_cloud=False, probe_tool_calls=True, previous=first)
        self.assertEqual(second["lanes"]["b"]["tool_probe_reason"], "reused_previous_probe")
        self.assertEqual(
            second["lanes"]["b"]["tool_call_supported"],
            first["lanes"]["b"]["tool_call_supported"],
        )


# A real repetition loop: a plausible opening sentence, then one clause emitted
# over and over. This is the dangerous shape — it reads fine in the first line,
# it emits a very large number of tokens very fast, and before the validity gate
# it scored as the FASTEST lane.
REPETITION_LOOP_REPLY = (
    "The operational notes describe a control plane that routes inference "
    "requests across self-hosted lanes before considering cloud escalation. "
    + "and is scored on health and priority and tool support " * 30
)

# Degenerate in the other direction: almost no distinct vocabulary at all.
SINGLE_TOKEN_LOOP_REPLY = "summary " * 80

# Control: an actual one-paragraph summary of the bench prompt.
HEALTHY_SUMMARY_REPLY = (
    "These notes describe an orchestration control plane whose defining rule is "
    "that inference requests go to self-hosted lanes first, and cloud escalation "
    "is considered only afterwards. Every lane presents an OpenAI-compatible API, "
    "which lets the router treat them uniformly, and each one is ranked using four "
    "inputs: current health, the models it can actually serve, an operator-assigned "
    "priority, and whether it supports tool calling. The scoring exists so that "
    "routing decisions stay explainable rather than arbitrary."
)


class BenchValidityGateTests(unittest.TestCase):
    """The gate that stops a repetition loop becoming a published speed result."""

    def test_healthy_summary_is_publishable(self):
        verdict = ho.evaluate_bench_sample(HEALTHY_SUMMARY_REPLY, "stop")
        self.assertTrue(verdict["publishable"], verdict)
        self.assertEqual(verdict["exclusion_reason"], "")
        self.assertLess(verdict["repeated_trigram_ratio"], 0.1)

    def test_repetition_loop_is_rejected(self):
        verdict = ho.evaluate_bench_sample(REPETITION_LOOP_REPLY, "stop")
        self.assertFalse(verdict["publishable"])
        self.assertEqual(verdict["exclusion_reason"], "degenerate_output")
        self.assertGreater(verdict["repeated_trigram_ratio"], ho.BENCH_MAX_REPEATED_TRIGRAM_RATIO)
        # It has plenty of distinct words, so the trigram rule is what catches it.
        self.assertGreaterEqual(verdict["distinct_word_tokens"], ho.BENCH_MIN_DISTINCT_TOKENS)

    def test_single_token_loop_is_rejected(self):
        verdict = ho.evaluate_bench_sample(SINGLE_TOKEN_LOOP_REPLY, "stop")
        self.assertFalse(verdict["publishable"])
        self.assertEqual(verdict["exclusion_reason"], "degenerate_output")

    def test_truncated_reply_is_excluded_not_counted(self):
        verdict = ho.evaluate_bench_sample(HEALTHY_SUMMARY_REPLY, "length")
        self.assertFalse(verdict["publishable"])
        self.assertEqual(verdict["exclusion_reason"], "truncated")

    def test_abnormal_finish_reason_is_excluded(self):
        verdict = ho.evaluate_bench_sample(HEALTHY_SUMMARY_REPLY, "content_filter")
        self.assertFalse(verdict["publishable"])
        self.assertEqual(verdict["exclusion_reason"], "abnormal_finish")

    def test_absent_finish_reason_is_marked_not_failed(self):
        verdict = ho.evaluate_bench_sample(HEALTHY_SUMMARY_REPLY, None)
        self.assertTrue(verdict["publishable"])
        self.assertFalse(verdict["finish_reason_reported"])

    def test_too_short_reply_cannot_certify_non_degeneracy(self):
        verdict = ho.evaluate_bench_sample("Routes requests.", "stop")
        self.assertFalse(verdict["publishable"])
        self.assertEqual(verdict["exclusion_reason"], "too_short")

    def test_repeated_ngram_ratio_is_zero_for_unique_text(self):
        tokens = ho.bench_word_tokens("alpha beta gamma delta epsilon zeta eta theta")
        self.assertEqual(ho.repeated_ngram_ratio(tokens, 3), 0.0)


class BenchRunMixin(TempDirMixin):
    """Runs the real `bench` command against a loopback stub lane."""

    def setUp(self):
        self.tmpdir = self.make_tempdir()
        self.stub = StubLaneServer(["model-a"], reply=HEALTHY_SUMMARY_REPLY)
        self.addCleanup(self.stub.stop)

    def _cfg(self):
        return make_cfg(
            self.tmpdir,
            {"a": lane_cfg("lane-a", self.stub.base_url, "model-a", priority=100)},
        )

    def _args(self, **over):
        params = {
            "lane": "a",
            "parallel": 1,
            "iterations": 2,
            "warmup": 0,
            "context_tokens": 100,
            "max_tokens": 64,
            "profile": "synthesis-long",
            "output": str(Path(self.tmpdir) / "bench"),
        }
        params.update(over)
        return argparse.Namespace(**params)

    def _run(self, **over):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            rc = ho.command_bench(self._args(**over), self._cfg())
        self.assertEqual(rc, 0)
        written = sorted((Path(self.tmpdir) / "bench").glob("*.json"))
        self.assertEqual(len(written), 1, written)
        return json.loads(written[0].read_text(encoding="utf-8")), stderr.getvalue()


class BenchCommandTests(BenchRunMixin):
    """Drive the gate through the registered `bench` command, not just helpers."""

    def test_healthy_run_is_publishable_and_measured(self):
        result, _ = self._run()
        self.assertTrue(result["publishable"], result["publish_blockers"])
        self.assertEqual(result["publish_blockers"], [])
        self.assertEqual(result["samples_excluded"], 0)
        self.assertEqual(result["samples_publishable"], 2)
        self.assertGreater(result["tokens_per_sec"], 0)
        self.assertIsNone(result["tokens_per_sec_estimated"])
        self.assertFalse(result["tokens_estimated"])

    def test_repetition_loop_never_becomes_a_published_speed_result(self):
        self.stub.reply = REPETITION_LOOP_REPLY
        result, stderr = self._run()
        self.assertFalse(result["publishable"])
        self.assertIn("excluded_samples_present", result["publish_blockers"])
        self.assertEqual(result["samples_excluded"], 2)
        self.assertEqual(result["samples_publishable"], 0)
        self.assertIsNone(result["tokens_per_sec"])
        self.assertEqual(result["exclusions_by_reason"], {"degenerate_output": 2})
        # Visibly excluded, not silently dropped: every sample is listed.
        self.assertEqual(len(result["excluded_samples"]), 2)
        self.assertIn("degenerate_output", stderr)
        self.assertIn("NOT PUBLISHABLE", stderr)

    def test_truncated_replies_are_excluded_from_throughput(self):
        self.stub.finish_reason = "length"
        result, _ = self._run()
        self.assertFalse(result["publishable"])
        self.assertEqual(result["exclusions_by_reason"], {"truncated": 2})
        self.assertIsNone(result["tokens_per_sec"])

    def test_estimates_never_land_in_the_measured_field(self):
        self.stub.usage = None  # provider reports no usage block
        result, _ = self._run()
        self.assertIsNone(result["tokens_per_sec"])
        self.assertEqual(result["completion_tokens_measured"], 0)
        self.assertGreater(result["tokens_per_sec_estimated"], 0)
        self.assertGreater(result["completion_tokens_estimated"], 0)
        self.assertTrue(result["tokens_estimated"])
        self.assertIn("no_provider_reported_token_counts", result["publish_blockers"])

    def test_absent_finish_reason_is_counted_not_silently_trusted(self):
        self.stub.finish_reason = None
        result, _ = self._run()
        self.assertEqual(result["finish_reason_unreported_samples"], 2)
        self.assertEqual(result["samples_excluded"], 0)

    def test_warmup_requests_are_excluded_from_timing_and_samples(self):
        result, stderr = self._run(warmup=1, iterations=2)
        self.assertEqual(self.stub.post_count, 3)  # 1 warmup + 2 timed
        self.assertEqual(result["samples_total"], 2)
        self.assertEqual(result["warmup_iterations"], 1)
        self.assertGreater(result["warmup_seconds"], 0)
        self.assertIn("warmup", stderr)

    def test_bench_reports_the_thresholds_it_applied(self):
        result, _ = self._run()
        self.assertEqual(
            result["validity_gate"],
            {
                "min_reply_tokens": ho.BENCH_MIN_REPLY_TOKENS,
                "min_distinct_tokens": ho.BENCH_MIN_DISTINCT_TOKENS,
                "max_repeated_trigram_ratio": ho.BENCH_MAX_REPEATED_TRIGRAM_RATIO,
            },
        )

    def test_bench_emits_no_empty_string_lane_classification(self):
        result, _ = self._run()
        self.assertIsNone(result["lane_classification"])
        self.assertIsNone(result["gpu_residency_pass"])
        self.assertTrue(result["lane_classification_reason"])
        self.assertEqual(result["gpu_residency_method"], "not_measured_by_bench")


class QualificationMatrixDocTests(BenchRunMixin):
    """D4: the matrix doc is a claim about inventory.json and about the bench.

    Same staleness class as the CONTENT-4/5/12 defects: hardcoded facts in prose
    rot silently. These check the claims against the source of truth and against
    a real bench record, so drift fails a gate instead of misleading a reader.
    """

    DOC_PATH = HERMES_DIR / "model-qualification-matrix.md"
    INVENTORY_PATH = HERMES_DIR.parent / "inventory.json"
    EXAMPLE_INVENTORY_PATH = HERMES_DIR.parent / "inventory.example.json"

    @classmethod
    def setUpClass(cls):
        cls.doc = cls.DOC_PATH.read_text(encoding="utf-8")
        # inventory.json holds private machine truth and is git-ignored, so a
        # fresh clone does not have it. Until it exists, the shipped template
        # answers — the same fallback contract as generate-registries.mjs and
        # toggle-lane.mjs.
        try:
            cls.inventory = json.loads(cls.INVENTORY_PATH.read_text(encoding="utf-8"))
        except FileNotFoundError:
            cls.inventory = json.loads(cls.EXAMPLE_INVENTORY_PATH.read_text(encoding="utf-8"))

    def test_doc_names_every_lane_backed_inventory_host(self):
        """Every inventory host the shipped config dials must be documented.

        inventory.json is private and may declare machines the shipped tree
        knows nothing about (they only get lanes once `npm run inventory:sync`
        regenerates config from them), and the doc claims nothing about those.
        But any host a shipped lane actually targets is a host this matrix
        describes, so it must be named here.
        """
        lane_texts = [
            f"{lane.get('name', '')} {lane.get('base_url', '')}"
            for lane in SHIPPED_CFG["lanes"].values()
        ]
        for machine in self.inventory["machines"]:
            machine_id = machine["id"]
            if not any(machine_id in text for text in lane_texts):
                continue
            with self.subTest(machine=machine_id):
                self.assertIn(machine_id, self.doc)

    def test_no_phantom_host_is_presented_as_current(self):
        """Retired hosts may appear under Historical record, nowhere above it."""
        marker = "## Historical record"
        self.assertIn(marker, self.doc)
        current = self.doc[: self.doc.index(marker)]
        # Named as current lanes in the pre-fix doc; in no source of truth.
        for phantom in ("Debian dual 4080", "Arch dual 5090", "test-bench-archlinux", "server-debian-ai"):
            with self.subTest(phantom=phantom):
                self.assertNotIn(phantom, current)

    def test_doc_names_every_shipped_lane(self):
        for key, lane in SHIPPED_CFG["lanes"].items():
            with self.subTest(lane=key):
                self.assertIn(f"`{key}`", self.doc)
                self.assertIn(lane["name"], self.doc)

    def test_doc_points_at_the_shipped_bench_output_path(self):
        default_output = ho.build_parser().parse_args(["bench"]).output
        self.assertIn(f"hermes-orchestration/{default_output}/", self.doc)
        # The pre-fix doc pointed evidence at a path that exists nowhere.
        self.assertNotIn(
            "Evidence artifacts\n- ~/Documents/opencode-orchestration", self.doc
        )

    def _required_schema_fields(self):
        start = self.doc.index("### Required — produced by `hermes bench`")
        end = self.doc.index("### Operator-supplied", start)
        fields = []
        for line in self.doc[start:end].splitlines():
            if not line.startswith("|") or set(line) <= set("|- "):
                continue
            first_cell = line.split("|")[1]
            fields.extend(re.findall(r"`([a-z_0-9]+)`", first_cell))
        return fields

    def test_every_required_schema_field_is_actually_emitted(self):
        """The defect: the schema demanded fields no run could produce."""
        result, _ = self._run()
        required = self._required_schema_fields()
        self.assertGreaterEqual(len(required), 12, required)
        for field in required:
            with self.subTest(field=field):
                self.assertIn(field, result)

    def test_unproducible_fields_are_documented_as_operator_supplied(self):
        result, _ = self._run()
        operator_section = self.doc[self.doc.index("### Operator-supplied") :]
        for field in ("gpu_residency_pass", "lane_classification"):
            with self.subTest(field=field):
                self.assertNotIn(field, self._required_schema_fields())
                self.assertIn(f"`{field}`", operator_section)
                # Still emitted, as an explicit null rather than a fake value.
                self.assertIn(field, result)
                self.assertIsNone(result[field])

    def test_unset_thresholds_are_explained_not_left_bare(self):
        bare = [
            line
            for line in self.doc.splitlines()
            if line.strip().endswith("TBD") and "see above" not in line
        ]
        self.assertEqual(bare, [], f"bare TBD placeholders remain: {bare}")
        self.assertIn("The measurement that sets them", self.doc)


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


class AtomicSaveJsonTests(TempDirMixin):
    """The capability cache is read on the hot path while refreshes rewrite it.

    save_json must keep every reader on either the previous file or the
    complete new one — never a half-written file.
    """

    def setUp(self):
        self.dir = Path(self.make_tempdir())
        self.cache_path = self.dir / "capability-cache.json"

    def test_reader_during_write_sees_previous_content_until_replace(self):
        old, new = {"generation": 1}, {"generation": 2}
        ho.save_json(self.cache_path, old)

        computed = threading.Event()
        release = threading.Event()
        real_dumps = json.dumps

        def slow_dumps(obj, **kwargs):
            payload = real_dumps(obj, **kwargs)
            computed.set()
            release.wait(timeout=5)
            return payload

        json.dumps = slow_dumps
        self.addCleanup(setattr, json, "dumps", real_dumps)

        writer = threading.Thread(target=ho.save_json, args=(self.cache_path, new))
        writer.start()
        try:
            self.assertTrue(computed.wait(timeout=5), "writer never serialized its payload")
            # The writer holds a complete payload but has not touched the cache
            # path yet: the mid-write read must see the old file intact.
            self.assertEqual(json.loads(self.cache_path.read_text(encoding="utf-8")), old)
        finally:
            release.set()
            writer.join(timeout=5)
        self.assertFalse(writer.is_alive())
        self.assertEqual(json.loads(self.cache_path.read_text(encoding="utf-8")), new)

    def test_failed_replace_leaves_original_and_no_temp_files(self):
        original = {"old": True}
        ho.save_json(self.cache_path, original)

        def broken_replace(src, dst):
            raise OSError("replace failed")

        original_replace = os.replace
        os.replace = broken_replace
        self.addCleanup(setattr, os, "replace", original_replace)

        with self.assertRaises(OSError):
            ho.save_json(self.cache_path, {"new": True})

        self.assertEqual(json.loads(self.cache_path.read_text(encoding="utf-8")), original)
        leftovers = [p.name for p in self.dir.iterdir() if p.name != self.cache_path.name]
        self.assertEqual(leftovers, [], "failed write left temp files behind")


class LaneHealthCacheTests(TempDirMixin):
    """Proxy hot path: health outcomes are reused within the TTL."""

    def setUp(self):
        self.tmpdir = self.make_tempdir()
        self.stub = StubLaneServer(["model-a"], reply="r")
        self.addCleanup(self.stub.stop)
        self.cfg = make_cfg(
            self.tmpdir,
            {"a": lane_cfg("lane-a", self.stub.base_url, "model-a", priority=100)},
        )
        self.lane = ho.lane_from_config(self.cfg, "a")

    def test_second_call_within_ttl_skips_probe(self):
        cache = ho.LaneHealthCache(ttl_seconds=300)
        self.assertTrue(cache.get(self.cfg, self.lane)[0])
        self.assertTrue(cache.get(self.cfg, self.lane)[0])
        self.assertEqual(self.stub.get_count, 1)

    def test_expired_entry_is_reprobed(self):
        cache = ho.LaneHealthCache(ttl_seconds=300)
        cache.get(self.cfg, self.lane)
        timestamp, outcome = cache._entries["a"]
        # Backdate past the TTL instead of sleeping; deterministic.
        cache._entries["a"] = (timestamp - 301, outcome)
        cache.get(self.cfg, self.lane)
        self.assertEqual(self.stub.get_count, 2)

    def test_nonpositive_ttl_disables_memoization(self):
        cache = ho.LaneHealthCache(ttl_seconds=0)
        cache.get(self.cfg, self.lane)
        cache.get(self.cfg, self.lane)
        self.assertEqual(self.stub.get_count, 2)

    def test_proxy_reads_ttl_from_config_with_default(self):
        proxy = ho.ProxyServer(("127.0.0.1", 0), ho.ProxyHandler, self.cfg, None, False)
        self.addCleanup(proxy.server_close)
        self.assertEqual(proxy.health_cache.ttl_seconds, ho.LANE_HEALTH_TTL_SECONDS)

        self.cfg["proxy"] = {"health_check_ttl_seconds": 120}
        tuned = ho.ProxyServer(("127.0.0.1", 0), ho.ProxyHandler, self.cfg, None, False)
        self.addCleanup(tuned.server_close)
        self.assertEqual(tuned.health_cache.ttl_seconds, 120)


class SubagentEscalationTelemetryTests(TempDirMixin):
    """cloud-escalation-policy.md requires decomposition_attempted as REAL
    telemetry: whether the delegation actually went out as multiple subtasks."""

    def _cfg(self, tmpdir):
        down_a = StubLaneServer(["model-a"], reply="x")
        down_a.fail = True
        down_b = StubLaneServer(["model-b"], reply="x")
        down_b.fail = True
        self.addCleanup(down_a.stop)
        self.addCleanup(down_b.stop)
        # No routing presets are configured: the empty default preset keeps
        # resolve_subagent_request from raising on the missing "general" entry.
        return make_cfg(
            tmpdir,
            {
                "a": lane_cfg("lane-a", down_a.base_url, "model-a", priority=100),
                "b": lane_cfg("lane-b", down_b.base_url, "model-b", priority=70),
                "cloud": lane_cfg(
                    "cloud-lane",
                    "cli://none",
                    "gpt-5.3-codex",
                    role="cloud",
                    priority=50,
                    endpoint_type="hermes_cli",
                    provider="github-copilot",
                    catalog_models=["gpt-5.3-codex"],
                ),
            },
            default_subagent_preset="",
        )

    def _escalation_events(self, task):
        tmpdir = self.make_tempdir()
        log_path = Path(tmpdir) / "cloud-escalations.jsonl"
        args = ho.build_parser().parse_args([
            "subagents",
            "--task", task,
            "--allow-cloud",
            "--task-profile", "hardware-constrained",
            "--escalation-log", str(log_path),
        ])
        original = ho.run_hermes_cli_oneshot
        ho.run_hermes_cli_oneshot = lambda lane, timeout, model, prompt: (True, f"cli-reply:{model}")
        self.addCleanup(setattr, ho, "run_hermes_cli_oneshot", original)

        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            rc = ho.command_subagents(args, self._cfg(tmpdir))
        self.assertEqual(rc, 0)
        self.assertTrue(log_path.exists(), "expected a cloud escalation event")
        return [
            json.loads(line)
            for line in log_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def test_unsplitted_task_reports_decomposition_not_attempted(self):
        events = self._escalation_events("Single undivided task")
        self.assertEqual(len(events), 1)
        self.assertFalse(events[0]["decomposition_attempted"])
        self.assertEqual(events[0]["selected_model"], "gpt-5.3-codex")

    def test_explicit_slices_report_decomposition_attempted(self):
        events = self._escalation_events("Slice one||Slice two")
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0]["decomposition_attempted"])


class ProxyFallbackModelTests(TempDirMixin):
    """Upstream auth/path failures are lane problems: they must end the lane's
    model loop instead of retrying identical credentials per fallback model."""

    def setUp(self):
        self.tmpdir = self.make_tempdir()

    def _serve(self, lanes):
        run_dir = Path(self.make_tempdir())
        cfg = make_cfg(str(run_dir), lanes)
        cfg["policy"]["primary_lane_order"] = list(lanes)
        proxy = ho.ProxyServer(("127.0.0.1", 0), ho.ProxyHandler, cfg, None, False)
        thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        thread.start()

        def stop():
            proxy.shutdown()
            proxy.server_close()
            thread.join(timeout=5)

        base_url = f"http://127.0.0.1:{proxy.server_address[1]}"
        routing_log = Path(cfg["execution"]["routing_log_file"])
        return stop, base_url, routing_log

    def _chat(self, base_url):
        payload = {"model": "auto", "messages": [{"role": "user", "content": "hi"}]}
        req = urllib.request.Request(
            base_url + "/v1/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.getcode(), json.loads(resp.read().decode("utf-8"))

    def _records(self, routing_log):
        if not routing_log.exists():
            return []
        return [
            json.loads(line)
            for line in routing_log.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def test_auth_failure_breaks_to_next_lane_without_retrying_models(self):
        down = StubLaneServer(["model-a"], reply="nope")
        down.post_status = 401
        good = StubLaneServer(["model-b"], reply="good-reply")
        self.addCleanup(down.stop)
        self.addCleanup(good.stop)
        stop, base_url, routing_log = self._serve({
            "a": lane_cfg(
                "lane-a", down.base_url, "model-a", priority=100, fallback_models=["model-a2"]
            ),
            "b": lane_cfg("lane-b", good.base_url, "model-b", priority=70),
        })
        self.addCleanup(stop)

        code, body = self._chat(base_url)
        self.assertEqual(code, 200)
        self.assertEqual(body["choices"][0]["message"]["content"], "good-reply")
        # Two configured candidates, one upstream attempt: the 401 ended lane a.
        self.assertEqual(down.post_count, 1)
        successes = [r for r in self._records(routing_log) if r["ok"]]
        self.assertEqual(successes[0]["attempts"], ["lane-a:model-a:http_401"])

    def test_server_errors_still_exhaust_fallback_models(self):
        down = StubLaneServer(["model-a"], reply="nope")
        down.post_status = 500
        good = StubLaneServer(["model-b"], reply="good-reply")
        self.addCleanup(down.stop)
        self.addCleanup(good.stop)
        stop, base_url, routing_log = self._serve({
            "a": lane_cfg(
                "lane-a", down.base_url, "model-a", priority=100, fallback_models=["model-a2"]
            ),
            "b": lane_cfg("lane-b", good.base_url, "model-b", priority=70),
        })
        self.addCleanup(stop)

        code, body = self._chat(base_url)
        self.assertEqual(code, 200)
        self.assertEqual(body["choices"][0]["message"]["content"], "good-reply")
        # A 500 is not necessarily model-independent, so both candidates run.
        self.assertEqual(down.post_count, 2)
        successes = [r for r in self._records(routing_log) if r["ok"]]
        self.assertEqual(
            successes[0]["attempts"],
            ["lane-a:model-a:http_500", "lane-a:model-a2:http_500"],
        )

    def test_forbidden_and_missing_path_also_break_to_next_lane(self):
        for status in (403, 404):
            with self.subTest(status=status):
                down = StubLaneServer(["model-a"], reply="nope")
                down.post_status = status
                good = StubLaneServer(["model-b"], reply="good-reply")
                self.addCleanup(down.stop)
                self.addCleanup(good.stop)
                stop, base_url, _ = self._serve({
                    "a": lane_cfg(
                        "lane-a", down.base_url, "model-a", priority=100,
                        fallback_models=["model-a2"],
                    ),
                    "b": lane_cfg("lane-b", good.base_url, "model-b", priority=70),
                })
                try:
                    code, body = self._chat(base_url)
                    self.assertEqual(code, 200)
                    self.assertEqual(body["choices"][0]["message"]["content"], "good-reply")
                    self.assertEqual(down.post_count, 1)
                finally:
                    stop()


if __name__ == "__main__":
    unittest.main()
