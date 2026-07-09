#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_COMPLETION_PROMISE = "<promise>DONE</promise>";
const DEFAULT_AGENT = "execution-orchestrator";
const MANIFEST_VERSION = 1;

function usage() {
  process.stdout.write(`Usage:\n  node scripts/run-agent-loop.mjs --runner '<command>' --todo TODO.md [options]\n\nOptions:\n  --runner <command>            Shell command that reads prompt text from stdin and writes agent output to stdout.\n  --runner-timeout-ms <n>       Timeout per runner invocation. Defaults to 900000.\n  --runner-preflight <command>  Optional validation command. Defaults to --runner when preflight is enabled.\n  --preflight-input <text>      Optional small prompt sent to the preflight command before iteration 1.\n  --preflight-success <text>    Required substring expected in preflight output when preflight is enabled.\n  --preflight-timeout-ms <n>    Timeout for preflight execution. Defaults to 45000.\n  --todo <path>                 Todo or implementation plan file to execute end-to-end.\n  --goal <text>                 Optional explicit goal statement.\n  --cwd <path>                  Working directory for the loop. Defaults to current directory.\n  --state-dir <path>            Directory for loop state and logs. Defaults to .xx-stack/loops/<todo-name>.\n  --contract <path>             Path to active completion contract file. Defaults inside the state dir.\n  --prompt-template <path>      Prompt template file. Defaults to runtime/AUTONOMOUS_TODO_LOOP_PROMPT.md.\n  --max-iterations <n>          Maximum loop iterations. Defaults to 50.\n  --max-stalled <n>             Consecutive no-progress iterations before stopping. Defaults to 3.\n  --completion-promise <text>   Success marker. Defaults to <promise>DONE</promise>.\n  --agent <name>                Agent name inserted into the prompt. Defaults to execution-orchestrator.\n  --help                        Show this help.\n`);
}

function fail(message, exitCode = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "loop";
}

function toAbsolute(baseDir, value) {
  return isAbsolute(value) ? resolve(value) : resolve(baseDir, value);
}

function toDisplayPath(repoRoot, filePath) {
  const rel = relative(repoRoot, filePath);
  return rel.length > 0 && !rel.startsWith("..") ? rel : filePath;
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(filePath) {
  try {
    const content = await readFile(filePath, "utf-8");
    return hashText(content);
  } catch {
    return null;
  }
}

function parsePositiveInt(raw, fallback, label) {
  if (typeof raw !== "string") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`Invalid ${label}: ${raw}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
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

function renderTemplate(template, values) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key) => {
    return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : "";
  });
}

function extractLoopState(output) {
  const match = output.match(/<loop-state>([^<]+)<\/loop-state>/i);
  return match ? match[1].trim().toUpperCase() : null;
}

function formatDurationMs(value) {
  return `${value}ms`;
}

function summarizeHistory(history, repoRoot) {
  if (!Array.isArray(history) || history.length === 0) {
    return ["No iterations have completed yet."];
  }
  const recent = history.slice(-5).reverse();
  return recent.flatMap((entry) => [
    `### Iteration ${entry.iteration}`,
    `- outcome: ${entry.outcome}`,
    `- exit-code: ${entry.exitCode}`,
    `- timed-out: ${entry.timedOut ? "yes" : "no"}`,
    `- progress-detected: ${entry.progressDetected ? "yes" : "no"}`,
    `- stdout-log: ${toDisplayPath(repoRoot, entry.stdoutPath)}`,
    `- stderr-log: ${toDisplayPath(repoRoot, entry.stderrPath)}`,
  ]);
}

function buildContractSeed(goal, todoDisplayPath) {
  return [
    "# Active Completion Contract",
    "",
    "## Loop Goal",
    "",
    `- ${goal}`,
    "",
    "## Todo Source Of Truth",
    "",
    `- ${todoDisplayPath}`,
    "",
    "## Current Slice",
    "",
    "- Not started yet",
    "",
    "## Done Condition",
    "",
    "- Every actionable todo item is complete and deterministically verified.",
    "- The todo file reflects the latest truth: completed work, new discoveries, and blockers.",
    "",
    "## Required Behavior",
    "",
    "- Update this contract before each implementation slice.",
    "- Record verification commands and evidence summaries here before claiming completion.",
    "- If blocked, write the blocker and next fallback action here before exiting the slice.",
    "",
  ].join("\n");
}

