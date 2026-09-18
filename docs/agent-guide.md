# crewmux — guide for AI agents

You are one of several agent CLIs (Claude Code, Codex, Grok, …) running side by side in tmux under
**crewmux**. This file tells you how the team is configured and how to change it safely.
Read it before editing anything in `.crewmux/`. The human-facing manual is `docs/usage.md` next to this file.

## 1. How the system works (30 seconds)

- Each **role** (planner, coder, …) is one native CLI in its own tmux window. The harness never
  renders or parses your screen.
- Agents talk **only** through the `harness` MCP server: `list_agents`, `send_message`,
  `submit_review`, `report_artifact`, `ask_user`, and `guide` (this manual, searchable by topic).
  A message you send is pasted into the recipient's terminal, prefixed with `[harness] message <id> from "<role>"`.
- When the human asks how to use or configure crewmux, call `guide(topic)` and walk them
  through the steps (or do them, if they asked you to). Do not send them off to read docs.
- Your identity comes from your session token. You cannot act as another role.
- Conversations are resumed automatically when a role is reopened (claude, codex, grok, and any `custom` agent whose `cli.session` is configured).

## 2. Files you may edit — `.crewmux/` in the project root

```text
.crewmux/
├── config.yaml     project settings (harness restart needed)
├── roles.yaml      role → agent binding          ← most changes happen here
├── agents/<id>.yaml  one file per CLI profile (vendor + flags)
├── prompts/<name>.md role instructions (what the role does)
├── rules/<name>.md   rules appended to a role's prompt
├── policy.yaml     files report_artifact may not read
└── state/          RUNTIME — never edit (db, logs, sockets, worktrees)
```

### roles.yaml
```yaml
roles:
  <role>:                 # lowercase, digits, "-" only. This is the address for send_message.
    agent: <agent id>     # REQUIRED — must match a file .crewmux/agents/<id>.yaml
    model: <name>         # optional — overrides the agent file's model
    prompt: <file.md>     # optional — file in .crewmux/prompts/
    rules: [rules/x.md, ../CLAUDE.md]   # optional — paths relative to .crewmux/, appended in order
    autostart: true       # optional (default true) — opened by a bare `crewmux`
```

### agents/<id>.yaml
```yaml
id: <id>                  # must equal the file name without .yaml
kind: claude | codex | grok | custom
model: <name>             # optional
command: <binary>         # optional for claude/codex; REQUIRED for custom
args: [ ... ]             # optional — appended last; passed literally (no $VAR expansion)
```

What the harness adds by itself — do NOT repeat these in `args`:

| kind | injected automatically |
|---|---|
| `claude` | `--mcp-config` (harness MCP), `--allowedTools mcp__harness`, `--append-system-prompt`, `--name <role>`, `--session-id` / `--resume`, `--model` |
| `codex` | `-c mcp_servers.harness.*` (url, bearer token env, tools pre-approved), `-c developer_instructions`, `-m`, `resume <id>` |
| `grok` | built-in `cli:` preset: `--rules` (role prompt, appended), `--allow MCPTool(*harness*)`, `--session-id` / `--resume`, `-m`, and a `[mcp_servers.harness]` block in the project's `.grok/config.toml` (placeholders only) |
| `custom` | whatever its `cli:` block says (§4); with no `cli:`, env vars only |

### config.yaml
```yaml
version: 1
project: <name>           # A-Z a-z 0-9 _ - ; tmux session is crewmux-<project>
baseBranch: main
isolation: shared         # shared | worktree (one git worktree per role per run)
delivery: { pasteDelayMs: 300 }
```

### policy.yaml
```yaml
paths: { deny: ["*.env", "*.pem", ...] }   # only guards report_artifact, not your own shell
```

## 3. Commands (run them in your shell from the project directory)

| Goal | Command |
|---|---|
| Validate config after any edit | `crewmux doctor` — must print only ✓ |
| See roles and whether they run | `crewmux status` |
| Start a role now (re-reads roles.yaml) | `crewmux open <role>` (`--fresh` = new conversation) |
| Stop a role (resumable later) | `crewmux close <role>` |
| Apply changed flags/model/prompt to a running role | `crewmux close <role> && crewmux open <role>` |
| Apply config.yaml / policy.yaml changes | ask the human to run `crewmux down && crewmux` |

Never use `crewmux up <role>` to add a role to a running session — it only attaches. Use `open`.

### When a change takes effect

| Change | Effect |
|---|---|
| new role in roles.yaml | on `crewmux open <role>` — no restart |
| role/agent/prompt/rules of a **stopped** role | next `open` |
| same, for a **running** role | after `close` + `open` of that role |
| config.yaml, policy.yaml | after the human restarts the harness |

## 4. Adding another CLI (`kind: custom`) — config only, no code

Everything the harness needs to drive a CLI is data under `cli:`. `kind: grok` is simply a built-in
`cli:` preset; you can override any part of it the same way.

