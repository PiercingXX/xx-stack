import { buildHarnessReport, writeHarnessLog } from "./reliability_harness_runtime.js";
import { runHarnessScenarios } from "./reliability_harness_scenarios.js";

async function runHarness(): Promise<void> {
  const results = await runHarnessScenarios();
  const logPath = await writeHarnessLog(results);
  const { report, exitCode } = buildHarnessReport(results, logPath);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(exitCode);
}

runHarness().catch((error) => {
  process.stderr.write(String(error) + "\n");
  process.exit(1);
});
