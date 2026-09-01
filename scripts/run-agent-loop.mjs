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
  process.stdout.write(
    `Usage:\n  node scripts/run-agent-loop.mjs --runner '<command>' --todo TODO.md [options]\n\nOptions:\n  --runner <command>            Shell command that reads prompt text from stdin and writes agent output to stdout.\n  --runner-timeout-ms <n>       Timeout per runner invocation. Defaults to 900000.\n  --runner-preflight <command>  Optional validation command. Defaults to --runner when preflight is enabled.\n  --preflight-input <text>      Optional small prompt sent to the preflight command before iteration 1.\n  --preflight-success <text>    Required substring expected in preflight output when preflight is enabled.\n  --preflight-timeout-ms <n>    Timeout for preflight execution. Defaults to 45000.\n  --todo <path>                 Todo or implementation plan file to execute end-to-end.\n  --goal <text>                 Optional explicit goal statement.\n  --cwd <path>                  Working directory for the loop. Defaults to current directory.\n  --state-dir <path>            Directory for loop state and logs. Defaults to .xx-stack/loops/<todo-name>.\n  --contract <path>             Path to active completion contract file. Defaults inside the state dir.\n  --prompt-template <path>      Prompt template file. Defaults to runtime/AUTONOMOUS_TODO_LOOP_PROMPT.md.\n  --max-iterations <n>          Maximum loop iterations. Defaults to 50.\n  --max-stalled <n>             Consecutive no-progress iterations before stopping. Defaults to 3.\n  --generation-size <n>         Optional. Close a generation every N iterations (and on <loop-state>GENERATION_CLOSE</loop-state>). Off by default.\n  --completion-promise <text>   Success marker. Defaults to <promise>DONE</promise>.\n  --agent <name>                Agent name inserted into the prompt. Defaults to execution-orchestrator.\n  --help                        Show this help.\n`
  );
}

function fail(message, exitCode = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

function slugify(value) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "loop"
  );
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

function generationDir(stateDir, index) {
  return join(stateDir, "generations", `gen_${index}`);
}

function generationBoundaryPath(stateDir, index) {
  return join(generationDir(stateDir, index), "generation_boundary.json");
}

function buildGenerationContext(manifest, stateDir, repoRoot) {
  if (manifest.generationIndex === undefined || manifest.generationIndex === null) {
    return "";
  }
  const index = Number(manifest.generationIndex);
  const previous =
    index > 0 ? toDisplayPath(repoRoot, generationBoundaryPath(stateDir, index - 1)) : "none";
  const lines = [
    "## Generation",
    "",
    `- index: ${index}`,
    `- opened-at: ${manifest.generationOpenedAt ?? "unknown"}`,
    `- status: ${manifest.generationStatus ?? "open"}`,
    `- previous-boundary: ${previous}`,
    "- After close, call generation_close if MCP finding tools exist. Late evidence cannot rewrite a closed generation.",
    "- Emit <loop-state>GENERATION_CLOSE</loop-state> to commit this generation without ending the loop.",
    "",
  ];
  if (manifest.generationSize) {
    lines.splice(
      6,
      0,
      `- close-every: ${manifest.generationSize} iterations (or GENERATION_CLOSE)`
    );
  }
  return `${lines.join("\n")}\n`;
}

async function writeGenerationBoundary(stateDir, manifest, nowIso) {
  const index = Number(manifest.generationIndex ?? 0);
  const path = generationBoundaryPath(stateDir, index);
  const payload = {
    generationIndex: index,
    status: "closed",
    openedAt: manifest.generationOpenedAt ?? manifest.createdAt,
    closedAt: nowIso,
    evidenceCutoffAt: nowIso,
    iterations: (manifest.history ?? [])
      .map((entry) => entry.iteration)
      .filter((iteration) => Number(iteration) >= Number(manifest.generationStartIteration ?? 1)),
    note: "Canonical findings live in the MCP finding store. This file is the loop's commit acknowledgement so resume cannot rewrite this generation.",
  };
  await writeJson(path, payload);
  return path;
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
      detached: true,
    });

    const killProcessTree = (signal) => {
      try {
        if (child.pid) {
          process.kill(-child.pid, signal);
        }
      } catch {
        try {
          child.kill(signal);
        } catch {
          // The process tree is already gone; nothing left to signal.
        }
      }
    };

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
        killProcessTree("SIGTERM");
        forceKillHandle = setTimeout(() => {
          killProcessTree("SIGKILL");
          // Orphaned grandchildren can hold the stdio pipes open forever, so
          // 'close' may never fire. Resolve on the deadline regardless.
          finish({
            code: 124,
            signal: "SIGKILL",
            stdout,
            stderr,
            timedOut,
          });
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
  // rev-parse pins the commit; status catches uncommitted edits, so an agent
  // editing files without touching TODO or the contract still counts as
  // progress. Outside a repo (or before the first commit) the status hash
  // alone still tracks file changes.
  const rev = await runProcess("git rev-parse HEAD", {
    cwd: repoRoot,
    input: "",
    shell: true,
  });
  const head = rev.code === 0 ? rev.stdout.trim() : null;

  const status = await runProcess("git status --short --untracked-files=all", {
    cwd: repoRoot,
    input: "",
    shell: true,
  });
  if (head === null && status.code !== 0) {
    return null;
  }

  return hashText(`${head ?? "no-head"}\n${status.stdout}`);
}

async function readManifest(manifestPath) {
  let raw;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(
      `Loop manifest exists but is not valid JSON: ${manifestPath}\n` +
        `Inspect the file and repair it by hand. Refusing to start a fresh session,\n` +
        `because that would reset the iteration history and re-run finished work.`
    );
  }

  if (!parsed || typeof parsed !== "object" || parsed.version !== MANIFEST_VERSION) {
    fail(
      `Loop manifest exists but fails version validation (expected version ${MANIFEST_VERSION}): ${manifestPath}\n` +
        `Inspect the file and repair or migrate it by hand. Refusing to start a fresh session,\n` +
        `because that would reset the iteration history and re-run finished work.`
    );
  }

  return parsed;
}