```yaml
id: mycli
kind: custom
command: mycli
args: ["--some-flag"]            # appended last
cli:
  prompt: { flag: "--append-system-prompt" }   # role prompt → [flag, <prompt>]; prefer an APPEND flag
  modelFlag: "-m"                              # [modelFlag, <model>] when a model is set
  session:
    new: ["--session-id", "{id}"]              # harness picks a UUID for a new conversation (omit if unsupported)
    resume: ["--resume", "{id}"]               # used on the next open, same cwd
    exists: "~/.mycli/sessions/{cwd_urlencoded}/{id}/history.jsonl"   # resume only if this file exists
  mcp:
    args: ["--mcp-url", "{url}"]               # if the CLI takes the MCP server as a flag, or…
    file:                                      # …a PROJECT config file it reads (appended once, never overwritten)
      path: .mycli/config.toml
      content: |
        [mcp_servers.harness]
        url = "${HARNESS_MCP_URL}"
        headers = { Authorization = "Bearer ${HARNESS_MCP_TOKEN}" }
  allow: ["--allow", "mcp:harness"]            # pre-approve the harness tools (other tools still ask)
```

Placeholders: `{id}` session id, `{url}` harness MCP url, `{role}`, `{cwd}`, `{cwd_urlencoded}`; a
leading `~/` is the home directory. The token is never a placeholder: the CLI reads env
`HARNESS_MCP_TOKEN` (put `${HARNESS_MCP_TOKEN}` in the config file only if the CLI expands env vars).

The process also receives these env vars:

| env | value |
|---|---|
| `HARNESS_MCP_URL` | `http://127.0.0.1:<port>/mcp` (MCP Streamable HTTP) |
| `HARNESS_MCP_TOKEN` | send as header `Authorization: Bearer <token>` |
| `HARNESS_ROLE`, `HARNESS_SESSION_ID` | this session |
| `HARNESS_SYSTEM_PROMPT` | harness preamble + role prompt + rules |

Checklist for a new CLI — verify each item, do not assume:
1. Read `<cli> --help` of the installed version. Use only flags that exist.
2. MCP: flag or project config file? If a config file, confirm the CLI **expands `${VAR}`** in it
   (e.g. `HARNESS_MCP_URL=http://127.0.0.1:1/mcp <cli> mcp list` shows the expanded url).
3. System prompt: prefer an **append** flag. A **replace** flag (e.g. `--system-prompt-override`)
   strips the CLI's own tool instructions.
4. Session: find where the CLI stores conversations (e.g. `~/.<cli>/sessions/…`) and whether it
   accepts a chosen id; set `session.new` / `resume` / `exists` accordingly.
5. `crewmux doctor` → `crewmux open <role>` → in that role call `list_agents` (MCP proof) →
   close + open and ask it something from before (resume proof). Report what you verified.

## 5. Recipes

### Add Grok (xAI CLI)
Use `kind: grok`, not `custom`:
```yaml
# .crewmux/agents/grok.yaml
id: grok
kind: grok
# args: ["--always-approve"]   # bypass, only if the human asked
```
Then add the role in roles.yaml, `crewmux doctor`, `crewmux open grok`, and have grok call
`list_agents` to prove its MCP link. The preset already handles `--rules` (append), `--session-id` /
`--resume`, pre-approval, and the `[mcp_servers.harness]` block in `.grok/config.toml`. Do not write that
file yourself and do not add `--system-prompt-override`. Verified with Grok CLI 1.0.3.

### Add a role
1. Add the role to `roles.yaml` (and `prompts/<role>.md` if needed).
2. `crewmux doctor` → `crewmux open <role>` → `send_message(to: "<role>")`.

### Change the model of a role
Set `model:` on the role, then close + open that role.

### Bypass permission prompts
Only when the human asks for it explicitly:
- claude: `args: ["--dangerously-skip-permissions"]` (milder: `["--permission-mode", "acceptEdits"]`)
- codex: `args: ["--dangerously-bypass-approvals-and-sandbox"]` (milder: `["-a", "never", "-s", "workspace-write"]`)
- To bypass only some roles, create a second agent file (e.g. `agents/codex-yolo.yaml`) and point those roles at it.
- Warn the human: with `isolation: shared` every agent edits the same files unprompted.

## 6. Rules

- Do not edit `.crewmux/state/`, other projects' `.crewmux/`, or the user's global CLI configs
  (`~/.claude*`, `~/.codex/config.toml`, …) to wire up the harness. Use `.crewmux/` only.
- Do not `close` your own role, and do not close other roles that are working, unless the human asked.
- Never put secrets (API keys, tokens) in `.crewmux/`. Use env var **names** only.
- After every config edit: run `crewmux doctor` and report the result. Label what you verified
  by running it versus what you only read.
- If a change needs the harness restarted (§3), say so — do not run `crewmux down` yourself; it stops every agent, including you.
