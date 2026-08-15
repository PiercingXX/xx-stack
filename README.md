# xx-stack

**Let your local AI use every computer you own.**

Your coding agent runs on one machine and uses one model at a time. If you have
a gaming PC, an old workstation, a server in the closet — they sit idle.

xx-stack turns them into a private team. Your agent breaks work into pieces,
sends each piece to whichever of your machines is best suited, and gets the
results back.

All of it over your own network. Cloud APIs are **off** unless you switch them on.

---

## Try it in 2 minutes

You don't need a GPU, a second machine, or Tailscale for this part.

```bash
git clone https://github.com/piercingxx/xx-stack
cd xx-stack
npm install
npm --prefix xx-stack/mcp-server run build
```

Ask it where a task should run:

```bash
export XX_STACK_REPO="$PWD/xx-stack"

printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"route_task","arguments":{"description":"implement a small bug fix and run tests"}}}' \
  | node xx-stack/mcp-server/dist/index.js
```

It answers with a decision:

```json
{
  "recommendedTier": "local",
  "recommendedHost": "local-workstation-ollama",
  "reasoning": "Matched keywords for \"local\" tier; cloud tier excluded (cloud escalation requires opt-in)",
  "fallback": "tailscale-openai-compatible"
}
```

That's the core idea: **describe work, get a machine.** Notice it refused to
consider cloud without being asked.

---

## What you can actually do with it

### Use it from your editor

```json
{
  "mcpServers": {
    "xx-stack": { "command": "npx", "args": ["-y", "@xx-stack/mcp-server"] }
  }
}
```

Works with any MCP-compatible host — OpenCode, VS Code, or your own client.
Your agent gets 45 new tools for routing, health checks, and supervision, plus 2
optional lifecycle hooks behind `XX_STACK_HOOK_TOOLS=1`. Every tool declares
whether it only reads, whether it can destroy state, and whether it reaches the
network — so a host can auto-approve the safe ones instead of prompting on all
of them.

### Split a big job across your machines

Your agent calls `route_parallel_tasks` with a list of subtasks. Each one lands
on whichever machine fits — the GPU box gets the long-context reasoning, your
laptop gets the quick edits — and they run at the same time instead of one
after another.

### Ask several models and merge the answers

The `ensemble-consensus` skill sends **one** question to **at least three**
models at once, then combines what comes back:

```
## Answer
Use a queue, not a cron job.

## Confidence
majority (2/3)

## Where the models disagreed
- Retry strategy — agreed: gpu-box, laptop; dissented: workstation
  (argued for exponential backoff; it is right, and the merged answer uses it)

## Panel
- gpu-box / qwen3-coder-next
- workstation / llama3.3
- laptop / qwen2.5-coder
```

Disagreement between models is the useful part. One model spotting a bug the
others missed is worth more than three models agreeing. The skill reports splits
as splits rather than manufacturing false confidence.

**No other machines? It still works.** Three is the floor, because two models
only give you agreement or deadlock. If nothing can be delegated, it picks three
*different* models on your local machine — running them one after another if
they don't fit at once — and your local model distils the three answers into
one. Slower, but you still get a real second and third opinion.

Good for architecture calls, security review, and anything expensive to get
wrong. Not for routine edits — it costs at least 3x the compute.

### Keep long jobs from stalling silently

Supervision tools track long-running agent work, notice when it stops making
progress, and fail over to another machine instead of hanging.

---

## Adding your machines

One file describes everything you own: `inventory.json`.

```bash
cp inventory.example.json inventory.json
npm run inventory:sync
```

If your machines are on Tailscale, don't write them out by hand:

```bash
npm run inventory:scan              # see what it finds
npm run inventory:scan -- --write   # save it
npm run inventory:scan -- --write --ssh   # also read GPU specs
```

It checks every online machine for Ollama, sglang, vLLM, llama.cpp and LocalAI,
and records which models each one has.

**Everything it finds starts switched off.** A scan never sends work anywhere.
You turn machines on yourself:

```bash
npm run inventory:list                       # what you have, what's on
npm run inventory:enable  -- gpu-box         # whole machine
npm run inventory:enable  -- gpu-box.sglang  # one runtime
npm run inventory:sync                       # apply
```

Rescan any time. Your settings are kept, new machines get added, and a machine
that's powered off is never deleted.

<details>
<summary>What a machine looks like in the file</summary>

