# crewmux — user manual

- Overview: [README](../README.md) · guide for AI agents: [agent-guide.md](agent-guide.md)
- This file covers **how to use crewmux** and **every setting in `.crewmux/`**.

---

## 1. Install (once)

You need Linux or WSL, Node.js ≥ 22, tmux ≥ 3.2, and the agent CLIs you want (`claude`, `codex`,
`grok`, …) already logged in.

```bash
npm i -g crewmux
crewmux help
```

From source instead:

```bash
git clone https://github.com/wasuza12345/crewmux && cd crewmux
pnpm install && pnpm build
npm link                 # global `crewmux` command → this checkout (rebuild = new code)
```

Uninstall: `npm uninstall -g crewmux` (or `npm unlink -g crewmux` for a source install).

---

## 2. Use it in a project

```bash
cd ~/projects/<your-repo>
crewmux
```

That one command:
1. creates `.crewmux/` from the template if it is missing (project name = folder name) and runs `doctor`;
2. opens every role with `autostart: true` (by default: planner = Claude, coder = Codex) with the sidebar;
3. attaches you to tmux. If the session is already running, it just attaches.

Recommended:
- If the project is not a git repo yet, `git init` and commit first — then `git diff` shows what the agents changed.
- To keep `.crewmux/` out of your team's git: `echo ".crewmux/" >> .git/info/exclude`.

### All commands

| Command | What it does |
|---|---|
| `crewmux` | create `.crewmux/` if missing, then `up` (the one you normally use) |
| `crewmux up` | open every `autostart: true` role; attach if already running |
| `crewmux up planner coder reviewer` | open only these roles (only when the session is not running yet) |
| `crewmux up --no-attach` | start in the background |
| `crewmux up --fresh` | start every role with a new conversation instead of resuming |
| `crewmux down` | stop the session, every agent, and revoke all tokens |
| `crewmux open <role>` / `close <role>` / `status` | add / remove / list agents while running (see "Add agents / roles") |
| `crewmux init [--force]` | only create `.crewmux/`; `--force` overwrites template files |
| `crewmux doctor` | check the config, tmux, and every agent binary the roles use |
| `CREWMUX_DEBUG=1 crewmux up` | log every MCP call in the harness window (troubleshooting) |

`crewmux` looks for `.crewmux/` from the current folder upwards (like git), so subfolders work.

### The screen (sidebar layout)

- **Top bar:** project + one tab per role (`●` running · `○` stopped · `✉N` unread messages) and
  `? N question(s)` when an agent is waiting for you.
- **Left, 32 columns:** the harness sidebar — AGENTS / ASKING YOU / MESSAGES, built from events,
  never from the agents' screens.
- **Right:** the agent's real CLI. Type to it as usual; messages from other agents are pasted here.
- **Terminal title:** `crewmux · <project> · <agent>`. (Windows Terminal: turn off
  "Suppress title changes" in the profile if it does not change.)
- Window `0:harness` is the full harness log (also in `.crewmux/state/harness.log`). It **ignores
  keys** — Ctrl-C there stops nothing; only `crewmux down` stops the harness.
- Attaching always lands on the first agent, not on the log.

| Key | Action |
|---|---|
| `Alt-1` … `Alt-9` | go to that agent (no prefix needed) |
| `Ctrl-b m` | popup with all messages; close with `q` or `Esc` |
| `Ctrl-b a` | jump to the agent that asked you something, answer in its own UI |
| `Ctrl-b n` (or `Ctrl-b Ctrl-n`) | add an agent: an `open role:` prompt appears in the **top bar**; type the role, Enter |
| `Ctrl-b X` (capital X) | remove this tab's agent (confirm with `y` in the top bar). Lower-case `Ctrl-b x` is tmux's own kill-pane |
| `Ctrl-b z` | zoom the selected pane (hides the sidebar) — again to restore |
| `Ctrl-b d` | leave; agents keep running. Come back with `crewmux` |
| `q` in the sidebar or the harness window | leave, like `Ctrl-b d` — works even when the terminal steals `Ctrl-b` |
| mouse | click panes and tabs (`mouse on`) |

**VS Code terminal:** VS Code uses `Ctrl+B` for its own sidebar, so it never reaches tmux. Add this to
your User Settings (JSON) to send shortcuts to the terminal (remove the line to undo):
```json
"terminal.integrated.sendKeybindingsToShell": true
```
Without it you can still click tabs/panes, use `Alt-1..9`, and press `q` in the sidebar to leave.

