import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { DEFAULT_RELIABILITY, emptySupervisorStore } from "./supervisor_runtime.js";
import { registerTaskTools } from "./task_tools.js";
import {
  readTaskStore,
  revokeSessionTaskLeases,
  type PersistentTask,
  type TaskLease,
} from "./task_runtime.js";

// The task store lives under $HOME. Every test in this file runs against a
// throwaway HOME so the developer's real task state is never touched.
// node --test isolates each test file in its own process, so this mutation
// cannot leak into another suite.
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_REPO = process.env.XX_STACK_REPO;

function restore(name: "HOME" | "XX_STACK_REPO", original: string | undefined): void {
  if (original === undefined) delete process.env[name];
  else process.env[name] = original;
}

async function withTempHome<T>(work: () => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "xx-stack-task-lease-"));
  process.env.HOME = homeDir;
  // Lifecycle-hook config also resolves from HOME / XX_STACK_REPO; point both
  // at the throwaway dir so no configured hook can fire during these tests.
  process.env.XX_STACK_REPO = homeDir;
  try {
    return await work();
  } finally {
    restore("HOME", ORIGINAL_HOME);
    restore("XX_STACK_REPO", ORIGINAL_REPO);
    await rm(homeDir, { recursive: true, force: true });
  }
}

type ToolResult = { content: Array<{ type: string; text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function captureTaskTools(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const fakeServer = {
    tool: (...args: unknown[]) => {
      handlers[args[0] as string] = args[args.length - 1] as Handler;
    },
  } as unknown as McpServer;

  registerTaskTools(fakeServer, {
    loadReliabilityConfig: async () => ({ ...DEFAULT_RELIABILITY }),
    readSupervisorStore: async () => emptySupervisorStore(),
    pruneSupervisorStore: (store) => store,
  });
  return handlers;
}

async function call(handler: Handler, args: Record<string, unknown>): Promise<any> {
  const result = await handler(args);
  assert.equal(result.content.length, 1);
  return JSON.parse(result.content[0]!.text);
}

const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

// --- default (no lease) path ---------------------------------------------

test("task registration and write-back without a lease are unchanged", async () => {
  await withTempHome(async () => {
    const tools = captureTaskTools();

    const created = await call(tools.task_create!, { title: "Unleased task" });
    assert.equal(created.status, "created");
    const task = created.task as PersistentTask;
    assert.equal(task.lease, undefined, "no lease field is materialized by default");

    // The persisted record must not carry a lease key at all.
    const persisted = await readTaskStore();
    const raw = JSON.stringify(persisted.tasks[task.taskId]);
    assert.ok(!raw.includes('"lease"'), `unleased task must serialize without a lease key: ${raw}`);

    const updated = await call(tools.task_update!, {
      taskId: task.taskId,
      lastCheckpoint: "result written back",
      status: "done",
    });
    assert.equal(updated.status, "updated", "an unleased write-back is never fenced");
    assert.equal(updated.task.lastCheckpoint, "result written back");
    assert.equal(updated.task.status, "done");
  });
});

// --- lease registration and live write-back -------------------------------

test("a live lease is recorded on registration and does not fence the write-back", async () => {
  await withTempHome(async () => {
    const tools = captureTaskTools();
    const lease: TaskLease = { expiresAt: FUTURE };

    const created = await call(tools.task_create!, { title: "Leased task", lease });
    assert.deepEqual(created.task.lease, { expiresAt: FUTURE });

    const updated = await call(tools.task_update!, {
      taskId: created.task.taskId,
      lastCheckpoint: "partial result",
    });
    assert.equal(updated.status, "updated");
    assert.equal(updated.task.lastCheckpoint, "partial result");
  });
});

// --- revoked write-back ---------------------------------------------------

test("write-back against a revoked lease is rejected with a structured reason and writes nothing", async () => {
  await withTempHome(async () => {
    const tools = captureTaskTools();

    const created = await call(tools.task_create!, {
      title: "Leased task",
      lease: { expiresAt: FUTURE },
    });
    const taskId = created.task.taskId as string;

    // The supervisor revokes the claim (what the failover flow does).
    const revoked = await call(tools.task_update!, {
      taskId,
      lease: { expiresAt: FUTURE, revoked: true },
    });
    assert.equal(revoked.status, "updated");
    assert.deepEqual(revoked.task.lease, { expiresAt: FUTURE, revoked: true });

    // The stalled lane wakes up and tries to write its result.
    const rejected = await call(tools.task_update!, {
      taskId,
      status: "done",
      lastCheckpoint: "stale result from the dead lane",
    });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.reasonCode, "lease_revoked");
    assert.equal(rejected.taskId, taskId);
    assert.deepEqual(rejected.lease, { expiresAt: FUTURE, revoked: true });
    assert.ok(typeof rejected.serverTime === "string");
    assert.ok(rejected.selfFencingClause.includes("do not write"));

    // Nothing landed: the store still holds the pre-write-back record.
    const store = await readTaskStore();
    const stored = store.tasks[taskId]!;
    assert.notEqual(stored.status, "done", "a rejected write-back must not change status");
    assert.equal(stored.lastCheckpoint, undefined, "a rejected write-back must not land a result");
  });
});

// --- expiry ---------------------------------------------------------------

test("write-back against an expired lease is rejected against the server's own clock", async () => {
  await withTempHome(async () => {
    const tools = captureTaskTools();

    const created = await call(tools.task_create!, {
      title: "Expired lane",
      lease: { expiresAt: PAST },
    });
    const taskId = created.task.taskId as string;

    const rejected = await call(tools.task_update!, {
      taskId,
      status: "done",
      lastCheckpoint: "result produced after the deadline",
    });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.reasonCode, "lease_expired");
    assert.deepEqual(rejected.lease, { expiresAt: PAST });

    const store = await readTaskStore();
    assert.notEqual(store.tasks[taskId]!.status, "done");

    // Re-leasing is the supervisor handing the task to a live lane; that
    // request carries a replacement lease and is not a result write-back.
    const released = await call(tools.task_update!, {
      taskId,
      lease: { expiresAt: FUTURE },
    });
    assert.equal(released.status, "updated");
    assert.deepEqual(released.task.lease, { expiresAt: FUTURE });

    const afterRelease = await call(tools.task_update!, {
      taskId,
      lastCheckpoint: "fresh lane result",
    });
    assert.equal(afterRelease.status, "updated");
    assert.equal(afterRelease.task.lastCheckpoint, "fresh lane result");
  });
});

