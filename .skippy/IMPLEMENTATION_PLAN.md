# Implementation Plan

- [x] Add `editFormat` and `editFormatReliability` enum fields to `inventory.schema.json`
- [x] Add example `editFormat` and `editFormatReliability` fields (both `"unverified"`) to two models in `inventory.example.json`
- [x] Add example `editFormat` and `editFormatReliability` fields (both `"unverified"`) to two models in `inventory.json`
- [x] Propagate `editFormat` and `editFormatReliability` through `xx-stack/scripts/generate-registries.mjs`
- [x] Run `npm run inventory:sync && npm run inventory:check` to ensure no drift
- [x] Create `xx-stack/mcp-server/src/verify_edit_tools.ts` with `verify_edit` tool using `execution_policy.ts` and truncation to 4096 bytes
- [ ] Create `xx-stack/mcp-server/src/verify_edit_tools.test.ts` with tests for pass/fail/truncation/policy path
- [ ] Register `verify_edit` tool in `xx-stack/mcp-server/src/index.ts` via `registerVerifyEditTools(server, deps)`
- [ ] Run `npm run verify` to confirm all checks pass
