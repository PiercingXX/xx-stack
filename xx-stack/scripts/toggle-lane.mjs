#!/usr/bin/env node
/**
 * Turn discovered lanes on or off in inventory.json.
 *
 *   npm run inventory:enable  gpu-box            # every runtime on that machine
 *   npm run inventory:enable  gpu-box.sglang     # one runtime
 *   npm run inventory:disable gpu-box.ollama
 *   npm run inventory:list                       # what exists and what is on
 *
 * Discovered hardware is always written disabled, so this is the deliberate
 * step that lets traffic reach a machine. It does not regenerate the consumer
 * configs — run `npm run inventory:sync` after.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const inventoryPath = path.join(repoRoot, "inventory.json");
const fallbackInventoryPath = path.join(repoRoot, "inventory.example.json");

const [, , mode, target] = process.argv;

/** Set when the template answered because inventory.json does not exist yet. */
let readingFallback = false;

/**
 * inventory.json is hardware truth for the whole stack. A corrupt or partial
 * file must produce an actionable message, not a raw parser stack trace.
 * A missing one is not an error: until you take ownership of your own
 * inventory, the shipped template answers (same contract as
 * generate-registries.mjs).
 */
function loadInventory() {
  let raw;
  try {
    raw = fs.readFileSync(inventoryPath, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`Cannot read inventory at ${inventoryPath}: ${err.message}`);
      console.error(
        `Fix its permissions, or start over from ${path.basename(fallbackInventoryPath)}.`
      );
      process.exit(1);
    }
    readingFallback = true;
    console.log(
      `${path.basename(inventoryPath)} not found — reading ${path.basename(fallbackInventoryPath)}. ` +
        `To describe your own machines: cp ${path.basename(fallbackInventoryPath)} ${path.basename(inventoryPath)}`
    );
    raw = fs.readFileSync(fallbackInventoryPath, "utf8");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`The inventory is not valid JSON (${inventoryPath}):`);
    console.error(`  ${err.message}`);
    console.error("Fix the syntax error, then retry.");
    process.exit(1);
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.machines)) {
    console.error(`inventory.json has no top-level "machines" array (${inventoryPath}).`);
    console.error("Refusing to operate on a structurally invalid inventory.");
    process.exit(1);
  }

  return parsed;
}

const inventory = loadInventory();

const green = (s) => `[32m${s}[0m`;
const dim = (s) => `[2m${s}[0m`;

function listAll() {
  console.log("Machines and lanes in inventory.json:\n");
  for (const m of inventory.machines) {
    console.log(`  ${m.id}  ${dim(`(${m.network?.scope ?? "?"} · ${m.network?.address ?? "?"})`)}`);
    for (const r of m.runtimes ?? []) {
      const on = r.enabled !== false;
      const state = on ? green("on ") : dim("off");
      const models = (r.models ?? []).length;
      console.log(
        `      ${state}  ${r.kind.padEnd(10)} :${String(r.port).padEnd(6)} ${models} model(s)`
      );
    }
  }
  for (const a of inventory.aggregators ?? []) {
    const state = a.enabled !== false ? green("on ") : dim("off");
    console.log(`\n  ${a.id}  ${dim(`(${a.kind} aggregator)`)}\n      ${state}  :${a.port}`);
  }
  console.log(
    `\n  cloud escalation: ${inventory.policy?.cloudEscalation?.optIn ? green("opted in") : dim("off (default)")}`
  );
  console.log(dim("\n  npm run inventory:enable <machine>[.<runtime>]"));
}

if (!mode || mode === "list") {
  listAll();
  process.exit(0);
}

if (!["enable", "disable"].includes(mode) || !target) {
  console.error("usage: toggle-lane.mjs <enable|disable> <machine>[.<runtime>]");
  console.error("       toggle-lane.mjs list");
  process.exit(2);
}

const wantEnabled = mode === "enable";
const [machineId, runtimeKind] = target.split(".");

const machine = inventory.machines.find((m) => m.id === machineId);
const aggregator = (inventory.aggregators ?? []).find((a) => a.id === machineId);

if (!machine && !aggregator) {
  console.error(`No machine or aggregator with id "${machineId}".\n`);
  listAll();
  process.exit(1);
}

const touched = [];

if (aggregator) {
  aggregator.enabled = wantEnabled;
  touched.push(aggregator.id);
} else {
  const runtimes = machine.runtimes ?? [];
  const targets = runtimeKind ? runtimes.filter((r) => r.kind === runtimeKind) : runtimes;

  if (!targets.length) {
    console.error(
      runtimeKind
        ? `Machine "${machineId}" has no runtime of kind "${runtimeKind}".`
        : `Machine "${machineId}" has no runtimes at all.`
    );
    console.error(`Available: ${runtimes.map((r) => r.kind).join(", ") || "(none)"}`);
    process.exit(1);
  }
  for (const r of targets) {
    r.enabled = wantEnabled;
    touched.push(`${machine.id}.${r.kind}`);
  }
}

fs.writeFileSync(inventoryPath, JSON.stringify(inventory, null, 2) + "\n", "utf8");
console.log(`${wantEnabled ? "Enabled" : "Disabled"}: ${touched.join(", ")}`);
if (readingFallback) {
  console.log(
    `Saved your new ${path.basename(inventoryPath)} (started from ${path.basename(fallbackInventoryPath)}).`
  );
}
console.log("\nRegenerate the consumer configs:  npm run inventory:sync");
