## What

<!-- One paragraph. Link the issue if there is one. -->

## Why

<!-- The invariant this preserves or the failure it closes. -->

## How checked

- [ ] `npm run verify` (or name the subset if the change cannot reach every gate)
- [ ] New behavior has a test or a gate that would fail without it
- [ ] Canonical `runtime/` edits have OpenCode mirrors (`npm run drift:check`)
- [ ] Inventory-derived files were regenerated if `inventory.json` / the generator changed
