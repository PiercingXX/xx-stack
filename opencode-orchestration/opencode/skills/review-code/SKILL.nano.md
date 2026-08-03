---
name: review-code
description: "Nano tier of review-code — decision rules and gates only, for tight-context lanes. Canonical: runtime/skills/review-code/SKILL.md."
---

# Code Review (nano)

Baseline gate: resolve the base ref to a fixed commit and require a non-empty `git diff <ref>...HEAD`. Empty diff -> stop; nothing to review. The baseline never moves mid-review; every finding cites it.

Severity ladder — classify every finding:

- S0 blocker: must fix before merge
- S1 high: fix in this PR unless explicitly deferred
- S2 medium: track as follow-up
- S3 low: optional

Two independent axes, reported separately, never blended or reranked: standards (repo conventions) and spec (implements the originating request). "Standards pass, spec fail" must stay visible.

Rules:

- Findings first; fix only when fixes were requested or the issue is trivial and unambiguous. Uncertain issues: list them and ask before fixing.
- Validate with deterministic repo-native checks; never claim tests or builds ran if the repo does not expose them.
- Coverage: for a fixed requested set, report reviewed N/N or name exactly what was skipped and why. Never sample as if coverage were complete.

Merge gate: any S0 -> Not ready. More than two S1 -> Not ready. Deterministic validation failing -> Not ready. Otherwise -> Ready with notes.

Report integrity: the review is returned verbatim — a relaying agent must not rewrite, rerank, summarize, or soften it. Review prompts stay neutral; scope stays broad.

Err toward flagging: false positives are cheaper than production bugs.
