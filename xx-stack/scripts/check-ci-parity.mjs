#!/usr/bin/env node
/**
 * Parity check between `npm run verify` and .github/workflows/ci.yml.
 *
 * CONTRIBUTING.md tells a contributor that a green local `verify` and a green
 * CI mean the same thing. That claim was false from some point before
 * 2026-08-14 until it was found by hand: `verify` ran sixteen gates, CI ran
 * ten, and the six it skipped were rules:check, nano:check, guardrails:check,
 * design:systems-lint, design:craft-refs and design:anti-slop-test. All six
 * existed, all six passed locally, and none had ever run on a pull request —
 * including guardrails:check, which is a safety gate, and design:systems-lint,
 * which packs/design/manifest.json names as the thing standing between a naive
 * re-vendor and silently reintroduced 1.06:1 body text.
 *
 * Prose did not hold that invariant, so this script does. Every gate in the
 * `verify` chain must be reachable from ci.yml.
 *
 * This script fails CI when:
 *   1. a script in the `verify` chain has no corresponding step in ci.yml;
 *   2. an ALIAS below names a verify gate that is no longer in the chain, or
 *      a CI pattern that no longer appears in ci.yml — a stale exemption is
 *      drift in its own right, and silently carrying one is how the original
 *      gap survived.
 *
 * It deliberately does NOT check the other direction. CI legitimately does
 * things `verify` cannot: a Node version matrix, and regenerating
 * DESIGN-CATALOG.md to fail on a stale commit (verify skips that because it
 * mutates the tree). Both are documented in CONTRIBUTING.md.
 *
 * Exit 0 = parity holds. Exit 1 = a gate is unenforced in CI.
 * Pass --json for machine-readable output.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkgPath = path.join(repoRoot, "package.json");
const ciPath = path.join(repoRoot, ".github", "workflows", "ci.yml");

// ---------------------------------------------------------------------------
// Gates CI runs by some route other than `npm run <gate>`. Each needs a reason:
// an exemption without one is indistinguishable from an oversight, which is the
// failure mode this whole script exists to prevent.
// ---------------------------------------------------------------------------
const ALIASES = [
  {
    gate: "test",
    pattern: "npm --prefix xx-stack/mcp-server test",
    reason:
      "CI runs the MCP server suite directly across a Node 20/22 matrix rather than through the root workspace script, so it covers strictly more than `npm test` does.",
  },
  {
    gate: "hermes:test",
    pattern: "python3 -m unittest discover -s tests",
    reason:
      "CI runs unittest directly in a job with its own setup-python step, rather than shelling out through the npm script.",
  },
];

const findings = [];

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const ci = fs.readFileSync(ciPath, "utf8");

const verifyChain = String(pkg.scripts?.verify ?? "")
  .split("&&")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => s.replace(/^npm run /, "").replace(/^npm /, ""));

if (verifyChain.length === 0) {
  findings.push({
    kind: "no-verify-script",
    where: "package.json",
    detail: "scripts.verify is missing or empty; there is nothing to check parity against",
  });
}

// `run:` lines in ci.yml, normalised to whitespace-collapsed strings.
const ciRuns = [...ci.matchAll(/^\s*(?:-\s*name:.*\n\s*)?run:\s*(.+)$/gm)].map((m) =>
  m[1].trim().replace(/\s+/g, " ")
);
const ciBlob = ciRuns.join("\n");

const aliasByGate = new Map(ALIASES.map((a) => [a.gate, a]));

for (const gate of verifyChain) {
  const alias = aliasByGate.get(gate);
  if (alias) {
    if (!ciBlob.includes(alias.pattern)) {
      findings.push({
        kind: "stale-alias",
        where: ".github/workflows/ci.yml",
        detail: `verify gate "${gate}" is exempted via the pattern "${alias.pattern}", which no longer appears in ci.yml. Either restore that step or drop the alias.`,
      });
    }
    continue;
  }
  if (!ciRuns.some((r) => r === `npm run ${gate}`)) {
    findings.push({
      kind: "gate-not-in-ci",
      where: ".github/workflows/ci.yml",
      detail: `"npm run ${gate}" is in the verify chain but has no step in ci.yml. Add it, or add an ALIAS in this script with a reason.`,
    });
  }
}

for (const alias of ALIASES) {
  if (!verifyChain.includes(alias.gate)) {
    findings.push({
      kind: "stale-alias",
      where: "xx-stack/scripts/check-ci-parity.mjs",
      detail: `ALIAS exempts verify gate "${alias.gate}", which is no longer in the verify chain. Remove the alias.`,
    });
  }
}

const jsonOutput = process.argv.includes("--json");
if (jsonOutput) {
  console.log(
    JSON.stringify(
      {
        ok: findings.length === 0,
        verifyGates: verifyChain.length,
        ciSteps: ciRuns.length,
        findings,
      },
      null,
      2
    )
  );
} else if (findings.length > 0) {
  console.error(`CI parity drift: ${findings.length} finding(s)`);
  for (const f of findings) {
    console.error(`  [${f.kind}] ${f.where}: ${f.detail}`);
  }
} else {
  console.log(`CI parity: OK — all ${verifyChain.length} verify gates reachable from ci.yml`);
}
process.exit(findings.length === 0 ? 0 : 1);
