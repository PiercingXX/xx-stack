---
description: Release-readiness and deploy verification
agent: release-manager
---

Load the `deploy-ship` skill, then `ops-deploy-land` only if something is actually going out.

Do not invent CI, remotes, or production endpoints. Use what the repo has. Every gate is PASS, FAIL, or AMBIGUOUS with the command that produced it.
