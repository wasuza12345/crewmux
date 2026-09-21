# crewmux — guide for AI agents

You are one of several agent CLIs (Claude Code, Codex, Grok, …) running side by side in tmux under
**crewmux**. This file tells you how the team is configured and how to change it safely.
Read it before editing anything in `.crewmux/`. The human-facing manual is `docs/usage.md` next to this file.

## 1. How the system works (30 seconds)

- Each **role** (planner, coder, …) is one native CLI in its own tmux window. The harness never
  renders or parses your screen.
- Some CLIs have built-in tools with the same names (Codex's `collaboration.send_message` / `list_agents`). They do NOT reach this team — use the tools of the MCP server named `harness` only. (crewmux disables Codex's built-in multi-agent tools for you.)
- Agents talk **only** through the `harness` MCP server: `list_agents`, `send_message`,
  `submit_review`, `report_artifact`, `ask_user`, `compact`, `update_board` (a web status board, §5.2)
  and `guide` (this manual, searchable by topic).
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
boards: { plan: docs/plan.md }   # optional: the plan board's markdown file (§5.2); default plan.md
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
| Show the human a status board in the browser | MCP `update_board(name, board)`; the human opens it with `Ctrl-b B` or `crewmux board <name>` (§5.2) |
| Save a board as one HTML file | `crewmux board export <name> [--out <file>]` |
| Compact a role (save tokens) | MCP `compact(target?, focus?)`, or `crewmux compact <role> --focus "…"` |
| Restart a role — yourself included (applies config, same conversation) | `crewmux restart <role>` — do it yourself, do not ask the human |
| Apply changed flags/model/prompt to a running role | `crewmux restart <role>` (never `close && open` on your own role: `close` kills your shell first) |
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

## 5.1 Compacting (saving tokens)

Every turn resends the whole conversation, so a long, stale context is the biggest token cost.
Each CLI can compact (summarise) its own conversation; crewmux only triggers it.

| Who | How |
|---|---|
| any agent | MCP tool `compact(target?, focus?)` — yourself by default, or another role (e.g. after it delivered its task) |
| the human | `crewmux compact <role>` / `--all` `[--focus "…"]`, or `Ctrl-b C` on a tab |
| automatic | `compactAt: <tokens>` on a role → the CLI compacts itself at that size (Claude 100k–1M; Codex any; Grok: not a flag) |

When to call it — judge by the **task boundary** first, the number second:

| Compact | Do not compact |
|---|---|
| a task is finished and its result reported | mid-task (debugging, waiting for test output) |
| before unrelated new work | while waiting for an answer that needs the details |
| after reading long logs/diffs you no longer need | right after a compaction (AI requests are rate-limited, `config.yaml → compact.minIntervalMinutes`) |
| `list_agents` shows the context above ~70% | |

Before compacting, make what matters survive: decisions, file paths, open TODOs and pending message
ids go into `focus` (Codex ignores `focus` — send them to yourself or share them with `report_artifact`
first). The human can turn AI compaction off with `compact: { ai: false }` in `config.yaml`.

**Custom CLIs** declare it in YAML:
```yaml
cli:
  compact: { command: "/compact {focus}", auto: ["--autocompact", "{tokens}"] }   # auto is optional
  usage:   { file: "~/.mycli/sessions/{id}.jsonl", pattern: '"input_tokens":(\d+)', window: 200000 }
```
`usage` lets `list_agents` and the sidebar show the context size (last regex match, group 1). Without
`compact.command` the agent simply cannot be compacted (a clear error says so).

## 5.2 Boards (web status page)

A board is a read-only web page per project that the human keeps open next to tmux: a banner,
KPI tiles, columns of cards, connectors between cards and an "out of scope" list. It refreshes
every 2.5 s. Write one with the MCP tool `update_board`; each call **replaces** the whole board.

| Board | Written by | Opened with |
|---|---|---|
| `team` | the harness (generated: agents running/asking/stopped, context %, open questions, who messaged whom) | `Ctrl-b B`, `crewmux board` |
| `plan` | generated from the project's plan markdown file (below) — unless you wrote a `plan` board yourself | `crewmux board plan` |
| any other name (`release-1`, `review-pr-42`, …) | you, via `update_board` (layouts per `kind`: §5.3) | `crewmux board <name>`, or the "all boards" link on any board |

