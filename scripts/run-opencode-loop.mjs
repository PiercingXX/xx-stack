#!/usr/bin/env node

import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_AGENT = "execution-orchestrator";
const DEFAULT_PREFLIGHT_AGENT = "ping";
const DEFAULT_PREFLIGHT_INPUT = "Run the OpenCode transport preflight.";
const DEFAULT_PREFLIGHT_SUCCESS = "OPENCODE_PREFLIGHT_OK";

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "loop";
}

function usage() {
  process.stdout.write(`Usage:\n  node scripts/run-opencode-loop.mjs --todo TODO.md [options]\n\nOptions:\n  --todo <path>                     Required todo or plan file.\n  --goal <text>                     Optional explicit goal statement.\n  --cwd <path>                      Working directory for the loop. Defaults to current directory.\n  --state-dir <path>                Optional loop state directory.\n  --contract <path>                 Optional completion contract path.\n  --prompt-template <path>          Optional prompt template path.\n  --max-iterations <n>              Optional max iteration override.\n  --max-stalled <n>                 Optional max stalled override.\n  --completion-promise <text>       Optional completion promise override.\n  --agent <name>                    OpenCode worker agent. Defaults to execution-orchestrator.\n  --preflight-agent <name>          OpenCode health probe agent. Defaults to ping.\n  --model <provider/model>          Optional model override applied to runner and preflight.\n  --variant <value>                 Optional model variant for runner and preflight.\n  --runner-timeout-ms <n>           Per-iteration runner timeout. Defaults to run-agent-loop default.\n  --preflight-timeout-ms <n>        Preflight timeout. Defaults to run-agent-loop default.\n  --opencode-bin <path>             OpenCode executable. Defaults to opencode.\n  --host-config <path>              Source OpenCode config.json used to copy provider definitions. Defaults to $HOME/.config/opencode/config.json.\n  --isolated-home <path>            Optional job-scoped HOME root. Defaults to <state-dir>/opencode-home.\n  --use-live-home                   Use the current host HOME/config directly instead of building an isolated runtime.\n  --print-logs                      Forward OpenCode logs to stderr.\n  --pure                            Run OpenCode without external plugins.\n  --thinking                        Show thinking blocks.\n  --dangerously-skip-permissions    Auto-approve non-denied permissions.\n  --dry-run                         Print the generated loop wiring as JSON and exit.\n  --help                            Show this help.\n`);
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
    if (["--dry-run", "--print-logs", "--pure", "--thinking", "--dangerously-skip-permissions", "--use-live-home"].includes(arg)) {
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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf-8"));
}

async function buildIsolatedRuntime({
  stackRoot,
  isolatedHome,
  sourceConfigPath,
}) {
  const runtimeConfigPath = resolve(stackRoot, "runtime", "config.json");
  const runtimeAgentsDir = resolve(stackRoot, "runtime", "agents");
  const targetConfigDir = join(isolatedHome, ".config", "opencode");
  const targetAgentsDir = join(targetConfigDir, "agents");
  const targetConfigPath = join(targetConfigDir, "config.json");

  const [hostConfig, runtimeConfig] = await Promise.all([
    readJson(sourceConfigPath),
    readJson(runtimeConfigPath),
  ]);

  if (!hostConfig.provider || typeof hostConfig.provider !== "object") {
    fail(`Host config is missing provider definitions: ${sourceConfigPath}`);
  }

  const nextConfig = {
    $schema: typeof hostConfig.$schema === "string"
      ? hostConfig.$schema
      : (typeof runtimeConfig.$schema === "string" ? runtimeConfig.$schema : undefined),
    provider: hostConfig.provider,
    agent: runtimeConfig.agent,
    permission: runtimeConfig.permission,
  };

  await mkdir(targetAgentsDir, { recursive: true });
  const runtimeAgentFiles = await readdir(runtimeAgentsDir);
  await Promise.all(runtimeAgentFiles
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => copyFile(join(runtimeAgentsDir, entry), join(targetAgentsDir, entry))));
  await writeFile(targetConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf-8");

  return {
    isolatedHome,
    configPath: targetConfigPath,
  };
}

function buildRunnerCommand(helperPath, options) {
  const parts = [process.execPath, helperPath, "--agent", options.agent];
  if (options.binary) {
    parts.push("--binary", options.binary);
  }
  if (options.model) {
    parts.push("--model", options.model);
  }
  if (options.dir) {
    parts.push("--dir", options.dir);
  }
  if (options.variant) {
    parts.push("--variant", options.variant);
  }
  if (options.printLogs) {
    parts.push("--print-logs");
  }
  if (options.pure) {
    parts.push("--pure");
  }
  if (options.thinking) {
    parts.push("--thinking");
  }
  if (options.skipPermissions) {
    parts.push("--dangerously-skip-permissions");
  }
  return parts.map(shellQuote).join(" ");
}

function buildPreflightCommand(helperPath, options) {
  const parts = [
    process.execPath,
    helperPath,
    "--ping-agent",
    options.pingAgent,
    "--worker-agent",
    options.workerAgent,
    "--probe-dir",
    options.probeDir,
  ];
  if (options.binary) {
    parts.push("--binary", options.binary);
  }
  if (options.model) {
    parts.push("--model", options.model);
  }
  if (options.dir) {
    parts.push("--dir", options.dir);
  }
  if (options.variant) {
    parts.push("--variant", options.variant);
  }
  if (options.printLogs) {
    parts.push("--print-logs");
  }
  if (options.pure) {
    parts.push("--pure");
  }
  if (options.thinking) {
    parts.push("--thinking");
  }
  if (options.skipPermissions) {
    parts.push("--dangerously-skip-permissions");
  }
  return parts.map(shellQuote).join(" ");
}

const args = parseArgs(process.argv.slice(2));
if (!args.todo) {
  fail("Missing required --todo option.");
}

const stackRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const loopScriptPath = resolve(stackRoot, "scripts", "run-agent-loop.mjs");
const helperPath = resolve(stackRoot, "scripts", "opencode-stdin-runner.mjs");
const preflightHelperPath = resolve(stackRoot, "scripts", "opencode-preflight.mjs");
const cwd = resolve(args.cwd ?? process.cwd());
const todoPath = resolve(cwd, args.todo);
const defaultStateDir = join(cwd, ".xx-stack", "loops", slugify(basename(todoPath)));
const stateDir = resolve(args["state-dir"] ?? defaultStateDir);
const opencodeBin = args["opencode-bin"] ?? "opencode";
const agent = args.agent ?? DEFAULT_AGENT;
const preflightAgent = args["preflight-agent"] ?? DEFAULT_PREFLIGHT_AGENT;
const useLiveHome = Boolean(args["use-live-home"]);
const sourceConfigPath = resolve(args["host-config"] ?? join(process.env.HOME ?? "", ".config", "opencode", "config.json"));
const isolatedHome = resolve(args["isolated-home"] ?? join(stateDir, "opencode-home"));

let isolatedRuntime = null;
if (!useLiveHome) {
  isolatedRuntime = await buildIsolatedRuntime({
    stackRoot,
    isolatedHome,
    sourceConfigPath,
  });
}

const runnerCommand = buildRunnerCommand(helperPath, {
  agent,
  binary: opencodeBin,
  model: args.model,
  dir: cwd,
  variant: args.variant,
  printLogs: Boolean(args["print-logs"]),
  pure: Boolean(args.pure),
  thinking: Boolean(args.thinking),
  skipPermissions: Boolean(args["dangerously-skip-permissions"]),
});

const preflightCommand = buildPreflightCommand(preflightHelperPath, {
  pingAgent: preflightAgent,
  workerAgent: agent,
  binary: opencodeBin,
  model: args.model,
  dir: cwd,
  probeDir: stateDir,
  variant: args.variant,
  printLogs: Boolean(args["print-logs"]),
  pure: Boolean(args.pure),
  thinking: Boolean(args.thinking),
  skipPermissions: Boolean(args["dangerously-skip-permissions"]),
});

const loopArgs = [
  loopScriptPath,
  "--runner",
  runnerCommand,
  "--runner-preflight",
  preflightCommand,
  "--preflight-input",
  DEFAULT_PREFLIGHT_INPUT,
  "--preflight-success",
  DEFAULT_PREFLIGHT_SUCCESS,
  "--todo",
  args.todo,
  "--cwd",
  cwd,
];

for (const [flag, value] of [
  ["goal", args.goal],
  ["state-dir", args["state-dir"]],
  ["contract", args.contract],
  ["prompt-template", args["prompt-template"]],
  ["max-iterations", args["max-iterations"]],
  ["max-stalled", args["max-stalled"]],
  ["completion-promise", args["completion-promise"]],
  ["runner-timeout-ms", args["runner-timeout-ms"]],
  ["preflight-timeout-ms", args["preflight-timeout-ms"]],
]) {
  if (typeof value === "string") {
    loopArgs.push(`--${flag}`, value);
  }
}

if (args["dry-run"]) {
  process.stdout.write(`${JSON.stringify({
    loopScriptPath,
    helperPath,
    runnerCommand,
    preflightCommand,
    useLiveHome,
    sourceConfigPath,
    isolatedRuntime,
    preflightInput: DEFAULT_PREFLIGHT_INPUT,
    preflightSuccess: DEFAULT_PREFLIGHT_SUCCESS,
    loopArgs,
  }, null, 2)}\n`);
  process.exit(0);
}

const childEnv = { ...process.env };
if (isolatedRuntime) {
  childEnv.HOME = isolatedRuntime.isolatedHome;
  childEnv.XDG_CONFIG_HOME = join(isolatedRuntime.isolatedHome, ".config");
  childEnv.XDG_DATA_HOME = join(isolatedRuntime.isolatedHome, ".local", "share");
  childEnv.XDG_STATE_HOME = join(isolatedRuntime.isolatedHome, ".local", "state");
  childEnv.XDG_CACHE_HOME = join(isolatedRuntime.isolatedHome, ".cache");
}

const child = spawn(process.execPath, loopArgs, {
  cwd,
  env: childEnv,
  stdio: "inherit",
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