async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function writeOuterState(filePath, manifest, repoRoot) {
  const escalation =
    manifest.stalledIterations >= 2
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
    ...(manifest.generationIndex !== undefined && manifest.generationIndex !== null
      ? [`- generation: ${manifest.generationIndex} (${manifest.generationStatus ?? "open"})`]
      : []),
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
const contractPath = toAbsolute(
  repoRoot,
  args.contract ?? join(stateDir, "ACTIVE_COMPLETION_CONTRACT.md")
);
const outerStatePath = join(stateDir, "OUTER_LOOP_STATE.md");
const manifestPath = join(stateDir, "loop-manifest.json");
const logsDir = join(stateDir, "logs");
const agentName = args.agent ?? DEFAULT_AGENT;
const maxIterations = parsePositiveInt(args["max-iterations"], 50, "max-iterations");
const maxStalled = parsePositiveInt(args["max-stalled"], 3, "max-stalled");
const generationSize = args["generation-size"]
  ? parsePositiveInt(args["generation-size"], 0, "generation-size")
  : 0;
const runnerTimeoutMs = parsePositiveInt(args["runner-timeout-ms"], 900000, "runner-timeout-ms");
const completionPromise = args["completion-promise"] ?? DEFAULT_COMPLETION_PROMISE;
const preflightInput = args["preflight-input"];
const preflightSuccess = args["preflight-success"];
const preflightCommand = args["runner-preflight"] ?? runnerCommand;
const preflightTimeoutMs = parsePositiveInt(
  args["preflight-timeout-ms"],
  45000,
  "preflight-timeout-ms"
);
const goal =
  args.goal ??
  `Finish the entire todo plan in ${toDisplayPath(repoRoot, todoPath)} without stopping for intermediate progress updates.`;

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
if (generationSize > 0 && manifest.generationIndex === undefined) {
  manifest.generationIndex = 0;
  manifest.generationOpenedAt = new Date().toISOString();
  manifest.generationStartIteration = Number(manifest.iteration) + 1;
  manifest.generationStatus = "open";
}
if (generationSize > 0) {
  manifest.generationSize = generationSize;
}

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
  const preflightHealthy =
    preflightResult.code === 0 &&
    !preflightResult.timedOut &&
    preflightOutput.includes(preflightSuccess);

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
    process.stderr.write(
      `[loop] runner preflight failed. See ${toDisplayPath(repoRoot, outerStatePath)}\n`
    );
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
    GENERATION_CONTEXT: buildGenerationContext(manifest, stateDir, repoRoot),
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

  let progressDetected =
    preSnapshot.todoHash !== postSnapshot.todoHash ||
    preSnapshot.contractHash !== postSnapshot.contractHash ||
    preSnapshot.workspaceHash !== postSnapshot.workspaceHash;

  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  const loopState = extractLoopState(combinedOutput) ?? "CONTINUE";
  const completed = combinedOutput.includes(completionPromise);
  if (loopState === "GENERATION_CLOSE") {
    progressDetected = true;
  }

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

  const iterationsInGen = iteration - Number(manifest.generationStartIteration ?? 1) + 1;
  const sizeHit =
    generationSize > 0 && iterationsInGen > 0 && iterationsInGen % generationSize === 0;
  const shouldCloseGeneration =
    !completed && loopState !== "BLOCKED" && (loopState === "GENERATION_CLOSE" || sizeHit);

  if (shouldCloseGeneration) {
    const nowIso = new Date().toISOString();
    if (manifest.generationIndex === undefined) {
      manifest.generationIndex = 0;
      manifest.generationOpenedAt = manifest.createdAt;
      manifest.generationStartIteration = 1;
    }
    const boundaryPath = await writeGenerationBoundary(stateDir, manifest, nowIso);
    manifest.generationStatus = "closed";
    manifest.generationIndex = Number(manifest.generationIndex) + 1;
    manifest.generationOpenedAt = nowIso;
    manifest.generationStartIteration = iteration + 1;
    manifest.generationStatus = "open";
    process.stdout.write(
      `[loop] generation closed. Boundary: ${toDisplayPath(repoRoot, boundaryPath)}\n`
    );
  }

  await writeJson(manifestPath, manifest);
  await writeOuterState(outerStatePath, manifest, repoRoot);

  process.stdout.write(
    `[loop] outcome=${completed ? "DONE" : loopState} exit=${result.code} timeout=${result.timedOut ? "yes" : "no"} progress=${progressDetected ? "yes" : "no"}\n`
  );

  if (completed) {
    process.stdout.write(
      `[loop] success after ${iteration} iteration(s). Logs: ${toDisplayPath(repoRoot, logsDir)}\n`
    );
    process.exit(0);
  }

  if (loopState === "BLOCKED") {
    process.stderr.write(
      `[loop] blocked after ${iteration} iteration(s). See ${toDisplayPath(repoRoot, outerStatePath)}\n`
    );
    process.exit(2);
  }

  if (manifest.stalledIterations >= maxStalled) {
    process.stderr.write(
      `[loop] stalled for ${manifest.stalledIterations} consecutive iteration(s). See ${toDisplayPath(repoRoot, outerStatePath)}\n`
    );
    process.exit(3);
  }
}

process.stderr.write(
  `[loop] reached max iterations without completion. See ${toDisplayPath(repoRoot, outerStatePath)}\n`
);
process.exit(4);
