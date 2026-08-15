# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it through GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability**. That channel is private to the
maintainers until an advisory is published, and it lets a fix and a disclosure
ship together.

Please include, as far as you can establish them:

- the component (`xx-stack/mcp-server`, `hermes-orchestration`, `opencode-orchestration`, or the packs);
- what an attacker gets, not only what the code does;
- a reproduction — a tool call, an `inventory.json` fragment, or a config that triggers it;
- the commit or version you tested.

Expect an acknowledgement within a week. This is a small project; there is no
paid triage rotation and no bounty.

## Supported versions

The `main` branch is the only supported version. Fixes land there and ship in
the next release; there is no backport branch and no LTS line.

## What is in scope

The parts of this repository that carry real security weight, so a report
against them is worth filing:

- **Execution policy** (`mcp-server/src/execution_policy.ts`). The command allowlist/denylist and `guardedExecFile`. A way to run a command the policy should have blocked is in scope, including through argument quoting or shell metacharacters.
- **Credential handling.** Secrets reaching a log, a trace, an artifact on disk, or a tool response that travels back to a model. Redaction is applied to captured output and to URL userinfo; a bypass is in scope.
- **The MCP tool surface** (`mcp-server/src/*_tools.ts`). A tool that reads or writes outside its declared boundary, or whose declared safety annotations understate what it does.
- **Routing and lane selection.** Anything that causes work to leave the machine when it should not — most importantly, any path that selects a cloud lane while `policy.cloudEscalation.optIn` is `false`. Cloud escalation being opt-in is a security property here, not a preference.
- **Session and artifact storage.** Scratch directories, capture files, and log files are expected to be owner-only; a path that widens those permissions is in scope.
- **Supply chain.** A runtime dependency of `@xx-stack/mcp-server` with a known exploitable advisory. The package is not published to any registry and is run from a clone, so "shipped" here means "reached at runtime by anyone running this server", not "distributed by us".

## What is out of scope

- Anything reachable only after an operator deliberately relaxes their own configuration — enabling cloud escalation, widening the command allowlist, or pointing a lane at an untrusted endpoint. Those are documented switches, and flipping them is the operator's decision.
- The content packs (`packs/design/`, `packs/rules/`). They are prose and data consumed by a model. A prompt that produces bad output is a quality bug; file it as an issue.
- Vulnerabilities in a model or inference server this project routes to. Report those upstream to Ollama, vLLM, SGLang, or whoever operates the endpoint.
- Development-only dependencies. They are audited (see below) but they do not ship, so an advisory against one is a maintenance issue rather than a vulnerability in this project.

## Dependency posture

CI runs `npm audit --omit=dev --audit-level=high` on every push and pull
request, so a high or critical advisory against a **shipped** dependency breaks
the build. The runtime dependency surface is deliberately small — the MCP
server ships two direct dependencies, `@modelcontextprotocol/sdk` and `zod`.

Dev dependencies are updated by Dependabot but are **not** a build gate, for the
reason given under "out of scope". One known dev-only advisory is open: `eslint`
is pinned at `8.57.1`, which is end-of-life and pulls a `js-yaml` with two high
advisories. Clearing it means migrating to ESLint 9 flat config, which is
tracked as ordinary maintenance work rather than as a vulnerability.

## Threat model in one paragraph

xx-stack runs on hardware you own and routes work between machines on your own
network. The trust boundary is the network you control: lanes are assumed to be
your own machines, and cloud lanes are off unless you switch them on. The
project does **not** attempt to defend against a malicious model — an agent that
is given a tool can use that tool, which is what the execution policy exists to
bound. It does attempt to make sure that a tool cannot exceed its declared
bounds, that credentials do not leak into anything that travels, and that work
does not leave your network without an explicit opt-in.