test("an unparseable lease deadline is treated as dead, never as authorization", async () => {
  await withTempHome(async () => {
    const tools = captureTaskTools();
    const created = await call(tools.task_create!, {
      title: "Garbage deadline",
      lease: { expiresAt: "not-a-timestamp" },
    });

    const rejected = await call(tools.task_update!, {
      taskId: created.task.taskId,
      lastCheckpoint: "should not land",
    });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.reasonCode, "lease_expired");
  });
});

// --- failover revocation --------------------------------------------------

test("failover revokes every open leased task on the session and leaves unleased tasks untouched", async () => {
  await withTempHome(async () => {
    const tools = captureTaskTools();

    const leased = await call(tools.task_create!, {
      title: "Leased and open",
      sessionId: "sx-failover",
      lease: { expiresAt: FUTURE },
    });
    const unleased = await call(tools.task_create!, {
      title: "Open, no lease",
      sessionId: "sx-failover",
    });
    const otherSession = await call(tools.task_create!, {
      title: "Different session",
      sessionId: "sx-other",
      lease: { expiresAt: FUTURE },
    });
    const finished = await call(tools.task_create!, {
      title: "Already terminal",
      sessionId: "sx-failover",
      status: "done",
      lease: { expiresAt: FUTURE },
    });

    const at = "2026-08-02T09:00:00.000Z";
    const revoked = await revokeSessionTaskLeases("sx-failover", at);
    assert.deepEqual(revoked, [leased.task.taskId], "only the open leased task is revoked");

    const store = await readTaskStore();
    assert.deepEqual(store.tasks[leased.task.taskId]!.lease, {
      expiresAt: FUTURE,
      revoked: true,
    });
    assert.equal(store.tasks[leased.task.taskId]!.updatedAt, at);
    assert.equal(store.tasks[unleased.task.taskId]!.lease, undefined);
    assert.deepEqual(store.tasks[otherSession.task.taskId]!.lease, { expiresAt: FUTURE });
    assert.deepEqual(store.tasks[finished.task.taskId]!.lease, { expiresAt: FUTURE });

    // The stalled lane's write-back is now fenced.
    const rejected = await call(tools.task_update!, {
      taskId: leased.task.taskId,
      status: "done",
    });
    assert.equal(rejected.reasonCode, "lease_revoked");

    // Re-revoking is idempotent and reports no change.
    assert.deepEqual(await revokeSessionTaskLeases("sx-failover", at), []);
  });
});

test("failover on a fleet with no leases writes nothing at all", async () => {
  await withTempHome(async () => {
    const tools = captureTaskTools();
    await call(tools.task_create!, { title: "Plain task", sessionId: "sx-plain" });

    const before = JSON.stringify(await readTaskStore());
    const revoked = await revokeSessionTaskLeases("sx-plain", "2026-08-02T09:00:00.000Z");
    assert.deepEqual(revoked, []);
    assert.equal(JSON.stringify(await readTaskStore()), before, "no-lease failover is a no-op");
  });
});

// --- resume directive -----------------------------------------------------

test("task_resume carries the lease and self-fencing clause only when a lease exists", async () => {
  await withTempHome(async () => {
    const tools = captureTaskTools();

    const plain = await call(tools.task_create!, { title: "Plain", status: "suspended" });
    const plainResume = await call(tools.task_resume!, { taskId: plain.task.taskId });
    assert.ok(!plainResume.directive.includes("- lease:"));
    assert.ok(!plainResume.directive.includes("self-fencing"));

    const leased = await call(tools.task_create!, {
      title: "Leased",
      status: "suspended",
      lease: { expiresAt: FUTURE },
    });
    const leasedResume = await call(tools.task_resume!, { taskId: leased.task.taskId });
    assert.ok(leasedResume.directive.includes("- lease:"));
    assert.ok(leasedResume.directive.includes(`  - expires-at: ${FUTURE}`));
    assert.ok(leasedResume.directive.includes("  - revoked: no"));
    assert.ok(
      leasedResume.directive.includes("re-check this task's lease"),
      "the resume directive states the self-fencing rule"
    );
  });
});