**Your tmux is untouched:** each project runs its own tmux server (`tmux -L crewmux-<project>`), so
these bindings exist only there. Running `crewmux` inside your own tmux nests them: `Alt-` keys work,
`Ctrl-b` must be pressed twice (the outer tmux takes the first).

### Getting agents to work together

Just tell one agent, e.g. in the planner window:

> Analyse the login bug, send the fix to coder, and ask reviewer to check it.

The agent calls `send_message(to: "coder")` itself and the message appears in the coder's window.

---

### Resume: close, reopen, continue

Each role **continues its own last conversation automatically** when it opens, so `crewmux down`
loses nothing.

| Vendor | How |
|---|---|
| Claude | crewmux sets `--session-id` on first start, then uses `--resume <id>` |
| Codex | on exit crewmux finds the id in `~/.codex/sessions`, then uses `codex resume <id>` |
| Grok | `--session-id` on first start, then `--resume <id>` (if `~/.grok/sessions/<path>/<id>/chat_history.jsonl` exists) |
| custom | resumes when `cli.session` is configured (section 5.1); otherwise never |

- Only with the same vendor and the same folder. Switching vendor, or `isolation: worktree`
  (a new folder every run), starts a new conversation.
- If you opened an agent but never typed anything, there is nothing to resume yet.
- Start everything fresh: `crewmux down && crewmux up --fresh`.
- The harness MCP server is injected on every start, so messaging works after a resume.

### Ask the agents (the `guide` tool)

Every agent has an MCP tool `guide` that searches this manual and `agent-guide.md`. Ask in plain
language in any agent window — "how do I add grok?", "how do I bypass permissions?", "Ctrl-b does
nothing" — and it will look it up and walk you through it, or do it if you ask.

### Let an agent configure crewmux

Every agent's system prompt points at [agent-guide.md](agent-guide.md). Say "add a tester role on
codex and open it" or "add the Grok CLI as a new role", and it edits `.crewmux/`, runs
`crewmux doctor` and `open`. The guide lives only in the crewmux install, so every project sees the
latest version (an agent that was already running sees it after close + open).

### Add agents / roles

1. **Existing CLI profile** (claude, codex, grok): just add a role to `.crewmux/roles.yaml`:
   ```yaml
   roles:
     tester:
       agent: codex          # uses agents/codex.yaml
       prompt: coder.md      # or your own prompts/tester.md
       autostart: true       # also opened by a bare `crewmux`
   ```
2. **New CLI or different flags** (e.g. a Claude with bypassed permissions): create
   `.crewmux/agents/<id>.yaml` and point the role at that id (sections 3.2 and 5).
3. Open it right away — no restart; `roles.yaml` is re-read on every open:

| Goal | Command | In tmux |
|---|---|---|
| add an agent | `crewmux open tester` (`--fresh` = new conversation) | `Ctrl-b n`, type the role |
| remove an agent | `crewmux close tester` | `Ctrl-b X` on its tab, then `y` |
| see what runs | `crewmux status` | the sidebar |
| exit from inside the agent | `/exit` in Claude/Codex | the harness notices within ~2 s |

- Closing and reopening continues the same conversation.
- Tabs are renumbered, so `Alt-<n>` always matches.
- These commands reach the running harness through `.crewmux/state/control.sock` (mode 600, your
  user only). If the harness is not running you get "harness is not running".

---

## 3. Configure `.crewmux/`

```text
.crewmux/
├── config.yaml     project settings
├── roles.yaml      role → agent
├── policy.yaml     files agents may not share through the harness
├── agents/*.yaml   one file per CLI profile
├── prompts/*.md    what each role does
├── rules/*.md      rules appended to a role's prompt
└── state/          (not committed) harness.db, logs, artifacts/, worktrees/
```

Run `crewmux doctor` after editing. Role/agent/prompt changes apply when that role is opened
(close + open a running role); `config.yaml` and `policy.yaml` need `crewmux down && crewmux`.

### 3.1 `config.yaml`

```yaml
version: 1
project: my-repo          # tmux session = crewmux-<project> · A-Z a-z 0-9 _ - only
baseBranch: main          # branch worktrees start from
isolation: shared         # shared | worktree
delivery:
  pasteDelayMs: 300       # wait after pasting a message before pressing Enter (ms)
```

