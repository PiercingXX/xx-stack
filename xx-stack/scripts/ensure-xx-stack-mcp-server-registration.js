#!/usr/bin/env node

const fs = require("fs");

const targetConfigPath = process.env.TARGET_CONFIG;
const mcpEntrypoint = process.env.MCP_ENTRYPOINT;

if (!targetConfigPath || !mcpEntrypoint) {
  console.error("missing TARGET_CONFIG or MCP_ENTRYPOINT");
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

const config = JSON.parse(fs.readFileSync(targetConfigPath, "utf8"));

config.mcp = config.mcp && typeof config.mcp === "object" ? config.mcp : {};

const existingEntry = config.mcp["xx-stack-platform-routing"];
const mergedEntry = existingEntry && typeof existingEntry === "object" ? { ...existingEntry } : {};
mergedEntry.type = "local";
mergedEntry.enabled = true;
mergedEntry.command = ["node", mcpEntrypoint];
if (Object.prototype.hasOwnProperty.call(mergedEntry, "disable")) {
  delete mergedEntry.disable;
}
config.mcp["xx-stack-platform-routing"] = mergedEntry;

if (Object.prototype.hasOwnProperty.call(config, "mcpServers")) {
  delete config.mcpServers;
}

writeFileAtomic(targetConfigPath, `${JSON.stringify(config, null, 2)}\n`);
console.log("  ensured MCP server registration: xx-stack-platform-routing");
