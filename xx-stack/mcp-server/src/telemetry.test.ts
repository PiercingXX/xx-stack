import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { logTelemetry, __testLoadTelemetryConfig } from "./observability_tools.js";

test("telemetry is disabled by default (enabled:false) — logTelemetry writes nothing", async () => {
  // Verify the config is read as disabled
  const config = __testLoadTelemetryConfig();
  assert.equal(config.enabled, false, "telemetry.json must have enabled:false by default");

  // Set HOME to a temp dir so logEvent writes to an isolated location
  const origHome = process.env.HOME;
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-telemetry-"));
  process.env.HOME = dir;

  try {
    // Call logTelemetry — it should return early because config.enabled is false
    await logTelemetry({
      lane: "local",
      skill: "test-skill",
      outcome: "success",
      durationMs: 100,
      model: "gpt-4",
      tokensIn: 50,
      tokensOut: 150,
    });

    // The log directory should not exist (logEvent never ran)
    const logDir = join(dir, ".config", "opencode", "xx-stack-logs");
    let logDirExists = false;
    try {
      await readdir(logDir);
      logDirExists = true;
    } catch {
      // Directory does not exist — expected
    }

    assert.equal(logDirExists, false, "no telemetry log directory should exist when telemetry is disabled");
  } finally {
    process.env.HOME = origHome;
    await rm(dir, { recursive: true, force: true });
  }
});