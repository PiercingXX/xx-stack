import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  guardStoreAccess,
  isMissingFileError,
  readSupervisorStore,
  StoreAccessError,
  storeAccessErrorPayload,
  writeSupervisorStore,
} from "./supervisor_store_runtime.js";
import { readTaskStore, writeTaskStore, emptyTaskStore } from "./task_runtime.js";

// MCP-1: both stores are read → mutate → write-whole-document, so a reader that
// heals an unreadable file into an empty store makes the very next write
// truncate every session/task. Only a genuinely missing file is an empty store.
//
// The stores live under $HOME; every test here runs against a throwaway HOME so
// the developer's real state is never touched. node --test isolates each test
// file in its own process, so this mutation cannot leak into another suite.
const ORIGINAL_HOME = process.env.HOME;

const SUPERVISOR_FILE = ".config/opencode/xx-stack-supervisor-state.json";
const TASK_FILE = ".config/opencode/xx-stack-task-state.json";

async function withTempHome<T>(work: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "xx-stack-store-access-"));
  process.env.HOME = homeDir;
  await mkdir(join(homeDir, ".config/opencode"), { recursive: true });
  try {
    return await work(homeDir);
  } finally {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
    await rm(homeDir, { recursive: true, force: true });
  }
}

// --- missing file is the only "empty store" case --------------------------

test("a missing store file reads as an empty store for both stores", async () => {
  await withTempHome(async () => {
    assert.deepEqual(await readSupervisorStore(), {
      version: 1,
      sessions: {},
      hostModelFailures: {},
    });
    assert.deepEqual(await readTaskStore(), emptyTaskStore());
  });
});

test("isMissingFileError only recognizes ENOENT", () => {
  assert.equal(isMissingFileError(Object.assign(new Error("nope"), { code: "ENOENT" })), true);
  assert.equal(isMissingFileError(Object.assign(new Error("denied"), { code: "EACCES" })), false);
  assert.equal(isMissingFileError(new SyntaxError("Unexpected token")), false);
  assert.equal(isMissingFileError(undefined), false);
});

// --- corrupt content fails loudly instead of reading as empty -------------

test("a corrupt supervisor store raises StoreAccessError instead of reading as empty", async () => {
  await withTempHome(async (homeDir) => {
    await writeFile(join(homeDir, SUPERVISOR_FILE), '{"sessions": {"sx-1": ', "utf-8");

    await assert.rejects(
      () => readSupervisorStore(),
      (error: unknown) => {
        assert.ok(error instanceof StoreAccessError);
        assert.equal(error.store, "supervisor");
        assert.ok(error.message.includes("could not be read"));
        return true;
      }
    );
  });
});

test("a corrupt task store raises StoreAccessError instead of reading as empty", async () => {
  await withTempHome(async (homeDir) => {
    await writeFile(join(homeDir, TASK_FILE), "not json at all", "utf-8");

    await assert.rejects(
      () => readTaskStore(),
      (error: unknown) => {
        assert.ok(error instanceof StoreAccessError);
        assert.equal(error.store, "task");
        return true;
      }
    );
  });
});

test("a store whose root or collection is the wrong JSON shape is corrupt, not empty", async () => {
  await withTempHome(async (homeDir) => {
    await writeFile(join(homeDir, SUPERVISOR_FILE), "[]", "utf-8");
    await assert.rejects(() => readSupervisorStore(), StoreAccessError);

    await writeFile(join(homeDir, SUPERVISOR_FILE), '{"sessions": []}', "utf-8");
    await assert.rejects(() => readSupervisorStore(), StoreAccessError);

    await writeFile(join(homeDir, TASK_FILE), '{"tasks": "gone"}', "utf-8");
    await assert.rejects(() => readTaskStore(), StoreAccessError);
  });
});

test("an unreadable store path (not ENOENT) raises instead of reading as empty", async () => {
  await withTempHome(async (homeDir) => {
    // A directory where the state file belongs: readFile fails with EISDIR,
    // which is exactly the class of error the old bare catch swallowed.
    await mkdir(join(homeDir, TASK_FILE), { recursive: true });

    await assert.rejects(
      () => readTaskStore(),
      (error: unknown) => {
        assert.ok(error instanceof StoreAccessError);
        assert.equal(error.code, "EISDIR");
        return true;
      }
    );
  });
});

// --- a valid store still round-trips --------------------------------------

test("a written store round-trips unchanged", async () => {
  await withTempHome(async () => {
    const store = {
      version: 1,
      sessions: {},
      hostModelFailures: { "h::m": { count: 2, lastFailureAt: 42 } },
    };
    await writeSupervisorStore(store);
    assert.deepEqual(await readSupervisorStore(), store);

    const tasks = emptyTaskStore();
    tasks.tasks["tsk-1"] = {
      taskId: "tsk-1",
      title: "round trip",
      status: "todo",
      tags: [],
      blockedBy: [],
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    };
    await writeTaskStore(tasks);
    assert.deepEqual(await readTaskStore(), tasks);
  });
});

// --- structured surfacing --------------------------------------------------

test("guardStoreAccess turns a store failure into a structured result and rethrows anything else", async () => {
  const error = new StoreAccessError("task", "/tmp/x.json", new SyntaxError("bad json"));

  const guarded = await guardStoreAccess(async () => {
    throw error;
  });
  const payload = JSON.parse(guarded.content[0]!.text);
  assert.equal(payload.status, "error");
  assert.equal(payload.reasonCode, "store_unavailable");
  assert.equal(payload.store, "task");
  assert.equal(payload.path, "/tmp/x.json");
  assert.ok(String(payload.remediation).includes("Nothing was written"));

  await assert.rejects(
    () =>
      guardStoreAccess(async () => {
        throw new TypeError("a real bug must not be swallowed");
      }),
    TypeError
  );

  assert.equal(storeAccessErrorPayload(new TypeError("other")), null);
});
