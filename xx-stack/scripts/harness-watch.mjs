#!/usr/bin/env node

import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const INTERVAL_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;

const mcpServerDir = resolve(dirname(fileURLToPath(import.meta.url)), "../mcp-server");

let running = true;
let consecutiveFailures = 0;

process.on("SIGINT", () => {
  process.stderr.write("\nharness:watch — interrupted, exiting.\n");
  process.exit(0);
});

process.stderr.write(
  `harness:watch — polling every ${INTERVAL_MS / 1000}s, exits after ${MAX_CONSECUTIVE_FAILURES} consecutive failures. CTRL-C to stop.\n\n`
);

while (running) {
  const start = Date.now();
  try {
    execSync("npm run harness:ci", { cwd: mcpServerDir, stdio: "inherit" });
    consecutiveFailures = 0;
  } catch {
    consecutiveFailures += 1;
    process.stderr.write(
      `\nharness:watch — failure ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}\n`
    );
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      process.stderr.write("harness:watch — too many consecutive failures, exiting.\n");
      process.exit(1);
    }
  }

  const elapsed = Date.now() - start;
  const wait = Math.max(0, INTERVAL_MS - elapsed);
  if (running && wait > 0) {
    await new Promise((done) => setTimeout(done, wait));
  }
}