| Field | Default | Meaning |
|---|---|---|
| `version` | required: `1` | |
| `project` | required | `crewmux init` sets it from the folder name |
| `baseBranch` | `main` | |
| `isolation` | `shared` | `shared`: every agent works in the repo root · `worktree`: each role gets `.crewmux/state/worktrees/<runId>/<role>` on branch `agent/<runId>/<role>` |
| `delivery.pasteDelayMs` | `300` | increase it if a message is pasted but not submitted |

> `worktree` mode: crewmux does not remove or merge worktrees yet — use `git worktree list` /
> `git worktree remove <path>`.

### 3.2 `agents/<id>.yaml`

```yaml
id: codex                 # the name roles.yaml refers to
kind: codex               # claude | codex | grok | custom
model: gpt-5.6-sol        # optional default model
command: codex            # optional binary path · required for kind: custom
args: []                  # optional extra flags, appended last (so they can override)
```

**What crewmux adds by itself per `kind`** (do not repeat these):

| kind | added automatically |
|---|---|
| `claude` | `--mcp-config` (harness MCP), `--allowedTools mcp__harness`, `--append-system-prompt`, `--name <role>`, `--session-id` / `--resume`, `--model` |
| `codex` | `-c mcp_servers.harness.url/bearer_token_env_var/default_tools_approval_mode="approve"`, `-c developer_instructions`, `-m`, `resume <id>` |
| `grok` | `--rules` (role prompt, appended), `--allow MCPTool(*harness*)`, `--session-id` / `--resume`, `-m`, and a `[mcp_servers.harness]` block in the project's `.grok/config.toml` (`${…}` placeholders only, no secrets) |
| `custom` | whatever its `cli:` block says (section 5.1); without `cli:`, env vars only |

Your own MCP servers configured in those CLIs keep loading; crewmux only adds its own.

### 3.3 `roles.yaml`

```yaml
roles:
  planner:
    agent: claude          # id in agents/
    model: opus            # optional, overrides the agent's model
    prompt: planner.md     # optional, file in prompts/
    rules: []              # optional rule files, paths relative to .crewmux/
    autostart: true        # default true — opened by `crewmux` / `crewmux up`
```

- Role names are `a-z 0-9 -` and are the **address** other agents use: `send_message(to: "planner")`.
- One running session per role; several roles may share one agent profile (planner and reviewer can both be claude).
- `rules` may point outside `.crewmux/`, e.g. `../CONTRIBUTING.md` — read in place, never copied.
- An agent's system prompt = harness preamble + `prompts/<prompt>` + each `rules` file, in order.

### 3.4 `policy.yaml`

```yaml
paths:
  deny: ["*.env", "*.env.*", "*.pem", "*.key", "*creds-*", "id_rsa*", "id_ed25519*"]
```

Only guards **`report_artifact`** (files an agent asks the harness to copy and share), matching the
path and the file name. It does not restrict an agent's own shell — that is each vendor's
permission system (section 4).

---

## 4. Permissions and bypass

By default **each CLI asks for approval as usual**. Only the harness's own tools are pre-approved,
so agents can message each other without you clicking every time.

To change that, add the vendor's flags to `args` (checked against `--help` of Claude Code 2.1,
Codex 0.154 and Grok 1.0):

| Want | Claude (`agents/claude.yaml`) | Codex (`agents/codex.yaml`) | Grok (`agents/grok.yaml`) |
|---|---|---|---|
| ask as usual | nothing | nothing | nothing |
| edit files without asking | `["--permission-mode", "acceptEdits"]` | `["-a", "never", "-s", "workspace-write"]` | `["--permission-mode", "acceptEdits"]` |
| **bypass everything** | `["--dangerously-skip-permissions"]` | `["--dangerously-bypass-approvals-and-sandbox"]` | `["--always-approve"]` |

### Bypass only some roles

`args` belong to an agent profile, not a role. Create a second profile and point those roles at it:

```yaml
# .crewmux/agents/codex-yolo.yaml
id: codex-yolo
kind: codex
args: ["--dangerously-bypass-approvals-and-sandbox"]
```
```yaml
# .crewmux/roles.yaml
roles:
  coder:    { agent: codex-yolo, prompt: coder.md }   # bypass
  reviewer: { agent: claude, prompt: reviewer.md }    # asks as usual
```

