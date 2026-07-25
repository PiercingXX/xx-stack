# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-07-24

First tagged release. The repository was reorganised into three top-level
components and the routing server was made publishable.

### Added

- **Single hardware inventory.** `inventory.json` is the one place you describe
  machines, how they are reached, and which inference runtimes they run. It
  generates the TypeScript platform registries and the Hermes lane config:
  `npm run inventory:sync`, with `npm run inventory:check` enforcing freshness
  in CI.
- **Tailscale auto-discovery.** `npm run inventory:scan` probes online peers for
  Ollama, sglang, vLLM, llama.cpp and LocalAI, records the models each serves,
  and with `--ssh` reads real GPU specs via `nvidia-smi`. Everything discovered
  is written **disabled**; `inventory:enable` / `inventory:disable` turn lanes on
  deliberately. Rescans are idempotent and never delete a machine that has gone
  quiet.
- **Hermes as a routing lane.** A `hermes-proxy` host, disabled by default, lets
  xx-stack delegate lane selection to the Hermes control plane through one
  OpenAI-compatible loopback endpoint.
- `npm run verify` — one gate covering layout, agent-mirror sync, stack-source
  drift, inventory freshness, and every test suite.
- `npm run drift:check` — catches structural divergence between the
  host-agnostic and OpenCode-specialised stack sources.
- Published package `@xx-stack/mcp-server`, self-contained and usable via `npx`.

### Changed

- Three top-level components: `xx-stack/` (core, source of truth),
  `opencode-orchestration/` (OpenCode install layer), `hermes-orchestration/`
  (Python control plane). The first two share one `mcp-server/`, `scripts/` and
  `packs/` by symlink rather than keeping duplicate copies.
- The shipped example registry now enables localhost Ollama by default, so a
  fresh clone with `ollama serve` running works with no edits.
- Design pack workflow skills moved to `packs/design/workflow-skills/`, removing
  a directory named after its consumer.
- Setup enriches the live registry at `~/.config/opencode/xx-stack-platforms.json`
  rather than mutating generated files.

### Fixed

- **`setup.sh` never completed.** It called four functions that have never
  existed in this repository and exited 127 partway through.
- **The MCP server exited silently when launched through a symlink.** Its
  direct-execution guard compared paths lexically, so `main()` never ran and the
  process exited 0 — indistinguishable from a crash to callers.
- **The registry was unreachable by its own server.** Lookup only searched
  `.opencode/`, so `xx-stack/runtime/platforms.json` was never found.
- Two competing host-discovery paths, one silently overwriting the other;
  824 lines of superseded shell removed.
- Invalid `endpointFamily: "catalog"` in the shipped registry.
- Cloud-escalation policy, self-hosted-first defaults, and a scrubbed private
  Tailscale IP restored after an accidental revert.
- `DESIGN-CATALOG.md` is deterministic; it embedded a timestamp that made every
  regeneration produce a diff.
- Node 20 compatibility for the test runner.

### Security

- Cloud routing is fail-safe: absent or `false` `cloudEscalation.optIn` disables
  cloud entirely, even when every self-hosted lane is unreachable.
- No private network addresses, tailnet names, or absolute home paths in the
  repository.

[0.1.0]: https://github.com/piercingxx/xx-stack/releases/tag/v0.1.0
