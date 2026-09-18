# CLEAN-CODE — code rules for crewmux

Read this before changing code in this repo — humans and agents alike.
crewmux's own `clean-code` role can review against it: add `../CLEAN-CODE.md` to
`roles.yaml → clean-code.rules`. Generic rules for any project live in
`templates/.crewmux/rules/clean-code.md`; this file only holds rules specific to this repo.

Review severities: **[BLOCKER]** do not merge · **[MAJOR]** fix before merge · **[MINOR]** suggestion.

---

## 1. Layers and import direction — [BLOCKER]

The `ALLOWED` table in `test/architecture.test.ts` is the source of truth; if this file and the test
disagree, the test wins.

| Layer | May import |
|---|---|
| `protocol/` | itself only, plus `zod`, `node:crypto` |
| `config/` | protocol |
| `core/` | protocol, config (pure — no IO) |
| `agents/` | protocol, config (launchers and presets are pure: they return argv + env) |
| `bridge/` | protocol, config, core, workspace |
| `workspace/` | protocol |
| `persistence/` | protocol |
| `terminal/` | nothing else (`tmux.ts` wraps tmux · `chrome.ts` is a pure list of tmux commands) |
| `ui/` | protocol, config, persistence (a read-only viewer: never core, bridge or runtime) |
| `runtime/` | every layer above (composition root of one run) |
| `src/cli.ts` | everything (entry point) |

- `core` and `bridge` must not know that Claude, Codex or tmux exist. Vendor specifics live in
  `agents/` (launchers + `presets.ts`); tmux specifics live in `terminal/`.
- **crewmux never wraps or re-renders a vendor's UI.** A launcher may only add flags, env and MCP
  wiring to the real CLI. No output parsing, no screen scraping.
- A new import direction means changing `ALLOWED` with the reason in the PR — never a quiet cross-layer import.

## 2. State has one owner — [BLOCKER]

- Session status changes only through `SessionRegistry.add/setStatus/setProviderSession`.
- Every change is published as a `HarnessEvent` via `bus.publish(...)`; no event, it did not happen.
- The caller's identity (`role`, `sessionId`) always comes from the **session token**, never from tool arguments.

## 3. One schema per shape — [MAJOR]

- Data crossing layers is a zod schema in `protocol/` (or `config/schema.ts` for configuration); types
  come from `z.infer`. Do not hand-write a second `interface` of the same shape.
- `parse` only **at the edges**: YAML files, MCP tool input, SQLite rows, provider output. Inside,
  trust the types — no re-parsing.
- Every id comes from `newId()` (a full UUID). Never truncate it.

## 4. Decisions separate from IO — [MAJOR]

- **Pure:** `core/`, `agents/`, `runtime/prompt.ts`, `terminal/chrome.ts`, `ui/panel.ts`,
  `bridge/guide.ts` (parse/search). No file reads, no network, no direct `Date.now()` — take a clock
  as a parameter like `EventBus` does.
- **IO at the edges:** `terminal/tmux.ts`, `workspace/`, `persistence/`, `bridge/mcp-server.ts`,
  `runtime/harness.ts`, `runtime/resume.ts`, `runtime/vendor-setup.ts`.
- Keep transports thin: `mcp-server.ts` only wraps `tools.ts`. `tools.ts` is transport-independent
  but reads files in the worktree, so it is not pure.

## 5. Security — [BLOCKER]

- Every server binds to `127.0.0.1` only.
- Paths from agents must be relative and are checked with `realpathSync` to stay inside the
  worktree (`..` and symlinks), then go through `PathPolicy`.
- Tokens travel only in the agent window's environment — never argv, config files or logs
  (`launchers.test.ts` checks this). Config files crewmux writes contain `${VAR}` placeholders only.
- Never edit the user's global CLI configs (`~/.claude*`, `~/.codex/config.toml`, `~/.grok/config.toml`).
  Inject through flags, or through a project-level file declared in a `cli.mcp.file` spec.
- Never use the user's tmux server. Every tmux command goes through `terminal/tmux.ts`, which always
  adds `-L <socket>`. Tests set `CREWMUX_TMUX_SOCKET` to a private server and call `killServer()` at the end.
- No secrets in code, `.crewmux/`, logs, events, fixtures or error messages. Config holds env var **names** only.
- Every security check has a negative test (see `test/bridge.test.ts`).

## 6. Errors — [MAJOR]

- The agent's or user's fault → throw `ToolError`; the message goes back to the agent, so make it actionable.
- A bug → throw a plain `Error`; the MCP server wraps it as `internal error: ...`.
- No empty `catch {}` without a stated reason: handle with a concrete fallback, or rethrow with
  what failed and which id.
- A process that writes logs must survive a closed terminal (EIO/EPIPE) without re-reporting it —
  that loop once wrote 10 GB.

## 7. Tests — [MAJOR]

- New behaviour needs a test that **fails without the change**.
- Pure logic: unit tests. `bridge/`: through a real MCP client over HTTP. `terminal/` and
  `runtime/`: on a real tmux server (`test/e2e-tmux.test.ts`). Do not mock the protocol.
- tmux commands must be **executed by real tmux** in a test, not just string-compared. (Past bugs:
  `set-option -t =name` and window options set through a session target both passed string tests
  and failed on real tmux.)
- Tests never hit the network or cost money. Use `test/fixtures/fake-agent.mjs` (`kind: custom`).
  Trying real Claude/Codex/Grok needs the maintainer's OK.
- Everything a test creates lives under `mkdtemp`.

## 8. Style — [MINOR]

- File names `kebab-case.ts`; one concept per file; consider splitting beyond ~300 lines.
- Named exports only.
- Relative imports end in `.js` (NodeNext); use `import type` for type-only imports.
- Comments explain **why**, not what.
- No unrelated edits, no whole-file reformatting, no dead code.

## 9. Supporting a new CLI

1. First try a `kind: custom` agent with a `cli:` block (`docs/agent-guide.md` §4). If that covers
   it, no code is needed.
2. If it deserves a built-in kind, add a **preset** in `src/agents/presets.ts` (data only) and the
   kind to `AgentDefinition`. Write a code launcher only when the CLI needs something a `CliSpec`
   cannot express (as Claude's JSON `--mcp-config` and Codex's TOML `-c` overrides do).
3. Take flags from `--help` of the installed version — never guess. Add argv tests, including
   "token not in argv".
4. Smoke: `CREWMUX_DEBUG=1 crewmux up <role>` must show `mcp <role> tools/list` in the harness window;
   close + open must resume the conversation.

## 10. Before committing

```bash
pnpm typecheck && pnpm test      # tsc (src + test) + vitest (architecture and tmux e2e included)
git diff --cached | grep -nEi 'api[_-]?key|secret|token=|BEGIN .*PRIVATE' && echo "⚠ check for secrets"
```
