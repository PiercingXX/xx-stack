import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  buildMemoryCompactionPrompt,
  computeMemoryEntryId,
  getAgentMemoryEntrypoint,
  markMemoryEntriesSuperseded,
  parseMemoryEntries,
  selectMemoryForBudget,
} from "./memory_runtime.js";
import { registerAgentMemoryTools } from "./agent_memory_tools.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PREAMBLE = "# Agent Memory\n\n";
const ENTRY_ROUTING = "- 2026-01-01T00:00:00.000Z routing lane selection prefers low latency hosts";
const ENTRY_MEMORY = "- 2026-01-02T00:00:00.000Z memory snapshots detect drift between files";
const ENTRY_INVENTORY =
  "- 2026-01-03T00:00:00.000Z inventory json is the single source of truth for machines";
const ENTRY_VERIFY =
  "- 2026-01-04T00:00:00.000Z verify edit returns structured lint and test failures";

const FIXTURE_CONTENT = [
  PREAMBLE.trimEnd(),
  "",
  ENTRY_ROUTING,
  ENTRY_MEMORY,
  ENTRY_INVENTORY,
  ENTRY_VERIFY,
  "",
].join("\n");

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("parseMemoryEntries splits preamble and bullet entries", () => {
  const doc = parseMemoryEntries(FIXTURE_CONTENT);
  assert.equal(doc.preamble, "# Agent Memory\n");
  assert.equal(doc.entries.length, 4);
  assert.equal(doc.entries[0].text, ENTRY_ROUTING);
  assert.equal(doc.entries[3].text, ENTRY_VERIFY);
  assert.ok(doc.entries.every((e) => !e.superseded));
});

test("entry ids are stable across superseded marking", () => {
  const idBefore = computeMemoryEntryId(ENTRY_ROUTING);
  const marked = `- [superseded:abc123] ${ENTRY_ROUTING.slice(2)}`;
  assert.equal(computeMemoryEntryId(marked), idBefore);

  const doc = parseMemoryEntries(`${PREAMBLE}${marked}\n`);
  assert.equal(doc.entries[0].id, idBefore);
  assert.equal(doc.entries[0].superseded, true);
  assert.equal(doc.entries[0].supersededBy, "abc123");
});

// ---------------------------------------------------------------------------
// Token-budgeted recall
// ---------------------------------------------------------------------------

test("selectMemoryForBudget fits the budget with stable original order", () => {
  const recall = selectMemoryForBudget(FIXTURE_CONTENT, 50);

  assert.ok(recall.tokensEstimated <= 50, `tokensEstimated ${recall.tokensEstimated} > 50`);
  assert.ok(recall.entriesSelected >= 1, "should select at least one entry");
  assert.ok(recall.entriesSelected < 4, "50 tokens cannot hold all four entries");
  assert.equal(recall.truncated, true);
  assert.equal(recall.entriesTotal, 4);

  // Stable order: selected entries appear in the same relative order as the file.
  const allEntries = [ENTRY_ROUTING, ENTRY_MEMORY, ENTRY_INVENTORY, ENTRY_VERIFY];
  const positions = allEntries.map((e) => recall.content.indexOf(e)).filter((idx) => idx >= 0);
  assert.equal(positions.length, recall.entriesSelected);
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i] > positions[i - 1], "selected entries must keep original order");
  }
  assert.ok(recall.content.startsWith("# Agent Memory\n\n"), "preamble is preserved");
});

test("selectMemoryForBudget with an ample budget keeps all distinct entries", () => {
  const recall = selectMemoryForBudget(FIXTURE_CONTENT, 10000);
  assert.equal(recall.entriesSelected, 4);
  assert.equal(recall.truncated, false);
  for (const entry of [ENTRY_ROUTING, ENTRY_MEMORY, ENTRY_INVENTORY, ENTRY_VERIFY]) {
    assert.ok(recall.content.includes(entry), `missing entry: ${entry}`);
  }
});

test("selectMemoryForBudget favors query-relevant entries", () => {
  // Budget for roughly one entry; the query should decide which one.
  const recall = selectMemoryForBudget(FIXTURE_CONTENT, 30, "verify edit lint test failures");
  assert.ok(recall.entriesSelected >= 1);
  assert.ok(recall.content.includes(ENTRY_VERIFY), "the query-matching entry should make the cut");
});

test("selectMemoryForBudget is deterministic", () => {
  const a = selectMemoryForBudget(FIXTURE_CONTENT, 50, "routing");
  const b = selectMemoryForBudget(FIXTURE_CONTENT, 50, "routing");
  assert.deepEqual(a, b);
});

