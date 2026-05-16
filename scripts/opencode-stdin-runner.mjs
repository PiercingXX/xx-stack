#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";

function usage() {
  process.stdout.write(`Usage:\n  node scripts/opencode-stdin-runner.mjs --agent <name> [options]\n\nOptions:\n  --agent <name>                     Required OpenCode agent name.\n  --binary <path>                    OpenCode executable. Defaults to opencode.\n  --model <provider/model>           Optional model override.\n  --dir <path>                       Optional OpenCode working directory. Defaults to current cwd.\n  --format <default|json>            Optional output format.\n  --variant <value>                  Optional model variant.\n  --print-logs                       Forward OpenCode logs to stderr.\n  --pure                             Run without external plugins.\n  --thinking                         Show thinking blocks.\n  --dangerously-skip-permissions     Auto-approve non-denied permissions.\n  --help                             Show this help.\n`);
}

function fail(message, exitCode = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (["--print-logs", "--pure", "--thinking", "--dangerously-skip-permissions"].includes(arg)) {
      options[arg.slice(2)] = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      fail(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for --${key}`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

async function readStdin() {
  process.stdin.setEncoding("utf-8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

const args = parseArgs(process.argv.slice(2));
const agent = args.agent;
if (!agent) {
  fail("Missing required --agent option.");
}

const prompt = await readStdin();
if (!prompt) {
  fail("Expected prompt text on stdin.");
}

const binary = args.binary ?? "opencode";
const cwd = resolve(args.dir ?? process.cwd());
const commandArgs = ["run", "--agent", agent];

if (typeof args.model === "string") {
  commandArgs.push("--model", args.model);
}
if (typeof args.dir === "string") {
  commandArgs.push("--dir", cwd);
}
if (typeof args.format === "string") {
  commandArgs.push("--format", args.format);
}
if (typeof args.variant === "string") {
  commandArgs.push("--variant", args.variant);
}
for (const flag of ["print-logs", "pure", "thinking", "dangerously-skip-permissions"]) {
  if (args[flag]) {
    commandArgs.push(`--${flag}`);
  }
}
commandArgs.push(prompt);

const child = spawn(binary, commandArgs, {
  cwd,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

child.on("error", (error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});

child.on("close", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
