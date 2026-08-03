#!/usr/bin/env node
/**
 * Drift check for the nano-tier variants of the critical workflow surface.
 *
 * The five critical surfaces (see runtime/SKILLS.md "Graceful Degradation")
 * each ship a derived nano tier for tight-context lanes:
 *
 *   agents: runtime/agents/<name>.md          -> runtime/agents/<name>.nano.md
 *   skills: runtime/skills/<name>/SKILL.md    -> runtime/skills/<name>/SKILL.nano.md
 *
 * The canonical file is the source of truth; the nano is decision rules and
 * gates only and must never contradict it. This script fails CI when:
 *   1. a nano file is missing;
 *   2. a nano file is 2048 bytes or larger (nano = ~1-2KB by contract);
 *   3. the canonical file changed without a nano review: the pinned
 *      CANONICAL_SHA256 forces every canonical edit to arrive together with a
 *      re-derived (or re-confirmed) nano and a refreshed hash;
 *   4. the opencode-orchestration mirror of a nano is missing or not
 *      byte-identical to the canonical nano (nanos carry no host-specific
 *      content, so mirrors are exact copies).
 *
 * Refresh a pin after reviewing the nano against the canonical edit:
 *   sha256sum xx-stack/runtime/agents/<name>.md   (or the SKILL.md path)
 *
 * Exit 0 = nano tiers aligned. Exit 1 = drift found.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const componentRoot = path.resolve(scriptsDir, "..");
const repoRoot = path.resolve(componentRoot, "..");
const opencodeRoot = path.join(repoRoot, "opencode-orchestration", "opencode");

const NANO_MAX_BYTES = 2048;

// Any change to a canonical file below must re-derive or re-confirm its nano
// and update the pinned hash in the same commit.
const SURFACES = [
  {
    id: "execution-orchestrator",
    kind: "agent",
    canonical: "runtime/agents/execution-orchestrator.md",
    nano: "runtime/agents/execution-orchestrator.nano.md",
    mirrorNano: "agents/execution-orchestrator.nano.md",
    canonicalSha256: "45ffbfa5453fb0521374cc009992135ab08701539649f402db34c4c15f092078",
  },
  {
    id: "fast-build",
    kind: "agent",
    canonical: "runtime/agents/fast-build.md",
    nano: "runtime/agents/fast-build.nano.md",
    mirrorNano: "agents/fast-build.nano.md",
    canonicalSha256: "3cdd14e2536e949b07884158a4daec9e82e57363c11a627440734285bbbc2ae2",
  },
  {
    id: "review-code",
    kind: "skill",
    canonical: "runtime/skills/review-code/SKILL.md",
    nano: "runtime/skills/review-code/SKILL.nano.md",
    mirrorNano: "skills/review-code/SKILL.nano.md",
    canonicalSha256: "86e1fae85fdbc6e3ee0cadbc54314bb756f48b4b3618bcccc6df9268abd5cd86",
  },
  {
    id: "debug-investigate",
    kind: "skill",
    canonical: "runtime/skills/debug-investigate/SKILL.md",
    nano: "runtime/skills/debug-investigate/SKILL.nano.md",
    mirrorNano: "skills/debug-investigate/SKILL.nano.md",
    canonicalSha256: "c6dc46d9e10fc0552d7196eaf433490aa85d36efd7d4805b74ddd5d5a3f520de",
  },
  {
    id: "deploy-ship",
    kind: "skill",
    canonical: "runtime/skills/deploy-ship/SKILL.md",
    nano: "runtime/skills/deploy-ship/SKILL.nano.md",
    mirrorNano: "skills/deploy-ship/SKILL.nano.md",
    canonicalSha256: "5f0012e212e7ca0e389ba70702028ce6aac22a239ec2f441fcefa4af711742f8",
  },
];

const failures = [];
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

for (const surface of SURFACES) {
  const canonicalAbs = path.join(componentRoot, surface.canonical);
  const nanoAbs = path.join(componentRoot, surface.nano);

  // 1) Canonical file exists and matches the pinned hash.
  if (!fs.existsSync(canonicalAbs)) {
    failures.push(`${surface.id}: canonical file missing: ${surface.canonical}`);
  } else {
    const actual = sha256(fs.readFileSync(canonicalAbs));
    if (actual !== surface.canonicalSha256) {
      failures.push(
        `${surface.id}: canonical file changed (sha256 ${actual}).\n` +
          `      Review ${surface.nano} against the edit (the nano must never\n` +
          `      contradict the canonical file), then pin the new hash in\n` +
          `      scripts/check-nano-tiers.mjs.`
      );
    }
  }

  // 2) Nano exists and honors the size contract.
  if (!fs.existsSync(nanoAbs)) {
    failures.push(`${surface.id}: nano tier missing: ${surface.nano}`);
    continue;
  }
  const nanoBuf = fs.readFileSync(nanoAbs);
  if (nanoBuf.length >= NANO_MAX_BYTES) {
    failures.push(
      `${surface.id}: nano is ${nanoBuf.length} bytes (must stay under ${NANO_MAX_BYTES}): ${surface.nano}`
    );
  }

  // 3) Mirror parity (skipped when this component is checked out standalone).
  if (fs.existsSync(opencodeRoot)) {
    const mirrorAbs = path.join(opencodeRoot, surface.mirrorNano);
    if (!fs.existsSync(mirrorAbs)) {
      failures.push(
        `${surface.id}: opencode nano mirror missing: opencode-orchestration/opencode/${surface.mirrorNano}`
      );
    } else if (!nanoBuf.equals(fs.readFileSync(mirrorAbs))) {
      failures.push(
        `${surface.id}: opencode nano mirror differs from canonical nano.\n` +
          `      Nanos carry no host-specific content — copy ${surface.nano}\n` +
          `      over opencode-orchestration/opencode/${surface.mirrorNano}.`
      );
    }
  }
}

console.log("nano-tier drift check");
console.log("");
console.log(`  surfaces: ${SURFACES.length} (2 agents, 3 skills)`);
console.log(`  size cap: < ${NANO_MAX_BYTES} bytes`);
console.log("");

if (failures.length === 0) {
  console.log("PASS  nanos present, under size cap, canonical hashes pinned, mirrors identical.");
} else {
  for (const failure of failures) {
    console.log(`FAIL  ${failure}`);
  }
  console.log("");
  console.log(`${failures.length} nano-tier failure(s).`);
}

process.exitCode = failures.length === 0 ? 0 : 1;
