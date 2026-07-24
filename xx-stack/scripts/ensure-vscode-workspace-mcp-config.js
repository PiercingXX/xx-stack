#!/usr/bin/env node

const fs = require("fs");

const installedPath = process.env.INSTALLED_MCP_PATH;
const workspacePath = process.env.WORKSPACE_MCP_PATH;

if (!installedPath || !workspacePath) {
  console.error("missing INSTALLED_MCP_PATH or WORKSPACE_MCP_PATH");
  process.exit(1);
}

const serverConfig = {
  type: "stdio",
  command: "node",
  args: ["${workspaceFolder}/mcp-server/dist/index.js"],
};

function ensureFile(path) {
  let doc = {};
  if (fs.existsSync(path)) {
    try {
      doc = JSON.parse(fs.readFileSync(path, "utf8"));
    } catch {
      doc = {};
    }
  }

  if (!doc || typeof doc !== "object") {
    doc = {};
  }
  if (!doc.servers || typeof doc.servers !== "object") {
    doc.servers = {};
  }

  doc.servers["xx-stack-platform-routing"] = {
    ...(doc.servers["xx-stack-platform-routing"] || {}),
    ...serverConfig,
  };

  fs.writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
}

ensureFile(installedPath);
ensureFile(workspacePath);
console.log(`  ensured VS Code MCP workspace configs: ${installedPath} and ${workspacePath}`);
