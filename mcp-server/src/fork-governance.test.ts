import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runDriftCheckAgainst,
  type GovernanceConfig,
  type RemoteHeadResult,
} from "./fork-governance.js";

// The drift check is exercised entirely through the injectable resolver, so no
// test dials github.com; the real resolveRemoteHead is a thin ls-remote shell
// whose error path is what these fixtures simulate.

function configIn(dir: string): GovernanceConfig {
  return {
    channels: {
      stable: { repo: "ggml-org/llama.cpp", ref: "master" },
      experimental: { repo: "PrismML-Eng/llama.cpp", ref: "prism" },
    },
    driftThreshold: { maxStableAdvancesWithoutExperimental: 3 },
    logs: {
      governanceLogPath: join(dir, "logs", "governance.jsonl"),
      statePath: join(dir, "logs", "state.json"),
      artifactPipelineLogPath: join(dir, "logs", "artifact.jsonl"),
    },
  };
}

const ok = (head: string | null): RemoteHeadResult => ({ status: "ok", head });

async function seedState(dir: string, state: unknown): Promise<void> {
  await mkdir(join(dir, "logs"), { recursive: true });
  await writeFile(join(dir, "logs", "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

test("a total resolution failure leaves state untouched and fails closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-gov-outage-"));
  try {
    const config = configIn(dir);
    const prior = {
      stableHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      experimentalHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      stableAdvanceCountWithoutExperimental: 2,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const seeded = `${JSON.stringify(prior, null, 2)}\n`;
    await seedState(dir, prior);

    // The outage: every lookup errors — pre-fix this collapsed to null on both
    // channels, read as "no movement", passed the gate, exited 0, and overwrote
    // both persisted heads with null.
    const outage = async (): Promise<RemoteHeadResult> => ({ status: "error" });
    const { payload, exitCode } = await runDriftCheckAgainst(config, outage);

    assert.equal(payload.status, "unverifiable");
    assert.equal(payload.gateProductionPromotion, false);
    assert.notEqual(exitCode, 0);

    assert.equal(await readFile(config.logs.statePath, "utf-8"), seeded, "state must be untouched");

    // The attempt is still recorded, with the unverifiable status a consumer
    // can gate on.
    const events = (await readFile(config.logs.governanceLogPath, "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "fork.governance.check");
    assert.equal(events[0].status, "unverifiable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a single-channel failure also skips the state overwrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-gov-partial-"));
  try {
    const config = configIn(dir);
    const prior = {
      stableHead: "cccccccccccccccccccccccccccccccccccccccc",
      experimentalHead: "dddddddddddddddddddddddddddddddddddddddd",
      stableAdvanceCountWithoutExperimental: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const seeded = `${JSON.stringify(prior, null, 2)}\n`;
    await seedState(dir, prior);

    const partial = async (repo: string): Promise<RemoteHeadResult> =>
      repo.startsWith("ggml")
        ? ok("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")
        : { status: "error" };
    const { payload, exitCode } = await runDriftCheckAgainst(config, partial);

    assert.equal(payload.status, "unverifiable");
    assert.notEqual(exitCode, 0);
    // Stable DID move, but an unverifiable check never advances the counter:
    // persisting it would double-count once the connection recovers.
    assert.equal(payload.stableAdvanceCountWithoutExperimental, 1);
    assert.equal(await readFile(config.logs.statePath, "utf-8"), seeded);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a verified check persists heads atomically and exits by the gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-gov-ok-"));
  try {
    const config = configIn(dir);
    const prior = {
      stableHead: "1111111111111111111111111111111111111111",
      experimentalHead: null,
      stableAdvanceCountWithoutExperimental: 3,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await seedState(dir, prior);

    // Stable advanced again while experimental stayed put -> count 4 > 3, so
    // the drift gate itself must fail the run (exit nonzero) even though the
    // fetches succeeded.
    const first = await runDriftCheckAgainst(config, async (repo) =>
      ok(repo.startsWith("ggml") ? "2222222222222222222222222222222222222222" : null)
    );
    assert.equal(first.payload.status, "ok");
    assert.equal(first.payload.stableAdvanceCountWithoutExperimental, 4);
    assert.equal(first.payload.driftRiskHigh, true);
    assert.equal(first.payload.gateProductionPromotion, false);
    assert.notEqual(first.exitCode, 0);

    const persisted = JSON.parse(await readFile(config.logs.statePath, "utf-8"));
    assert.equal(persisted.stableHead, "2222222222222222222222222222222222222222");
    assert.equal(persisted.experimentalHead, null);
    assert.equal(persisted.stableAdvanceCountWithoutExperimental, 4);

    // Experimental catches up -> the counter resets and promotion passes.
    const second = await runDriftCheckAgainst(config, async (repo) =>
      ok(
        repo.startsWith("ggml")
          ? "3333333333333333333333333333333333333333"
          : "4444444444444444444444444444444444444444"
      )
    );
    assert.equal(second.payload.stableAdvanceCountWithoutExperimental, 0);
    assert.equal(second.payload.gateProductionPromotion, true);
    assert.equal(second.exitCode, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