### ⚠ Before enabling bypass

1. **Set `isolation: worktree`**, otherwise several unsupervised agents edit the same files.
2. A message from another agent is input to the bypassed one. If any agent reads untrusted content
   (web, issues, files) and gets prompt-injected, it can pass commands on that run unconfirmed.
3. `policy.yaml` does **not** restrict shell commands. See [SECURITY.md](../SECURITY.md).

---

## 5. Add Grok

```yaml
# .crewmux/agents/grok.yaml
id: grok
kind: grok
# args: ["--always-approve"]   # bypass, if you want it
```
Then add a role in `roles.yaml` and `crewmux open grok`. crewmux wires MCP, the role prompt and
resume. Do not add `--system-prompt-override` — it replaces Grok's own instructions.

## 5.1 Add any other CLI (`kind: custom`)

**No code changes needed.** Describe how to pass the prompt, session/resume and MCP under `cli:`
(Grok support is exactly such a preset). The full reference and a verification checklist are in
[agent-guide.md §4](agent-guide.md) — or ask an agent "add <CLI> as a new role" and it follows it.

```yaml
id: mycli
kind: custom
command: mycli
cli:
  prompt: { flag: "--append-system-prompt" }
  session: { new: ["--session-id", "{id}"], resume: ["--resume", "{id}"] }
  mcp: { args: ["--mcp-url", "{url}"] }
```

With no `cli:` at all, the CLI only gets these env vars:

| env | value |
|---|---|
| `HARNESS_MCP_URL` | `http://127.0.0.1:<port>/mcp` (Streamable HTTP) |
| `HARNESS_MCP_TOKEN` | send as header `Authorization: Bearer <token>` |
| `HARNESS_ROLE` / `HARNESS_SESSION_ID` | its role and session |
| `HARNESS_SYSTEM_PROMPT` | preamble + prompt + rules |

`args` are passed literally, so `$VAR` is **not** expanded. To use env vars in flags, wrap with `sh -c`:

```yaml
id: my-cli
kind: custom
command: sh
args: ["-c", "exec my-cli --mcp-url \"$HARNESS_MCP_URL\" --mcp-header \"Authorization: Bearer $HARNESS_MCP_TOKEN\""]
```

The CLI must support MCP over HTTP with a custom header; otherwise it runs but cannot message anyone.
A working example used by the tests: `test/fixtures/fake-agent.mjs`.

---

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `crewmux doctor` shows ✗ on an agent line | binary not on PATH — set `command: /full/path` in the agent file |
| an agent window is stuck on a trust / update question | that is the CLI's own screen — switch to it and answer; MCP connects afterwards |
| an agent says it has no `harness` tools | run `CREWMUX_DEBUG=1 crewmux up` and look for `mcp <role> tools/list` in window 0; if missing, the CLI is still waiting on a question (row above) |
| a message is pasted but not submitted | raise `delivery.pasteDelayMs`, e.g. to 800 |
| `no running agent with role "x"` | that role is not open (or was closed) — check `roles.yaml` and the tabs |
| a config change has no effect | close + open that role, or `crewmux down && crewmux` for config.yaml/policy.yaml (conversations resume) |
| see the message history | `Ctrl-b m`, or table `events` in `.crewmux/state/harness.db` (JSON per event) |
| `✗ the harness did not start` | the next lines are the reason (from `.crewmux/state/harness.log`); fix it and run `crewmux` again |
| `tmux ls` shows no crewmux session | it runs on its own server: `tmux -L crewmux-<project> ls` |
| `Ctrl-b` does nothing (or VS Code's sidebar toggles) | VS Code takes the key — set `terminal.integrated.sendKeybindingsToShell`, or press `q` in the sidebar to leave |
| `Ctrl-b m` / `Ctrl-b a` do nothing inside another tmux | press `Ctrl-b` twice |
| `Ctrl-b a` shows "no agent is waiting for your answer" | nobody asked; the top bar shows `? N question(s)` when someone does |
| ⚠ "started by an older crewmux" | the session predates your upgrade — `crewmux down && crewmux` once (conversations resume); key bindings are re-applied on every attach |
| a (y/n) confirmation is not visible | it is shown in the **top** bar |