```jsonc
{
  "id": "gpu-box",
  "network": { "scope": "tailscale", "address": "gpu-box" },
  "hardware": { "gpu": [{ "name": "NVIDIA RTX 5090", "count": 8, "vramGb": 32 }] },
  "runtimes": [
    { "kind": "sglang", "port": 30000, "enabled": true  },
    { "kind": "ollama", "port": 11434, "enabled": false }
  ]
}
```

You describe the **machine** once. Each runtime on it becomes its own lane and
inherits the hardware. Supported kinds: `ollama`, `sglang`, `llama-cpp`, `vllm`,
`localai`.

This one file generates every config the stack needs, so there's nothing else to
keep in sync. `npm run inventory:check` (in CI) fails if they drift apart.
</details>

---

## About cloud

Cloud providers are listed but disabled. Routing will **not** pick one even if
every machine you own is unreachable — it fails instead, so a network problem
can never quietly turn into an API bill.

Turn it on deliberately when you want it:

```bash
export XX_STACK_ALLOW_CLOUD=1
# or set policy.cloudEscalation.optIn in inventory.json
```

---

## What you need

- **Node.js 20+**
- **An MCP-compatible host** — OpenCode, VS Code, or your own client
- **At least one model** — Ollama on your own machine is enough to start
- Python 3.11+ only if you use `hermes-orchestration/`

---

## The three folders

Most people only need the first one.

| Folder | What it is |
|---|---|
| **[`xx-stack/`](xx-stack/)** | The core: the MCP server, agent contracts, skills, a design pack with 151 design systems, and a rules pack of context-tiered rule books. |
| **[`opencode-orchestration/`](opencode-orchestration/)** | Installs the stack into OpenCode / VS Code. Only needed if you use those. |
| **[`hermes-orchestration/`](hermes-orchestration/)** | Standalone Python service for routing raw inference across GPU boxes. Optional. |

`xx-stack/` is the source of truth. The second folder symlinks into it for the
shared machinery — `mcp-server/`, `scripts/`, and `packs/` are one copy, not two
— but `opencode/agents/` and `opencode/skills/` are full copies, deliberately
specialised for OpenCode and kept structurally in step by
`npm run drift:check`. See [CONTRIBUTING.md](CONTRIBUTING.md) for how that works.

---

## Commands

| Command | What it does |
|---|---|
| `npm run verify` | Run everything: layout, tests, checks |
| `npm run inventory:scan` | Find machines on your Tailscale network |
| `npm run inventory:list` | Show machines and which are enabled |
| `npm run inventory:sync` | Apply inventory changes |
| `npm test` | MCP server tests (542) |
| `npm run design:systems-lint` | Check the 151 design systems parse and meet contrast |

---

## A note on the examples

Some files mention `gpu-rig`, an 8×RTX 5090 box. That's the author's
hardware, included as a worked example. **You don't need it** — nothing assumes
it exists, and the stack falls back to running everything locally.

---

## More

- [CHANGELOG.md](CHANGELOG.md) — what changed
- [CONTRIBUTING.md](CONTRIBUTING.md) — development setup
- [xx-stack/README.md](xx-stack/README.md) — deeper detail on the core

## License

[MIT](LICENSE) — the server, the routing and supervision engine, the gates, and
the agent contracts.

The two content packs are vendored third-party material and keep their own
licenses. The tooling built over them (the design-system lint gate, the HTML
quality gate, the rule engine) is ours and is MIT with everything else:

- **`xx-stack/packs/rules`** — MIT, from
  [ciembor/agent-rules-books](https://github.com/ciembor/agent-rules-books).
  License text at
  [`packs/rules/LICENSE`](xx-stack/packs/rules/LICENSE); provenance at
  [`packs/rules/manifest.json`](xx-stack/packs/rules/manifest.json).
- **`xx-stack/packs/design`** — Apache-2.0 and MIT, from three source projects.
  License texts at
  [`packs/design/licenses/`](xx-stack/packs/design/licenses) plus
  [`packs/design/workflow-skills/guizang-ppt/LICENSE`](xx-stack/packs/design/workflow-skills/guizang-ppt/LICENSE);
  per-subtree provenance, including what could not be established, at
  [`packs/design/manifest.json`](xx-stack/packs/design/manifest.json) and
  [`packs/design/README.md`](xx-stack/packs/design/README.md).
