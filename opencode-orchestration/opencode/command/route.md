---
description: Decide which machine and model should run this work
---

Load the `orchestrate-platform-routing` skill.

Call `list_platforms` and `check_health` if the MCP server is connected. Then `route_task` with the user's description. Do not send work to cloud unless they opted in. Report the recommended tier, host, model, and the reason — then stop unless they asked you to execute.
