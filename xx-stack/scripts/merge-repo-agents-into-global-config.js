#!/usr/bin/env node

const fs = require("fs");

const sourcePath = process.argv[2];
const targetPath = process.argv[3];

if (!sourcePath || !targetPath) {
  console.error("usage: merge-repo-agents-into-global-config.js <source_config> <target_config>");
  process.exit(1);
}

function writeFileAtomic(filePath, data) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, data);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }
}

const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const target = JSON.parse(fs.readFileSync(targetPath, "utf8"));

delete target.platformRegistry;

target.agent = target.agent || {};
source.agent = source.agent || {};

let added = 0;
let updated = 0;
let removed = 0;

for (const [name, agentDef] of Object.entries(source.agent)) {
  const existingAgent = target.agent[name] || {};
  if (!(name in target.agent)) {
    target.agent[name] = { ...agentDef };
    added += 1;
  } else {
    target.agent[name] = {
      ...existingAgent,
      ...agentDef,
      model: existingAgent.model || agentDef.model,
      permission: {
        ...(existingAgent.permission || {}),
        ...(agentDef.permission || {}),
      },
    };
    updated += 1;
  }

  if (
    name === "build" ||
    name === "plan" ||
    name === "fast-build" ||
    name === "execution-orchestrator" ||
    name === "parallel-execution-orchestrator"
  ) {
    target.agent[name].mode = "primary";
    delete target.agent[name].hidden;
    delete target.agent[name].disable;
  } else {
    target.agent[name].mode = "subagent";
    delete target.agent[name].hidden;
    delete target.agent[name].disable;
  }
}

for (const deprecatedAgent of ["plan-orchestrator"]) {
  if (deprecatedAgent in target.agent) {
    delete target.agent[deprecatedAgent];
    removed += 1;
  }
}

target.agent.general = {
  ...(target.agent.general || {}),
  mode: "subagent",
  disable: true,
};

target.agent.explore = {
  ...(target.agent.explore || {}),
  mode: "subagent",
  disable: true,
};

writeFileAtomic(targetPath, `${JSON.stringify(target, null, 2)}\n`);
console.log(
  `  merged agents into global config: ${added} added, ${updated} updated, ${removed} removed`
);
