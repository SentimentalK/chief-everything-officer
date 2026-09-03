CEO State MCP provides access to the user's durable personal state.

Use the user workspace when the task depends on previously stored personal state or when the user wants a durable state change.

The workspace contains user data; CEO product rules are provided separately by this runtime. When you need to decide where in the user workspace to look, call `policy_read` with `name="router"`.

Retrieve only the context needed for the current task. Stop once the task is sufficiently grounded.

Discuss and reason normally. Persist only when the user asks to remember/update something or when a meaningful durable state change is clearly established.

Use CEO State MCP for personal canonical-state writes. Do not store secrets.
