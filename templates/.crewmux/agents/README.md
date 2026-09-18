One file per vendor CLI. `kind` picks how it is launched:

- `claude` — Claude Code UI; harness MCP injected with `--mcp-config`
- `codex` — Codex UI; harness MCP injected with `-c mcp_servers.harness.*`
- `custom` — anything else. It receives `HARNESS_MCP_URL`, `HARNESS_MCP_TOKEN`, `HARNESS_ROLE`,
  `HARNESS_SESSION_ID`, `HARNESS_SYSTEM_PROMPT` as env vars; wire them in with `command`/`args`.

```yaml
id: gemini
kind: custom
command: gemini
args: []
```

Permissions / bypass per vendor: see docs/usage.md §4 in the crewmux repo.
