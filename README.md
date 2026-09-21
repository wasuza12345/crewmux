# crewmux

Run **Claude Code, Codex, Grok and other agent CLIs side by side in tmux — each in its own native UI —
and let them hand work to each other** through one small MCP server.

crewmux is a thin wrapper, not a new agent UI: every agent keeps its vendor's own interface,
permissions and conversation history. crewmux only opens them, adds a sidebar and a tab bar, and
delivers messages between them.

> Full manual: [docs/usage.md](docs/usage.md) · guide for AI agents: [docs/agent-guide.md](docs/agent-guide.md)

```text
 crewmux-myrepo  ≡ 0:harness  ● 1:planner claude  ● 2:coder codex ✉1        ? 1 question(s) · C-b a
┌ harness ───────────────────┐┌ planner · claude ──────────────────────────────────────────────────┐
│AGENTS                      ││ Claude Code  (the real CLI, untouched)                             │
│● planner  claude ◀ here    ││                                                                    │
│● coder    codex            ││ ❯                                                                  │
│ASKING YOU (1)              ││                                                                    │
│coder: merge now?           ││                                                                    │
│MESSAGES                    ││                                                                    │
│14:31 planner→coder req ✓   ││                                                                    │
└────────────────────────────┘└────────────────────────────────────────────────────────────────────┘
```

## Features

- **One command per project** — `crewmux` creates `.crewmux/` on first use and opens the team.
- **Agents talk to each other** — MCP tools `send_message`, `submit_review`, `report_artifact`,
  `ask_user`, `list_agents`, `update_board`; a message is pasted into the recipient's terminal.
- **Resume** — close and reopen, each role continues its own conversation (Claude, Codex, Grok).
- **Add / remove agents while running** — `crewmux open <role>` / `crewmux close <role>`
  (or `Ctrl-b n` / `Ctrl-b X`); `roles.yaml` is re-read on open.
- **Any CLI via YAML** — describe how to pass the prompt, session id, resume and MCP in `cli:`;
  no code change needed. Grok support is just such a preset.
- **Built-in help for agents** — the `guide` MCP tool lets an agent answer "how do I configure…"
  and do it for you.
- **Status boards in the browser** — `Ctrl-b B` / `crewmux board [name]` (127.0.0.1, a new token
  every run): `team` is generated from what the agents do, `plan` follows your `plan.md`
  (`- [x]` / `- [~]` / `- [!]` + 🟢🟡🟠⚪), and agents write `release` (GO / NO-GO), `review`,
  `debug` and `handoff` boards with `update_board`. `crewmux board export <name>` saves one
  self-contained HTML file to attach to a PR.
- **Isolated** — one private tmux server per project (`tmux -L crewmux-<project>`); your own tmux
  and your CLIs' global configs are never modified.

## Requirements

Linux or WSL, Node.js ≥ 22, tmux ≥ 3.2, and the agent CLIs you want to use, already logged in
(`claude`, `codex`, `grok`, …). pnpm is only needed to build from source.

## Install

```bash
npm i -g crewmux
crewmux help
```

From source: `git clone https://github.com/wasuza12345/crewmux && cd crewmux && pnpm install && pnpm build && npm link`.
Uninstall: `npm uninstall -g crewmux`.

## Use

```bash
cd ~/projects/<your-repo>
crewmux                                   # create .crewmux/ if missing → open planner (claude) + coder (codex)
crewmux open reviewer                     # add a role while running
crewmux status                            # who is running
crewmux down                              # stop everything (conversations resume next time)
```

| Key | Action |
|---|---|
| `Alt-1..9` | switch agent |
| `Ctrl-b n` / `Ctrl-b X` | add / remove an agent |
| `Ctrl-b m` | all messages (popup) |
| `Ctrl-b a` | jump to the agent that asked you something |
| `Ctrl-b B` | open the team board in the browser |
| `Ctrl-b d` or `q` in the sidebar | leave; agents keep running |

VS Code's terminal takes `Ctrl+B` for its sidebar — set `"terminal.integrated.sendKeybindingsToShell": true`.

## Configure

`.crewmux/` in your project:

```text
config.yaml   roles.yaml   agents/<id>.yaml   prompts/<role>.md   rules/*.md   policy.yaml   state/ (not committed)
```

```yaml
# roles.yaml — a role is an address other agents send messages to
roles:
  planner: { agent: claude, prompt: planner.md }
  coder:   { agent: codex,  prompt: coder.md }
  grok:    { agent: grok,   autostart: false }
```

```yaml
# agents/grok.yaml
id: grok
kind: grok            # claude | codex | grok | custom
# args: ["--always-approve"]
```

Or simply ask any agent: *"add Grok as a new role"* — it calls the `guide` tool and does it.
Every field is documented in [docs/agent-guide.md](docs/agent-guide.md).

## Security

- The MCP server listens on `127.0.0.1` only; each agent session gets its own bearer token, and
  the sender of every message is taken from that token. Board pages are served on the same
  127.0.0.1 port and need a separate per-run view token (stored 0600, never logged).
- Permission prompts stay with each vendor CLI. Bypass flags are opt-in per agent — read
  [SECURITY.md](SECURITY.md) before enabling them (agents can prompt-inject each other).

## Development

```bash
pnpm typecheck && pnpm test     # vitest, including end-to-end tests on a private tmux server
```

Architecture and code rules: [CLEAN-CODE.md](CLEAN-CODE.md).

## Disclaimer

crewmux is an independent project, not affiliated with or endorsed by Anthropic, OpenAI or xAI.
Claude, Codex and Grok are trademarks of their respective owners. crewmux only starts their official
CLIs with your own accounts. It is provided "as is" (see [LICENSE](LICENSE)); agents you run through
it can modify files and execute commands — review what they do.

## License

[MIT](LICENSE)
