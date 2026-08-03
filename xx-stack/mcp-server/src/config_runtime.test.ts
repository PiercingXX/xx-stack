import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyToolPolicy,
  mergeAgentProfiles,
  readAgentConfigDocument,
  readJson,
  readJsonResult,
  validateAgentProfiles,
  type AgentProfile,
} from "./config_runtime.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-config-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeConfig(dir: string, name: string, doc: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(doc, null, 2), "utf-8");
  return path;
}

/** The repo-side profile of a deliberately restricted agent. */
const RESTRICTED_REPO_AGENT = {
  agent: {
    reviewer: {
      mode: "subagent",
      model: "ollama/qwen3-coder",
      requiredMcpServers: ["xx-stack"],
      toolPolicy: {
        allow: ["review_*", "agent_memory_get"],
        deny: ["supervisor_abort_session", "task_suspend"],
      },
      memory: { enabled: true, scope: "project" },
      coordinator: { strictWorkerContract: true },
    },
  },
  mcp: { "xx-stack": {} },
};

async function mergedReviewer(
  dir: string,
  userDoc: unknown
): Promise<{ merged: AgentProfile; configuredMcpServers: string[] }> {
  const repoPath = await writeConfig(dir, "repo-config.json", RESTRICTED_REPO_AGENT);
  const userPath = await writeConfig(dir, "user-config.json", userDoc);
  const repoDoc = await readAgentConfigDocument(repoPath);
  const userDocParsed = await readAgentConfigDocument(userPath);

  const base = mergeAgentProfiles({}, repoDoc.agent!.reviewer);
  const merged = userDocParsed.agent?.reviewer
    ? mergeAgentProfiles(base, userDocParsed.agent.reviewer)
    : base;
  const configuredMcpServers = [
    ...new Set([...Object.keys(repoDoc.mcp ?? {}), ...Object.keys(userDocParsed.mcp ?? {})]),
  ];
  return { merged, configuredMcpServers };
}

// ---------------------------------------------------------------------------
// MCP-2: an agent merely MENTIONED in the user config must keep its repo profile
// ---------------------------------------------------------------------------

test("a bare user-config mention does not erase the repo model, mode, or required servers", async () => {
  await withTempDir(async (dir) => {
    // The user config names the agent and sets nothing else. This is the exact
    // shape that used to blow away the whole repo profile: parseAgentProfile
    // emitted `model: undefined` and object spread copies undefined-valued keys.
    const { merged } = await mergedReviewer(dir, { agent: { reviewer: {} } });

    assert.equal(merged.model, "ollama/qwen3-coder");
    assert.equal(merged.mode, "subagent");
    assert.deepEqual(merged.requiredMcpServers, ["xx-stack"]);
    assert.equal(merged.memory?.enabled, true);
    assert.equal(merged.memory?.scope, "project");
    assert.equal(merged.coordinator?.strictWorkerContract, true);
  });
});

test("a bare user-config mention does not disarm the repo tool denylist", async () => {
  await withTempDir(async (dir) => {
    const { merged } = await mergedReviewer(dir, { agent: { reviewer: {} } });

    assert.deepEqual(merged.toolPolicy?.allow, ["review_*", "agent_memory_get"]);
    assert.deepEqual(merged.toolPolicy?.deny, ["supervisor_abort_session", "task_suspend"]);

    // The security core of MCP-2: an empty allow-list means allow-all in
    // applyToolPolicy, so a wiped policy silently unrestricts the agent.
    const policy = applyToolPolicy(merged, [
      "review_diff",
      "agent_memory_get",
      "supervisor_abort_session",
      "task_suspend",
      "exec_command",
    ]);
    assert.deepEqual(policy.allowedTools, ["review_diff", "agent_memory_get"]);
    assert.deepEqual(policy.deniedTools.sort(), [
      "exec_command",
      "supervisor_abort_session",
      "task_suspend",
    ]);
  });
});

