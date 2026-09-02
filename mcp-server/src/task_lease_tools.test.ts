import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { DEFAULT_RELIABILITY, emptySupervisorStore } from "./supervisor_runtime.js";
import { registerTaskTools } from "./task_tools.js";
import {
  readTaskStore,
  revokeSessionTaskLeases,
  withTaskStoreLock,
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

async function withTempHome<T>(work: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "xx-stack-task-lease-"));
  process.env.HOME = homeDir;
  // Lifecycle-hook config also resolves from HOME / XX_STACK_REPO; point both
  // at the throwaway dir so no configured hook can fire during these tests.
  process.env.XX_STACK_REPO = homeDir;
  await mkdir(join(homeDir, ".config/opencode"), { recursive: true });
  try {
    return await work(homeDir);
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
    registerTool: (...args: unknown[]) => {
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
    // request carries a replacement lease and no result fields.
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

test("a replacement lease cannot smuggle a write-back past a dead lease", async () => {
  await withTempHome(async () => {
    const tools = captureTaskTools();
    const created = await call(tools.task_create!, {
      title: "Revoked lane",
      lease: { expiresAt: FUTURE },
    });
    const taskId = created.task.taskId as string;
    await call(tools.task_update!, { taskId, lease: { expiresAt: FUTURE, revoked: true } });

    const rejected = await call(tools.task_update!, {
      taskId,
      lease: { expiresAt: FUTURE },
      status: "done",
      lastCheckpoint: "stale result smuggled with a new lease",
    });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.reasonCode, "lease_revoked");

    const stored = (await readTaskStore()).tasks[taskId]!;
    assert.notEqual(stored.status, "done", "a bundled write-back must not change status");
    assert.equal(stored.lastCheckpoint, undefined, "a bundled write-back must not land a result");
    assert.deepEqual(
      stored.lease,
      { expiresAt: FUTURE, revoked: true },
      "a rejected write-back must not replace the revoked lease"
    );

    const released = await call(tools.task_update!, { taskId, lease: { expiresAt: FUTURE } });
    assert.equal(released.status, "updated");
    assert.deepEqual(released.task.lease, { expiresAt: FUTURE });
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

// --- MCP-4: the fence covers every write path -----------------------------

test("task_suspend against a revoked lease is rejected and persists nothing", async () => {
  await withTempHome(async () => {
    const tools = captureTaskTools();

    const created = await call(tools.task_create!, {
      title: "Leased and running",
      status: "in_progress",
      lease: { expiresAt: FUTURE },
    });
    const taskId = created.task.taskId as string;
    await call(tools.task_update!, { taskId, lease: { expiresAt: FUTURE, revoked: true } });

    const rejected = await call(tools.task_suspend!, {
      taskId,
      checkpoint: "stale checkpoint from the dead lane",
    });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.reasonCode, "lease_revoked");
    assert.equal(rejected.operation, "task_suspend");
    assert.ok(rejected.selfFencingClause.includes("do not write"));

    const stored = (await readTaskStore()).tasks[taskId]!;
    assert.equal(stored.status, "in_progress", "a fenced suspend must not change status");
    assert.equal(stored.lastCheckpoint, undefined, "a fenced suspend must not land a checkpoint");
  });
});

test("task_suspend against an expired lease is rejected against the server clock", async () => {
  await withTempHome(async () => {
    const tools = captureTaskTools();
    const created = await call(tools.task_create!, {
      title: "Expired lane",
      status: "in_progress",
      lease: { expiresAt: PAST },
    });

    const rejected = await call(tools.task_suspend!, { taskId: created.task.taskId });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.reasonCode, "lease_expired");
  });
});

test("task_resume against a revoked lease is rejected; re-leasing restores it", async () => {
  await withTempHome(async () => {
    const tools = captureTaskTools();

    const created = await call(tools.task_create!, {
      title: "Suspended and leased",
      status: "suspended",
      lease: { expiresAt: FUTURE },
    });
    const taskId = created.task.taskId as string;
    await call(tools.task_update!, { taskId, lease: { expiresAt: FUTURE, revoked: true } });

    const rejected = await call(tools.task_resume!, { taskId });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.reasonCode, "lease_revoked");
    assert.equal(rejected.operation, "task_resume");

    const stored = (await readTaskStore()).tasks[taskId]!;
    assert.equal(stored.status, "suspended", "a fenced resume must not restart the task");
    assert.equal(stored.resumeCount ?? 0, 0, "a fenced resume must not count as an attempt");

    // Re-assignment is the supervisor's job and carries a replacement lease.
    await call(tools.task_update!, { taskId, lease: { expiresAt: FUTURE } });
    const resumed = await call(tools.task_resume!, { taskId });
    assert.equal(resumed.status, "resumed");
    assert.equal(resumed.task.status, "in_progress");
  });
});

test("an unleased task suspends and resumes exactly as before", async () => {
  await withTempHome(async () => {
    const tools = captureTaskTools();
    const created = await call(tools.task_create!, { title: "Plain", status: "in_progress" });
    const taskId = created.task.taskId as string;

    const suspended = await call(tools.task_suspend!, { taskId, checkpoint: "half done" });
    assert.equal(suspended.status, "suspended");
    assert.equal(suspended.task.lastCheckpoint, "half done");

    const resumed = await call(tools.task_resume!, { taskId });
    assert.equal(resumed.status, "resumed");
    assert.equal(resumed.task.resumeCount, 1);
  });
});

test("a terminal task is never reopened by task_resume", async () => {
  await withTempHome(async () => {
    const tools = captureTaskTools();

    for (const status of ["done", "canceled", "force_synthesized"] as const) {
      const created = await call(tools.task_create!, { title: `Finished (${status})`, status });
      const rejected = await call(tools.task_resume!, { taskId: created.task.taskId });
      assert.equal(rejected.status, "rejected", `${status} must not resume`);
      assert.equal(rejected.reasonCode, "task_terminal");
      assert.equal(rejected.taskStatus, status);

      const stored = (await readTaskStore()).tasks[created.task.taskId]!;
      assert.equal(stored.status, status, "the terminal outcome survives the resume attempt");
    }
  });
});

// --- MCP-1: an unreadable task store never becomes an empty one -----------

test("a task tool on a corrupt store reports the failure and does not truncate it", async () => {
  await withTempHome(async (homeDir) => {
    const tools = captureTaskTools();
    await call(tools.task_create!, { title: "Precious task" });

    const statePath = join(homeDir, ".config/opencode/xx-stack-task-state.json");
    const good = await readFile(statePath, "utf-8");
    await writeFile(statePath, good.slice(0, 30), "utf-8");
    const corrupt = await readFile(statePath, "utf-8");

    for (const [toolName, args] of [
      ["task_list", {}],
      ["task_get", { taskId: "tsk-anything" }],
      ["task_create", { title: "Would clobber everything" }],
      ["task_update", { taskId: "tsk-anything", status: "done" }],
      ["task_suspend", { taskId: "tsk-anything" }],
      ["task_resume", { taskId: "tsk-anything" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const payload = await call(tools[toolName]!, args);
      assert.equal(payload.status, "error", `${toolName} must not report success`);
      assert.equal(payload.reasonCode, "store_unavailable");
      assert.equal(payload.store, "task");
    }

    assert.equal(
      await readFile(statePath, "utf-8"),
      corrupt,
      "one bad read must never rewrite the whole document"
    );
  });
});

// --- MCP-12: lifecycle hooks run outside the task-store mutex -------------

test("a lifecycle hook runs with the task-store lock released", async () => {
  await withTempHome(async (homeDir) => {
    // A hook that blocks until the test releases it. While it is running the
    // task store lock must be free: it is a non-reentrant promise-chain mutex,
    // so a hook awaited inside it deadlocks any hook that calls back into the
    // task tools, and blocks every task_get/task_list behind subprocess time.
    const hookScript = join(homeDir, "blocking-hook.sh");
    const startedFlag = join(homeDir, "hook-started");
    const releaseFlag = join(homeDir, "hook-release");
    await writeFile(
      hookScript,
      [
        "#!/bin/sh",
        `: > "${startedFlag}"`,
        `while [ ! -f "${releaseFlag}" ]; do sleep 0.02; done`,
        "exit 0",
      ].join("\n"),
      { mode: 0o755 }
    );
    await writeFile(
      join(homeDir, ".config/opencode/config.json"),
      JSON.stringify({
        lifecycleHooks: {
          enabled: true,
          allowedCommands: [hookScript],
          events: { "task.created": [{ command: hookScript, args: [], timeoutMs: 30_000 }] },
        },
      }),
      "utf-8"
    );

    const tools = captureTaskTools();
    const creating = call(tools.task_create!, { title: "Task with a slow hook" });

    // Wait for the hook subprocess to actually be running.
    const deadline = Date.now() + 20_000;
    while (!existsSync(startedFlag)) {
      if (Date.now() > deadline) throw new Error("lifecycle hook never started");
      await delay(20);
    }

    // With the hook mid-flight, the store lock must be acquirable.
    const acquired = await Promise.race([
      withTaskStoreLock(async () => "acquired"),
      delay(5_000).then(() => "deadlocked"),
    ]);
    assert.equal(acquired, "acquired", "the hook must not be awaited while holding the store lock");

    await writeFile(releaseFlag, "", "utf-8");
    const created = await creating;
    assert.equal(created.status, "created");
    assert.equal(created.hooks.executedHookCount, 1, "the hook still runs, just outside the lock");
  });
});
