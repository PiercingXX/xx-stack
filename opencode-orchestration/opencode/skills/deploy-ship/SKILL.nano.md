---
name: deploy-ship
description: "Nano tier of deploy-ship — decision rules and gates only, for tight-context lanes. Canonical: runtime/skills/deploy-ship/SKILL.md."
---

# Ship to Production (nano)

Activation gate: first determine what this repository can actually ship. No application deploy surface -> the task is readiness and artifact verification; never invent a deploy path.

Pre-deploy gates:

- All deterministic gates for the target surface pass. No runtime test surface -> say so explicitly.
- No coverage or eval surface -> mark coverage unavailable; never fabricate a metric.
- Review the release diff (`git log`/`git diff` against the base) and confirm before proceeding.

Deploy rules:

- Run only push, PR, merge, publish, or deploy steps explicitly supported by the repo and requested by the user.
- "Pushed" is not "done". Done means the exact SHA is verified live: CI green for that SHA, deploy/publish promoted for that SHA, and the health endpoint or shipped artifact reports that SHA and is OK.
- If a newer push superseded yours before deploy, confirm it contains your change (`git merge-base --is-ancestor`) and track that SHA through the whole chain instead.

Post-deploy gate: watch error rate, P95 latency, throughput stability, and auth success for 15-30 minutes. Regression beyond threshold -> roll back via the repo's actual rollback or revert path.

Report honestly: successfully deployed / rollback needed / critical issue found — with the verification evidence for each claim.
