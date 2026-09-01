import test from "node:test";
import assert from "node:assert/strict";

import { parseRuntimeConstants, PATH_CONSTANTS } from "./runtime_constants.js";

test("a malformed runtime-constants file names the file and the parser's complaint", () => {
  const sourcePath = "/opt/runtime/runtime-constants.json";
  let rawMessage = "";
  try {
    JSON.parse("definitely not json");
  } catch (error) {
    rawMessage = error instanceof Error ? error.message : String(error);
  }

  assert.throws(
    () => parseRuntimeConstants("definitely not json", sourcePath),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(sourcePath)) return false;
      if (!message.includes(rawMessage)) return false;
      assert.ok(
        !message.includes("Looked in"),
        "this is a parse failure, not the not-found diagnostic"
      );
      return true;
    }
  );
});

test("valid runtime constants still parse unchanged", () => {
  const parsed = parseRuntimeConstants(
    JSON.stringify({ tiers: { local: "local" }, paths: PATH_CONSTANTS }),
    "/tmp/whatever.json"
  );
  assert.equal(parsed.tiers.local, "local");
});
