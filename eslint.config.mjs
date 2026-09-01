import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import js from "@eslint/js";
import globals from "globals";

const tsRecommended = tsPlugin.configs.recommended;

export default [
  {
    ignores: [
      "dist/",
      "node_modules/",
      "coverage/",
      "**/dist/**",
      "**/node_modules/**",
      "opencode-orchestration/mcp-server/**",
      "opencode-orchestration/scripts/**",
      "opencode-orchestration/packs/**",
      "xx-stack/packs/**",
    ],
  },
  {
    files: ["xx-stack/mcp-server/src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        project: ["./tsconfig.json"],
      },
      globals: { ...globals.node },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...js.configs.recommended.rules,
      ...tsRecommended.rules,
      "@typescript-eslint/explicit-function-return-type": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-namespace": "off",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-undef": "off",
    },
  },
  {
    files: ["xx-stack/mcp-server/src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
  {
    files: [
      "xx-stack/mcp-server/src/monitor-memory.ts",
      "xx-stack/mcp-server/src/parallel-preflight.ts",
      "xx-stack/mcp-server/src/parallel-smoke.ts",
      "xx-stack/mcp-server/src/trace-provider-proxy.ts",
    ],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["xx-stack/scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-console": "off",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-shadow": "error",
    },
  },
  {
    files: ["xx-stack/scripts/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-console": "off",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-shadow": "error",
    },
  },
];