test("budgeted recall excludes superseded entries unless includeSuperseded", () => {
  const marked = markMemoryEntriesSuperseded(
    FIXTURE_CONTENT,
    [computeMemoryEntryId(ENTRY_ROUTING)],
    "rulepack-1"
  );

  const recall = selectMemoryForBudget(marked.content, 10000);
  assert.equal(recall.entriesSuperseded, 1);
  assert.ok(
    !recall.content.includes("routing lane selection"),
    "superseded entry must not appear in default budgeted recall"
  );

  const withSuperseded = selectMemoryForBudget(marked.content, 10000, undefined, true);
  assert.ok(
    withSuperseded.content.includes("routing lane selection"),
    "includeSuperseded must recover superseded entries"
  );
});

// ---------------------------------------------------------------------------
// Compaction prompt
// ---------------------------------------------------------------------------

test("buildMemoryCompactionPrompt is deterministic for fixed entries", () => {
  const first = buildMemoryCompactionPrompt("skippy", FIXTURE_CONTENT);
  const second = buildMemoryCompactionPrompt("skippy", FIXTURE_CONTENT);
  assert.deepEqual(first, second);
  assert.equal(first.candidates.length, 4);
  assert.equal(first.entriesEligible, 4);

  // The prompt carries the contract: append rules, mark superseded, never delete.
  assert.ok(first.prompt.includes("agent_memory_append"));
  assert.ok(first.prompt.includes("agent_memory_mark_superseded"));
  assert.ok(first.prompt.includes("Never delete entries"));
  assert.ok(first.prompt.includes(first.compactionId));
  for (const candidate of first.candidates) {
    assert.ok(first.prompt.includes(`${candidate.id}: ${candidate.text}`));
  }
});

test("buildMemoryCompactionPrompt honors maxEntries and skips superseded entries", () => {
  const marked = markMemoryEntriesSuperseded(
    FIXTURE_CONTENT,
    [computeMemoryEntryId(ENTRY_VERIFY)],
    "rulepack-1"
  );
  const result = buildMemoryCompactionPrompt("skippy", marked.content, 2);
  assert.equal(result.entriesTotal, 4);
  assert.equal(result.entriesEligible, 3);
  assert.equal(result.candidates.length, 2);
  assert.ok(
    result.candidates.every((c) => !c.text.includes("verify edit")),
    "superseded entries must not be compaction candidates"
  );
});

// ---------------------------------------------------------------------------
// Superseded marking: in place, recoverable
// ---------------------------------------------------------------------------

test("markMemoryEntriesSuperseded annotates in place and keeps entries recoverable", () => {
  const targetId = computeMemoryEntryId(ENTRY_MEMORY);
  const result = markMemoryEntriesSuperseded(FIXTURE_CONTENT, [targetId, "no-such-id"], "rule-9");

  assert.deepEqual(result.marked, [targetId]);
  assert.deepEqual(result.missing, ["no-such-id"]);
  assert.deepEqual(result.alreadySuperseded, []);

  // Original observation text is still present — recoverable, never deleted.
  assert.ok(result.content.includes(ENTRY_MEMORY.slice(2)));
  assert.ok(result.content.includes(`- [superseded:rule-9] ${ENTRY_MEMORY.slice(2)}`));

  // Every other line is byte-identical.
  const before = FIXTURE_CONTENT.split("\n");
  const after = result.content.split("\n");
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i += 1) {
    if (before[i] === ENTRY_MEMORY) continue;
    assert.equal(after[i], before[i], `line ${i} must be untouched`);
  }

  // Marking again reports alreadySuperseded rather than double-marking.
  const again = markMemoryEntriesSuperseded(result.content, [targetId], "rule-10");
  assert.deepEqual(again.marked, []);
  assert.deepEqual(again.alreadySuperseded, [targetId]);
  assert.equal(again.content, result.content);
});

// ---------------------------------------------------------------------------
// Registered tools: default path unchanged, budgeted recall, compaction loop
// ---------------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function captureMemoryTools(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const fakeServer = {
    tool: (...toolArgs: unknown[]) => {
      handlers.set(toolArgs[0] as string, toolArgs[toolArgs.length - 1] as ToolHandler);
    },
  } as unknown as McpServer;
  registerAgentMemoryTools(fakeServer);
  return handlers;
}

async function callTool(
  handlers: Map<string, ToolHandler>,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, any>> {
  const handler = handlers.get(name);
  assert.ok(handler, `tool ${name} should be registered`);
  const result = await handler!(args);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text) as Record<string, any>;
}