The "all boards" page (`/board`) lists every board with its kind, where it comes from
(generated / plan file / agent), when it was updated and by whom.

```jsonc
update_board({
  "name": "plan",                       // lowercase, digits, "-"; "team" is reserved
  "board": {
    "title": "Auth refresh — plan",
    "subtitle": "branch feat/refresh",   // optional
    "banner": { "text": "blocked on review", "status": "blocked" },   // optional
    "kpis": [{ "label": "tests", "value": "13/13", "status": "done", "hint": "vitest" }],
    "columns": [
      { "id": "build", "title": "Build", "cards": [
        { "id": "schema", "title": "schema", "status": "done", "tier": "runtime", "body": "…", "tags": ["zod"] },
        { "id": "ui", "title": "board page", "status": "active" } ] },
      { "id": "verify", "title": "Verify", "cards": [ { "id": "e2e", "title": "e2e on tmux", "status": "todo" } ] }
    ],
    "edges": [{ "from": "schema", "to": "ui", "style": "solid" }, { "from": "ui", "to": "e2e", "style": "dashed", "label": "next" }],
    "outOfScope": ["deploy to production"]
  }
})
```

- `status`: `done` · `active` · `blocked` · `todo` · `info`. `tier` (how a claim was proven):
  `runtime` 🟢 ran and saw output · `compile` 🟡 · `static` 🟠 read only · `none` ⚪.
- Edge `style`: `solid` = main flow · `dashed` = back / waiting · `dotted` = reference. `from`/`to` are card ids;
  card ids must be unique on the board.
- Limits: 12 columns, 50 cards per column, 200 cards total, 12 KPIs, 300 edges, card body 2000 chars.
  Keep cards short — the page is for a glance; details belong in artifacts.
- The harness sets `updatedAt` and `updatedBy` (your role). Files live in `.crewmux/state/boards/<name>.json` — do not edit them by hand.
- The page is served on 127.0.0.1 only and needs the per-run view token in its URL, which
  `crewmux board` prints. The token changes every time the harness starts.

### Generated plan from plan.md

The `plan` board is generated from a markdown file in the project and follows every save of the
file (the page refreshes by itself). Which file: `config.yaml → boards: { plan: docs/plan.md }`
(relative to the project root, must stay inside it), else the first of `plan.md`, `PLAN.md`,
`.crewmux/plan.md` that exists. No file → no plan board.

```markdown
# Auth refresh                     ← board title
Single-flight refresh for mobile.  ← subtitle (first paragraph under the title)

## Build                           ← a column
- [x] schema 🟢                    ← done, proof tier runtime
- [~] refresh queue 🟡             ← active (in progress), tier compile
  - retries with backoff           ← indented lines = card body
- [!] waiting for API access       ← blocked
- [ ] docs                         ← todo
- a plain bullet                   ← info (a note, not counted as a task)

## Out of scope                    ← not a column: the out-of-scope list
- deploy to production
```

- Markers: `[x]` done · `[ ]` todo · `[~]` active · `[!]` blocked. Tiers: 🟢 runtime · 🟡 compile · 🟠 static · ⚪ none, anywhere on the item line.
- KPIs are computed: done/total, in progress, blocked, todo; the banner lists blocked items, or says all done.
- `###` headings, paragraphs and fenced code are ignored. Items before the first `##` go into a "Tasks" column.
- **Authored wins**: if an agent writes a board named `plan` with `update_board`, that board is shown
  instead of the file. To go back to the file, delete `.crewmux/state/boards/plan.json`.
- Prefer editing the plan file: humans read it in git too, and the board stays in sync for free.

### Export a board (snapshot file)

`crewmux board export <name> [--out <file>]` writes one self-contained HTML file with the board's
data embedded — no polling, no token, marked "snapshot <time>"; default path
`.crewmux/boards/<name>-<yyyymmdd-hhmm>.html` (printed). Safe to attach to a PR or send to someone:
it contains only the board. `team` needs the harness running; other boards are read from disk.

## 5.3 Board recipes (`kind`)

