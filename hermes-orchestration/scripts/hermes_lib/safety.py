"""Executable-plan parsing and allowlisted command execution."""

from __future__ import annotations

import json
import shlex
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from .lanes import OrchestratorError


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
