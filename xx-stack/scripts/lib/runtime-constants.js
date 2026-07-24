const fs = require("fs");
const path = require("path");

// Resolved relative to this module so the scripts directory can be shared
// between components. `runtime/` is the canonical xx-stack config directory;
// `opencode/` is the standalone opencode-orchestration layout, kept as a
// fallback. Keep this list in sync with mcp-server/src/runtime_constants.ts.
const CONSTANTS_CANDIDATES = ["runtime", "opencode"].map((dir) =>
  path.resolve(__dirname, "..", "..", dir, "runtime-constants.json")
);

const constantsPath = CONSTANTS_CANDIDATES.find((candidate) => fs.existsSync(candidate));

if (!constantsPath) {
  throw new Error(
    "xx-stack: runtime-constants.json not found. Looked in:\n  " +
      CONSTANTS_CANDIDATES.join("\n  ") +
      "\nExpected a sibling runtime/ (or opencode/) directory next to scripts/."
  );
}

const runtimeConstants = Object.freeze(JSON.parse(fs.readFileSync(constantsPath, "utf8")));

module.exports = Object.freeze({
  runtimeConstants,
  TIER_IDS: Object.freeze(runtimeConstants.tiers),
  HOST_IDS: Object.freeze(runtimeConstants.hosts),
  PROVIDER_IDS: Object.freeze(runtimeConstants.providers),
  NETWORK_SCOPES: Object.freeze(runtimeConstants.networkScopes),
  PATH_CONSTANTS: Object.freeze(runtimeConstants.paths),
});
