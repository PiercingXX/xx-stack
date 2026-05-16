#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PING_INPUT = "Respond with exactly PONG.";
const SUCCESS_MARKER = "OPENCODE_PREFLIGHT_OK";
const DEFAULT_PHASE_TIMEOUT_MS = 15000;

function usage() {
  process.stdout.write(`Usage:\n  node scripts/opencode-preflight.mjs --ping-agent <name> --worker-agent <name> [options]\n\nOptions:\n  --ping-agent <name>                Required liveness probe agent.\n  --worker-agent <name>              Required worker agent used for the tool-loop probe.\n  --binary <path>                    OpenCode executable. Defaults to opencode.\n  --model <provider/model>           Optional model override.\n  --dir <path>                       Optional OpenCode working directory. Defaults to current cwd.\n  --probe-dir <path>                 Directory used for the temporary tool-loop probe file. Defaults to current cwd.\n  --phase-timeout-ms <n>             Optional per-phase timeout. Defaults to 15000.\n  --variant <value>                  Optional model variant.\n  --print-logs                       Forward OpenCode logs to stderr.\n  --pure                             Run without external plugins.\n  --thinking                         Show thinking blocks.\n  --dangerously-skip-permissions     Auto-approve non-denied permissions.\n  --help                             Show this help.\n`);
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

function parsePositiveInt(value, fallback, label) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`Invalid --${label}: ${value}`);
  }
  return parsed;
}

async function readStdin() {
  process.stdin.setEncoding("utf-8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

function buildHelperArgs(helperPath, options) {
  const args = [helperPath, "--agent", options.agent];
  if (options.binary) {
    args.push("--binary", options.binary);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.dir) {
    args.push("--dir", options.dir);
  }
  if (options.variant) {
    args.push("--variant", options.variant);
  }
  for (const flag of ["print-logs", "pure", "thinking", "dangerously-skip-permissions"]) {
    if (options[flag]) {
      args.push(`--${flag}`);
    }
  }
  return args;
}

async function runProbe(helperPath, options) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, buildHelperArgs(helperPath, options), {
      cwd: options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({
        code: code ?? 0,
        signal,
        timedOut,
        stdout,
        stderr,
      });
    });

    child.stdin.end(options.prompt);
  });
}

const args = parseArgs(process.argv.slice(2));
const pingAgent = args["ping-agent"];
const workerAgent = args["worker-agent"];

if (!pingAgent) {
  fail("Missing required --ping-agent option.");
}
if (!workerAgent) {
  fail("Missing required --worker-agent option.");
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(scriptDir, "opencode-stdin-runner.mjs");
const cwd = resolve(args.dir ?? process.cwd());
const probeDir = resolve(args["probe-dir"] ?? cwd);
const pingPrompt = (await readStdin()).trim() || DEFAULT_PING_INPUT;
const probeMarker = `xx-stack-tool-loop-${randomUUID()}`;
const probePath = join(probeDir, `.opencode-tool-loop-probe-${process.pid}.txt`);
const phaseTimeoutMs = parsePositiveInt(args["phase-timeout-ms"], DEFAULT_PHASE_TIMEOUT_MS, "phase-timeout-ms");

await mkdir(probeDir, { recursive: true });
await writeFile(probePath, `${probeMarker}\n`, "utf-8");

try {
  const sharedOptions = {
    binary: args.binary ?? "opencode",
    model: args.model,
    cwd,
    dir: cwd,
    variant: args.variant,
    "print-logs": Boolean(args["print-logs"]),
    pure: Boolean(args.pure),
    thinking: Boolean(args.thinking),
    "dangerously-skip-permissions": Boolean(args["dangerously-skip-permissions"]),
  };

  const pingResult = await runProbe(helperPath, {
    ...sharedOptions,
    agent: pingAgent,
    prompt: pingPrompt,
    timeoutMs: phaseTimeoutMs,
  });

  if (pingResult.code !== 0 || pingResult.timedOut || !pingResult.stdout.includes("PONG")) {
    process.stderr.write(`PING_FAILED code=${pingResult.code} signal=${pingResult.signal ?? "none"} timedOut=${pingResult.timedOut ? "yes" : "no"}\n`);
    if (pingResult.stdout) {
      process.stderr.write(`--- ping stdout ---\n${pingResult.stdout}\n`);
    }
    if (pingResult.stderr) {
      process.stderr.write(`--- ping stderr ---\n${pingResult.stderr}\n`);
    }
    process.exit(10);
  }

  const toolPrompt = [
    `Use tools to read the file at ${probePath}.`,
    "Reply with the exact file contents and nothing else.",
    "Do not modify any files.",
  ].join("\n");

  const toolResult = await runProbe(helperPath, {
    ...sharedOptions,
    agent: workerAgent,
    prompt: toolPrompt,
    timeoutMs: phaseTimeoutMs,
  });

  const toolOutput = `${toolResult.stdout}\n${toolResult.stderr}`;
  if (toolResult.code !== 0 || toolResult.timedOut || !toolOutput.includes(probeMarker)) {
    process.stderr.write(`TOOL_LOOP_UNSUPPORTED agent=${workerAgent} code=${toolResult.code} signal=${toolResult.signal ?? "none"} timedOut=${toolResult.timedOut ? "yes" : "no"}\n`);
    process.stderr.write(`expected-marker=${probeMarker}\n`);
    if (toolResult.stdout) {
      process.stderr.write(`--- tool stdout ---\n${toolResult.stdout}\n`);
    }
    if (toolResult.stderr) {
      process.stderr.write(`--- tool stderr ---\n${toolResult.stderr}\n`);
    }
    process.exit(11);
  }

  process.stdout.write(`${SUCCESS_MARKER}\n`);
} finally {
  await rm(probePath, { force: true });
}