async function runProcess(command, { cwd, input, shell = false, timeoutMs }) {
  return new Promise((resolveProcess) => {
    let settled = false;
    let timedOut = false;
    let timeoutHandle = null;
    let forceKillHandle = null;
    const child = spawn(command, {
      cwd,
      shell,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.stdin.on("error", (error) => {
      if (error && error.code !== "EPIPE") {
        stderr += `${String(error)}\n`;
      }
    });

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (forceKillHandle) {
        clearTimeout(forceKillHandle);
      }
      resolveProcess(result);
    };

    child.on("error", (error) => {
      stderr += `${String(error)}\n`;
      finish({
        code: 1,
        signal: null,
        stdout,
        stderr,
        timedOut,
      });
    });

    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        stderr += `Process timed out after ${timeoutMs}ms\n`;
        child.kill("SIGTERM");
        forceKillHandle = setTimeout(() => {
          child.kill("SIGKILL");
        }, 5000);
        forceKillHandle.unref?.();
      }, timeoutMs);
      timeoutHandle.unref?.();
    }

    child.on("close", (code, signal) => {
      finish({
        code: timedOut ? 124 : (code ?? 0),
        signal: signal ?? null,
        stdout,
        stderr,
        timedOut,
      });
    });

    child.stdin.end(input);
  });
}

async function getGitWorkspaceFingerprint(repoRoot) {
  const head = await runProcess("git", {
    cwd: repoRoot,
    input: "",
    shell: false,
  });
  if (head.code !== 0) {
    return null;
  }

  const rev = await runProcess("git rev-parse HEAD", {
    cwd: repoRoot,
    input: "",
    shell: true,
  });
  if (rev.code !== 0) {
    return null;
  }

  const status = await runProcess("git status --short --untracked-files=all", {
    cwd: repoRoot,
    input: "",
    shell: true,
  });
  if (status.code !== 0) {
    return null;
  }

  return hashText(`${rev.stdout.trim()}\n${status.stdout}`);
}