test("agent_memory_get without tokenBudget is byte-identical to the legacy payload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-memory-tools-"));
  try {
    const handlers = captureMemoryTools();
    const agentId = "test-agent";

    await callTool(handlers, "agent_memory_append", {
      agentId,
      scope: "project",
      cwd: dir,
      note: "routing lane selection prefers low latency hosts",
    });

    const handler = handlers.get("agent_memory_get");
    const raw = await handler!({ agentId, scope: "project", cwd: dir });
    const path = getAgentMemoryEntrypoint(agentId, "project", dir);
    const payload = JSON.parse(raw.content[0].text);

    // Exact legacy shape: no recall metadata, no extra keys, full content.
    const expected = {
      status: "ok",
      agentId,
      scope: "project",
      path,
      content: payload.content,
    };
    assert.equal(raw.content[0].text, JSON.stringify(expected, null, 2));
    assert.ok(payload.content.includes("routing lane selection prefers low latency hosts"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent_memory_get with tokenBudget fits recall to the budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-memory-tools-"));
  try {
    const handlers = captureMemoryTools();
    const agentId = "test-agent";
    const notes = [
      "routing lane selection prefers low latency hosts",
      "memory snapshots detect drift between entrypoint and snapshot files",
      "inventory json is the single source of truth for machines",
      "verify edit returns structured lint and test failures for continuation",
    ];
    for (const note of notes) {
      await callTool(handlers, "agent_memory_append", {
        agentId,
        scope: "project",
        cwd: dir,
        note,
      });
    }

    const payload = await callTool(handlers, "agent_memory_get", {
      agentId,
      scope: "project",
      cwd: dir,
      tokenBudget: 60,
    });

    assert.equal(payload.status, "ok");
    assert.ok(payload.recall, "budgeted path must include recall metadata");
    assert.equal(payload.recall.tokenBudget, 60);
    assert.ok(
      payload.recall.tokensEstimated <= 60,
      `tokensEstimated ${payload.recall.tokensEstimated} > 60`
    );
    assert.equal(payload.recall.entriesTotal, 4);
    assert.ok(payload.recall.entriesSelected >= 1);
    assert.ok(payload.recall.entriesSelected < 4, "60 tokens cannot hold all four entries");
    assert.equal(payload.recall.truncated, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compaction loop: prompt -> append rule -> mark superseded -> recoverable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-memory-tools-"));
  try {
    const handlers = captureMemoryTools();
    const agentId = "test-agent";
    const notes = [
      "run A failed because the lint step was skipped",
      "run B failed because the lint step was skipped",
      "run C failed because the lint step was skipped",
    ];
    for (const note of notes) {
      await callTool(handlers, "agent_memory_append", {
        agentId,
        scope: "project",
        cwd: dir,
        note,
      });
    }

    const compaction = await callTool(handlers, "agent_memory_compaction_prompt", {
      agentId,
      scope: "project",
      cwd: dir,
    });
    assert.equal(compaction.status, "ok");
    assert.equal(compaction.candidates.length, 3);
    assert.ok(compaction.prompt.includes(compaction.compactionId));
    assert.ok(compaction.prompt.includes("agent_memory_append"));

    // The agent writes the abstracted rule back...
    await callTool(handlers, "agent_memory_append", {
      agentId,
      scope: "project",
      cwd: dir,
      note: `[rule ${compaction.compactionId}] always run the lint step before completing`,
    });

    // ...and marks the distilled observations superseded.
    const markResult = await callTool(handlers, "agent_memory_mark_superseded", {
      agentId,
      scope: "project",
      cwd: dir,
      entryIds: compaction.candidates.map((c: { id: string }) => c.id),
      supersededBy: compaction.compactionId,
    });
    assert.equal(markResult.marked.length, 3);
    assert.deepEqual(markResult.missing, []);

    // Default get: superseded entries are still there — recoverable, not deleted.
    const full = await callTool(handlers, "agent_memory_get", {
      agentId,
      scope: "project",
      cwd: dir,
    });
    for (const note of notes) {
      assert.ok(full.content.includes(note), `superseded note must remain recoverable: ${note}`);
    }
    assert.ok(full.content.includes(`[superseded:${compaction.compactionId}]`));
    assert.ok(full.content.includes(`[rule ${compaction.compactionId}]`));

    // Budgeted recall skips superseded entries but keeps the rule...
    const budgeted = await callTool(handlers, "agent_memory_get", {
      agentId,
      scope: "project",
      cwd: dir,
      tokenBudget: 10000,
    });
    assert.equal(budgeted.recall.entriesSuperseded, 3);
    assert.ok(budgeted.content.includes(`[rule ${compaction.compactionId}]`));
    assert.ok(!budgeted.content.includes("run A failed"));

    // ...and includeSuperseded recovers them through the budgeted path too.
    const recovered = await callTool(handlers, "agent_memory_get", {
      agentId,
      scope: "project",
      cwd: dir,
      tokenBudget: 10000,
      includeSuperseded: true,
    });
    assert.ok(
      recovered.content.includes("lint step was skipped"),
      "includeSuperseded must surface superseded observations in budgeted recall"
    );

    // A fresh compaction prompt no longer offers superseded entries.
    const secondCompaction = await callTool(handlers, "agent_memory_compaction_prompt", {
      agentId,
      scope: "project",
      cwd: dir,
    });
    assert.equal(secondCompaction.entriesEligible, 1);
    assert.ok(
      secondCompaction.candidates.every(
        (c: { text: string }) => !c.text.includes("lint step was skipped")
      )
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
