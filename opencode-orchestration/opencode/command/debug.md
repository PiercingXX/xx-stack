---
description: Root-cause a failure from evidence, not guesses
---

Load the `debug-investigate` skill.

Reproduce or bound the failure first. Do not patch until you can name the failing seam and the evidence that points at it. If you change code, run `verify_edit` on the project's lint/test commands before claiming a fix.
