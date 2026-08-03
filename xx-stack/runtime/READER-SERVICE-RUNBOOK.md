# Reader Service Runbook

## Decision

An optional, self-hosted reader service (URL → LLM-friendly markdown) that the
`research-deep` skill's **visit** action prefers when one is declared and
enabled in `inventory.json`. It is strictly optional and off by default:
absence degrades to plain fetch, and it **never** escalates to a cloud reader
endpoint. The MCP server never talks to the reader — agents do.

## What it is

The Apache-2.0 OSS build of Jina's reader (`ghcr.io/jina-ai/reader:oss`): a
stateless HTTP service. Prefix any URL with the service's own URL and it
returns clean markdown:

```
curl http://127.0.0.1:3000/https://example.com/some/page
```

Runs entirely on your own hardware — no API key, no external calls beyond
fetching the page you asked for.

## Run it (docker compose)

```yaml
services:
  reader:
    image: ghcr.io/jina-ai/reader:oss
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"
```

Bind to `127.0.0.1` (or the tailnet interface on a remote machine) — do not
expose it publicly; it is an open proxy to whatever URL it is given.

## Declare it in the inventory

Add a `services` entry to the machine that runs it (see
`inventory.example.json` for the template):

```json
"services": [
  {
    "id": "reader",
    "kind": "reader",
    "port": 3000,
    "enabled": true,
    "notes": "Self-hosted reader for research-deep's visit action."
  }
]
```

Then `npm run inventory:sync`. Services are agent-discovered metadata: they do
not become lanes and do not propagate into the generated registries.

## Preference order

When `research-deep` visits a URL:

1. **Local reader** — an enabled `kind: "reader"` service in the inventory,
   reached at `http://<machine address>:<port>/<url>`.
2. **Plain fetch** — when no reader is declared, it is disabled, or it is
   unreachable.

There is no step 3. A missing or broken reader degrades to plain fetch; it is
never a reason to call a cloud reader API.