Set `"kind"` on the board and follow the layout for that kind, so every agent draws the same
thing the same way and the human can read any board at a glance. Name the board after the work
(`release-1-4`, `review-pr-42`, `debug-login-500`, `handoff-coder`). `custom` = anything else.
Common to all: send the **whole** board every time, update it when a card changes state, put the
proof tier on every claim (`runtime` only when you ran it and saw the output).

### Board recipe: plan

- When: you are asked for a plan, or a plan changes. Usually you do **not** need to write it:
  keep `plan.md` in the project (§5.2) and the `plan` board is generated from it.
- Write it with `update_board("plan", …)` only when the plan is not a file; the authored board then wins.
- Columns = phases (`Phase 1 — schema`, …). Cards = tasks: `todo` → `active` → `done` / `blocked`.
- KPIs: `done` = `3/8`, `blocked`. Banner only when something is blocked or everything is done.
- Edges: `solid` = depends on / next. `outOfScope` = what this plan deliberately does not do.

### Board recipe: release (GO / NO-GO)

- When: before a deploy, a publish or a merge to the release branch; update after every check.
- `"kind": "release"`, columns **Checks · Tests · Docs · Ship**.
- Cards: one per gate (`typecheck`, `unit 106/106`, `e2e tmux`, `CHANGELOG`, `version bump`, `tag`),
  `status` `done` / `blocked` / `todo`, and **always a `tier`**: a test you did not run is `none`, not `done`.
- KPIs: `tests` (`106/106`), `blocked`, `proof` (e.g. `9/10 runtime`).
- Banner (required, validated): text starts with `GO` or `NO-GO`, e.g.
  `{ "text": "NO-GO — e2e red, CHANGELOG missing", "status": "blocked" }` or `{ "text": "GO — all gates green", "status": "done" }`.
  `GO` only when no card is `blocked` or `todo`.
- `outOfScope`: what this release does not include.

### Board recipe: review (findings)

- When: you reviewed a diff or PR (with `submit_review` to the author as well — the board is for the human).
- `"kind": "review"`, columns **BLOCKER · MAJOR · MINOR** (+ optional **Fixed**).
- Cards: one finding each; title = short claim, body = `file:line` + why + suggested fix,
  `status` `blocked` for BLOCKER, `todo` for MAJOR/MINOR, `done` once fixed (move it to **Fixed**).
  `tier` = how you know (`static` = read the code, `runtime` = reproduced it).
- KPIs: counts per severity, `confidence` (`8/10`). Banner: `approve` / `changes requested`.
- Edges: `dotted` from a finding to a related finding.

### Board recipe: debug (symptom → fix)

- When: a bug hunt that takes more than a couple of steps, so the human sees where you are.
- `"kind": "debug"`, columns **Symptom · Hypotheses · Evidence · Fix**.
- Cards: the symptom (`blocked` until fixed); each hypothesis (`active` while testing, `done` = confirmed,
  `info` = ruled out, say so in the body); evidence = what you ran and saw (`tier: runtime`); the fix + its test.
- Edges: `solid` hypothesis → evidence → fix; `dotted` for references (a log, a commit, a related issue).
- Banner: current status in one line, e.g. `root cause found: token cache shared across schools`.

### Board recipe: handoff (before compact or hand-over)

- When: before you compact, stop, or hand the task to another role — so the next agent (or you after
  compaction) and the human know exactly where things stand. Name it `handoff-<role>`.
- `"kind": "handoff"`, columns **Done · In progress · Next · Open questions · Files**.
- Cards: done items with their proof tier; in-progress with what is left; next steps in order;
  questions for the human (`blocked`); files = one card per path with a one-line reason (no file contents).
- Banner: one line for whoever picks it up. Put pending message ids in the body of the relevant card.

## 6. Rules

- Do not edit `.crewmux/state/`, other projects' `.crewmux/`, or the user's global CLI configs
  (`~/.claude*`, `~/.codex/config.toml`, …) to wire up the harness. Use `.crewmux/` only.
- Do not `close` your own role, and do not close other roles that are working, unless the human asked.
- Never put secrets (API keys, tokens) in `.crewmux/`. Use env var **names** only.
- After every config edit: run `crewmux doctor` and report the result. Label what you verified
  by running it versus what you only read.
- If a change needs the harness restarted (§3), say so — do not run `crewmux down` yourself; it stops every agent, including you.