test("a user config that sets one field overrides only that field", async () => {
  await withTempDir(async (dir) => {
    const { merged } = await mergedReviewer(dir, {
      agent: { reviewer: { model: "cloud/opus", toolPolicy: { allow: ["*"] } } },
    });

    assert.equal(merged.model, "cloud/opus", "an explicit override still wins");
    assert.equal(merged.mode, "subagent", "an unset sibling key is untouched");
    // allow was explicitly replaced; deny was not mentioned and must survive.
    assert.deepEqual(merged.toolPolicy?.allow, ["*"]);
    assert.deepEqual(merged.toolPolicy?.deny, ["supervisor_abort_session", "task_suspend"]);

    const policy = applyToolPolicy(merged, ["review_diff", "task_suspend"]);
    assert.deepEqual(policy.allowedTools, ["review_diff"]);
    assert.deepEqual(policy.deniedTools, ["task_suspend"]);
  });
});

test("an explicit empty deny list still clears the repo deny list", async () => {
  await withTempDir(async (dir) => {
    // Omitted is not the same as explicitly cleared: this user deliberately
    // wrote `deny: []`, so it wins.
    const { merged } = await mergedReviewer(dir, {
      agent: { reviewer: { toolPolicy: { deny: [] } } },
    });
    assert.deepEqual(merged.toolPolicy?.deny, []);
    assert.deepEqual(merged.toolPolicy?.allow, ["review_*", "agent_memory_get"]);
  });
});

test("validateAgentProfiles stops reporting missing_model for a correctly configured agent", async () => {
  await withTempDir(async (dir) => {
    const { merged, configuredMcpServers } = await mergedReviewer(dir, {
      agent: { reviewer: {} },
    });
    const { errors } = validateAgentProfiles({ reviewer: merged }, configuredMcpServers);
    assert.deepEqual(
      errors.map((e) => e.code),
      []
    );
  });
});

test("mergeAgentProfiles never emits an undefined-valued key", async () => {
  await withTempDir(async (dir) => {
    const path = await writeConfig(dir, "sparse.json", { agent: { sparse: { model: "m" } } });
    const doc = await readAgentConfigDocument(path);
    const profile = doc.agent!.sparse;

    assert.deepEqual(Object.keys(profile), ["model"]);
    assert.equal("mode" in profile, false);
    assert.equal("toolPolicy" in profile, false);

    const merged = mergeAgentProfiles({ mode: "primary" }, profile);
    assert.deepEqual(merged, { mode: "primary", model: "m" });
  });
});

// ---------------------------------------------------------------------------
// MCP-2 (related): a malformed config must not look like a missing one
// ---------------------------------------------------------------------------

test("readJsonResult distinguishes a missing file from a malformed one", async () => {
  await withTempDir(async (dir) => {
    const missing = await readJsonResult(join(dir, "does-not-exist.json"));
    assert.equal(missing.status, "missing");
    assert.equal(missing.value, null);

    const brokenPath = join(dir, "broken.json");
    await writeFile(brokenPath, '{ "agent": { "reviewer": ', "utf-8");
    const broken = await readJsonResult(brokenPath);
    assert.equal(broken.status, "invalid");
    assert.equal(broken.value, null);
    assert.ok(broken.error && broken.error.length > 0, "the parse error must be reported");

    const scalarPath = join(dir, "scalar.json");
    await writeFile(scalarPath, "42", "utf-8");
    assert.equal((await readJsonResult(scalarPath)).status, "invalid");

    // readJson keeps its old null-on-anything contract for existing callers.
    assert.equal(await readJson(brokenPath), null);
    assert.equal(await readJson(join(dir, "does-not-exist.json")), null);
  });
});

test("readAgentConfigDocument reports why it contributed nothing", async () => {
  await withTempDir(async (dir) => {
    const brokenPath = join(dir, "broken.json");
    await writeFile(brokenPath, "{ not json", "utf-8");

    const broken = await readAgentConfigDocument(brokenPath);
    assert.equal(broken.status, "invalid");
    assert.deepEqual(broken.agent, {});
    assert.deepEqual(broken.mcp, {});

    const absent = await readAgentConfigDocument(join(dir, "absent.json"));
    assert.equal(absent.status, "missing");

    const okPath = await writeConfig(dir, "ok.json", { agent: {}, mcp: { "xx-stack": {} } });
    assert.equal((await readAgentConfigDocument(okPath)).status, "ok");
  });
});
