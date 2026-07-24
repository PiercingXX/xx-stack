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

const [, , mode, target] = process.argv;
const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));

const green = (s) => `[32m${s}[0m`;
const dim = (s) => `[2m${s}[0m`;

function listAll() {
  console.log("Machines and lanes in inventory.json:\n");
  for (const m of inventory.machines) {
    console.log(`  ${m.id}  ${dim(`(${m.network.scope} · ${m.network.address})`)}`);
    for (const r of m.runtimes) {
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
    `\n  cloud escalation: ${inventory.policy.cloudEscalation.optIn ? green("opted in") : dim("off (default)")}`
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
  const targets = runtimeKind
    ? machine.runtimes.filter((r) => r.kind === runtimeKind)
    : machine.runtimes;

  if (!targets.length) {
    console.error(`Machine "${machineId}" has no runtime of kind "${runtimeKind}".`);
    console.error(`Available: ${machine.runtimes.map((r) => r.kind).join(", ")}`);
    process.exit(1);
  }
  for (const r of targets) {
    r.enabled = wantEnabled;
    touched.push(`${machine.id}.${r.kind}`);
  }
}

fs.writeFileSync(inventoryPath, JSON.stringify(inventory, null, 2) + "\n", "utf8");
console.log(`${wantEnabled ? "Enabled" : "Disabled"}: ${touched.join(", ")}`);
console.log("\nRegenerate the consumer configs:  npm run inventory:sync");
