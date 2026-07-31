# Implementation Plan (operator-authored, xx-stack task 3: edit-format qualification + verify_edit)

- [ ] inventory.schema.json gains editFormat and editFormatReliability enums; example inventories get unverified examples
  - verify: grep -q editFormatReliability inventory.schema.json
  - files: inventory.schema.json, inventory.example.json
- [ ] generate-registries.mjs propagates both fields; inventory:sync then inventory:check clean
  - verify: npm run inventory:check
  - files: xx-stack/scripts/generate-registries.mjs
- [ ] verify_edit tool through validateExecRequest, failing tail surfaced, named truncation cap, registered in index.ts
  - verify: grep -q verify_edit xx-stack/mcp-server/src/index.ts
  - files: xx-stack/mcp-server/src/verify_edit_tools.ts, xx-stack/mcp-server/src/index.ts
- [ ] Tests: enum rejection, failing command returns ok=false with tail, policy path used, truncation against real oversized output
  - verify: cd xx-stack/mcp-server && npx tsx --test src/verify_edit_tools.test.ts
  - files: xx-stack/mcp-server/src/verify_edit_tools.test.ts
- [ ] npm run verify green
  - verify: npm run verify
