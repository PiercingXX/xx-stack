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

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
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

function readExistingConfig(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const raw = fs.readFileSync(filePath, "utf8");
  // An empty file is "no config yet", same as a missing one.
  if (raw.trim().length === 0) {
    return {};
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    console.error(`existing MCP config is not valid JSON: ${filePath} (${error.message})`);
    console.error("Fix or remove the file by hand; refusing to overwrite it with a fresh config.");
    process.exit(1);
  }

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    console.error(`existing MCP config is not a JSON object: ${filePath}`);
    console.error("Fix or remove the file by hand; refusing to overwrite it with a fresh config.");
    process.exit(1);
  }

  return doc;
}

function ensureFile(filePath) {
  const doc = readExistingConfig(filePath);

  if (!doc.servers || typeof doc.servers !== "object" || Array.isArray(doc.servers)) {
    doc.servers = {};
  }

  doc.servers["xx-stack-platform-routing"] = {
    ...(doc.servers["xx-stack-platform-routing"] || {}),
    ...serverConfig,
  };

  if (fs.existsSync(filePath)) {
    const backupPath = `${filePath}.bak.${timestamp()}`;
    fs.copyFileSync(filePath, backupPath);
    console.log(`  backed up existing MCP config: ${backupPath}`);
  }

  writeFileAtomic(filePath, `${JSON.stringify(doc, null, 2)}\n`);
}

ensureFile(installedPath);
ensureFile(workspacePath);
console.log(`  ensured VS Code MCP workspace configs: ${installedPath} and ${workspacePath}`);