async function readManifest(manifestPath) {
  try {
    const raw = await readFile(manifestPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.version === MANIFEST_VERSION) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function writeOuterState(filePath, manifest, repoRoot) {
  const escalation = manifest.stalledIterations >= 2
    ? "Decompose the current todo item into smaller verified substeps before further code edits."
    : "No escalation active.";
  const preflightSummary = manifest.preflight
    ? [
      "## Runner Health",
      "",
      `- status: ${manifest.preflight.healthy ? "passed" : "failed"}`,
      `- timeout: ${formatDurationMs(manifest.preflight.timeoutMs)}`,
      `- success-marker: ${manifest.preflight.successMarker}`,
      `- exit-code: ${manifest.preflight.exitCode}`,
      `- timed-out: ${manifest.preflight.timedOut ? "yes" : "no"}`,
      `- stdout-log: ${toDisplayPath(repoRoot, manifest.preflight.stdoutPath)}`,
      `- stderr-log: ${toDisplayPath(repoRoot, manifest.preflight.stderrPath)}`,
      "",
    ]
    : [];

  const lines = [
    "# Outer Loop State",
    "",
    `- session-id: ${manifest.sessionId}`,
    `- status: ${manifest.status}`,
    `- current-iteration: ${manifest.iteration}`,
    `- max-iterations: ${manifest.maxIterations}`,
    `- stalled-streak: ${manifest.stalledIterations}`,
    `- max-stalled: ${manifest.maxStalled}`,
    `- runner-timeout: ${formatDurationMs(manifest.runnerTimeoutMs)}`,
    `- todo: ${toDisplayPath(repoRoot, manifest.todoPath)}`,
    `- contract: ${toDisplayPath(repoRoot, manifest.contractPath)}`,
    `- completion-promise: ${manifest.completionPromise}`,
    "",
    ...preflightSummary,
    "## Escalation",
    "",
    `- ${escalation}`,
    "",
    "## Recent Iterations",
    "",
    ...summarizeHistory(manifest.history, repoRoot),
    "",
  ];

  await writeFile(filePath, `${lines.join("\n")}\n`, "utf-8");
}

async function ensureFile(filePath, content) {
  try {
    const fileInfo = await stat(filePath);
    if (fileInfo.isFile()) {
      return;
    }
  } catch {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
  }
}

const args = parseArgs(process.argv.slice(2));
const stackRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(args.cwd ?? process.cwd());
const todoArg = args.todo;
const runnerCommand = args.runner;

if (!runnerCommand) {
  fail("Missing required --runner option.");
}

if (!todoArg) {
  fail("Missing required --todo option.");
}

const todoPath = toAbsolute(repoRoot, todoArg);
const promptTemplatePath = args["prompt-template"]
  ? toAbsolute(repoRoot, args["prompt-template"])
  : resolve(stackRoot, "runtime", "AUTONOMOUS_TODO_LOOP_PROMPT.md");
const defaultStateDir = join(repoRoot, ".xx-stack", "loops", slugify(basename(todoPath)));
const stateDir = toAbsolute(repoRoot, args["state-dir"] ?? defaultStateDir);
const contractPath = toAbsolute(repoRoot, args.contract ?? join(stateDir, "ACTIVE_COMPLETION_CONTRACT.md"));
const outerStatePath = join(stateDir, "OUTER_LOOP_STATE.md");
const manifestPath = join(stateDir, "loop-manifest.json");
const logsDir = join(stateDir, "logs");
const agentName = args.agent ?? DEFAULT_AGENT;
const maxIterations = parsePositiveInt(args["max-iterations"], 50, "max-iterations");
const maxStalled = parsePositiveInt(args["max-stalled"], 3, "max-stalled");
const runnerTimeoutMs = parsePositiveInt(args["runner-timeout-ms"], 900000, "runner-timeout-ms");
const completionPromise = args["completion-promise"] ?? DEFAULT_COMPLETION_PROMISE;
const preflightInput = args["preflight-input"];
const preflightSuccess = args["preflight-success"];
const preflightCommand = args["runner-preflight"] ?? runnerCommand;
const preflightTimeoutMs = parsePositiveInt(args["preflight-timeout-ms"], 45000, "preflight-timeout-ms");
const goal = args.goal ?? `Finish the entire todo plan in ${toDisplayPath(repoRoot, todoPath)} without stopping for intermediate progress updates.`;

if ((preflightInput && !preflightSuccess) || (!preflightInput && preflightSuccess)) {
  fail("Preflight requires both --preflight-input and --preflight-success.");
}

if (args["runner-preflight"] && !preflightInput) {
  fail("--runner-preflight requires --preflight-input and --preflight-success.");
}

try {
  await stat(todoPath);
} catch {
  fail(`Todo file not found: ${todoPath}`);
}

let promptTemplate;
try {
  promptTemplate = await readFile(promptTemplatePath, "utf-8");
} catch {
  fail(`Prompt template not found: ${promptTemplatePath}`);
}

await mkdir(logsDir, { recursive: true });
await ensureFile(contractPath, buildContractSeed(goal, toDisplayPath(repoRoot, todoPath)));

const existingManifest = await readManifest(manifestPath);
const manifest = existingManifest ?? {
  version: MANIFEST_VERSION,
  sessionId: randomUUID(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: "running",
  iteration: 0,
  stalledIterations: 0,
  maxIterations,
  maxStalled,
  repoRoot,
  runnerCommand,
  runnerTimeoutMs,
  goal,
  agentName,
  completionPromise,
  todoPath,
  contractPath,
  promptTemplatePath,
  preflight: null,
  history: [],
};

manifest.status = "running";
manifest.maxIterations = maxIterations;
manifest.maxStalled = maxStalled;
manifest.runnerCommand = runnerCommand;
manifest.runnerTimeoutMs = runnerTimeoutMs;
manifest.goal = goal;
manifest.agentName = agentName;
manifest.completionPromise = completionPromise;
manifest.todoPath = todoPath;
manifest.contractPath = contractPath;
manifest.promptTemplatePath = promptTemplatePath;
manifest.updatedAt = new Date().toISOString();

await writeJson(manifestPath, manifest);
await writeOuterState(outerStatePath, manifest, repoRoot);

if (preflightInput) {
  const preflightStdoutPath = join(logsDir, "preflight-stdout.log");
  const preflightStderrPath = join(logsDir, "preflight-stderr.log");
  process.stdout.write(`[loop] runner preflight\n`);

  const preflightResult = await runProcess(preflightCommand, {
    cwd: repoRoot,
    input: preflightInput,
    shell: true,
    timeoutMs: preflightTimeoutMs,
  });

  await writeFile(preflightStdoutPath, preflightResult.stdout, "utf-8");
  await writeFile(preflightStderrPath, preflightResult.stderr, "utf-8");

  const preflightOutput = `${preflightResult.stdout}\n${preflightResult.stderr}`;
  const preflightHealthy = preflightResult.code === 0
    && !preflightResult.timedOut
    && preflightOutput.includes(preflightSuccess);

  manifest.preflight = {
    healthy: preflightHealthy,
    command: preflightCommand,
    timeoutMs: preflightTimeoutMs,
    successMarker: preflightSuccess,
    exitCode: preflightResult.code,
    signal: preflightResult.signal,
    timedOut: preflightResult.timedOut,
    stdoutPath: preflightStdoutPath,
    stderrPath: preflightStderrPath,
  };
  manifest.updatedAt = new Date().toISOString();

  if (!preflightHealthy) {
    manifest.status = "runner-unhealthy";
    await writeJson(manifestPath, manifest);
    await writeOuterState(outerStatePath, manifest, repoRoot);
    process.stderr.write(`[loop] runner preflight failed. See ${toDisplayPath(repoRoot, outerStatePath)}\n`);
    process.exit(5);
  }

  await writeJson(manifestPath, manifest);
  await writeOuterState(outerStatePath, manifest, repoRoot);
}

for (let iteration = Number(manifest.iteration) + 1; iteration <= maxIterations; iteration += 1) {
  const prefix = `iteration-${String(iteration).padStart(3, "0")}`;
  const promptPath = join(logsDir, `${prefix}-prompt.md`);
  const stdoutPath = join(logsDir, `${prefix}-stdout.log`);
  const stderrPath = join(logsDir, `${prefix}-stderr.log`);

  const preSnapshot = {
    todoHash: await hashFile(todoPath),
    contractHash: await hashFile(contractPath),
    workspaceHash: await getGitWorkspaceFingerprint(repoRoot),
  };

  const prompt = renderTemplate(promptTemplate, {
    AGENT_NAME: agentName,
    GOAL: goal,
    TODO_PATH: toDisplayPath(repoRoot, todoPath),
    CONTRACT_PATH: toDisplayPath(repoRoot, contractPath),
    OUTER_STATE_PATH: toDisplayPath(repoRoot, outerStatePath),
    ITERATION: iteration,
    MAX_ITERATIONS: maxIterations,
    STALLED_ITERATIONS: manifest.stalledIterations,
    MAX_STALLED: maxStalled,
    COMPLETION_PROMISE: completionPromise,
  });

  await writeFile(promptPath, prompt, "utf-8");
  process.stdout.write(`[loop] iteration ${iteration}/${maxIterations}\n`);

  const result = await runProcess(runnerCommand, {
    cwd: repoRoot,
    input: prompt,
    shell: true,
    timeoutMs: runnerTimeoutMs,
  });

  await writeFile(stdoutPath, result.stdout, "utf-8");
  await writeFile(stderrPath, result.stderr, "utf-8");

  const postSnapshot = {
    todoHash: await hashFile(todoPath),
    contractHash: await hashFile(contractPath),
    workspaceHash: await getGitWorkspaceFingerprint(repoRoot),
  };

  const progressDetected = preSnapshot.todoHash !== postSnapshot.todoHash
    || preSnapshot.contractHash !== postSnapshot.contractHash
    || preSnapshot.workspaceHash !== postSnapshot.workspaceHash;

  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  const loopState = extractLoopState(combinedOutput) ?? "CONTINUE";
  const completed = combinedOutput.includes(completionPromise);

  manifest.iteration = iteration;
  manifest.stalledIterations = progressDetected ? 0 : Number(manifest.stalledIterations) + 1;
  manifest.updatedAt = new Date().toISOString();
  manifest.history.push({
    iteration,
    outcome: completed ? "DONE" : loopState,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    progressDetected,
    promptPath,
    stdoutPath,
    stderrPath,
  });
  if (manifest.history.length > 20) {
    manifest.history = manifest.history.slice(-20);
  }

  if (completed) {
    manifest.status = "completed";
  } else if (loopState === "BLOCKED") {
    manifest.status = "blocked";
  } else if (manifest.stalledIterations >= maxStalled) {
    manifest.status = "stalled";
  } else if (iteration >= maxIterations) {
    manifest.status = "exhausted";
  } else {
    manifest.status = "running";
  }

  await writeJson(manifestPath, manifest);
  await writeOuterState(outerStatePath, manifest, repoRoot);

  process.stdout.write(`[loop] outcome=${completed ? "DONE" : loopState} exit=${result.code} timeout=${result.timedOut ? "yes" : "no"} progress=${progressDetected ? "yes" : "no"}\n`);

  if (completed) {
    process.stdout.write(`[loop] success after ${iteration} iteration(s). Logs: ${toDisplayPath(repoRoot, logsDir)}\n`);
    process.exit(0);
  }

  if (loopState === "BLOCKED") {
    process.stderr.write(`[loop] blocked after ${iteration} iteration(s). See ${toDisplayPath(repoRoot, outerStatePath)}\n`);
    process.exit(2);
  }

  if (manifest.stalledIterations >= maxStalled) {
    process.stderr.write(`[loop] stalled for ${manifest.stalledIterations} consecutive iteration(s). See ${toDisplayPath(repoRoot, outerStatePath)}\n`);
    process.exit(3);
  }
}

process.stderr.write(`[loop] reached max iterations without completion. See ${toDisplayPath(repoRoot, outerStatePath)}\n`);
process.exit(4);