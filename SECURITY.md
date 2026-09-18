# Security

## Reporting a vulnerability

Please report privately through GitHub: **Security → Report a vulnerability** on this repository
(private advisory). Do not open a public issue for security problems. This is a personal project;
reports are handled on a best-effort basis.

## What crewmux protects

- **Local only.** The MCP server binds to `127.0.0.1`. The control socket
  (`.crewmux/state/control.sock`) is mode `0600`.
- **Per-session identity.** Each agent session gets its own bearer token. The sender of a message
  is taken from the token, never from tool arguments, and tokens are revoked when a session ends.
- **Tokens stay out of argv and files.** They are passed through the agent window's environment;
  config files written by crewmux contain `${VAR}` placeholders only.
- **Artifacts.** `report_artifact` reads only files inside the agent's working directory
  (`..` and symlinks resolved) and honours `policy.yaml → paths.deny`.
- **No global changes.** crewmux never edits your CLIs' global configs or your own tmux server.

## What it does NOT protect — know before you use it

- **Agents can prompt-inject each other.** A message from another agent is input to the
  recipient. If one agent reads untrusted content (web pages, issues, files) it can pass
  instructions on. Treat inter-agent messages like any other untrusted input.
- **Bypass modes remove the last safety net.** Flags such as `--dangerously-skip-permissions`,
  `--dangerously-bypass-approvals-and-sandbox` or `--always-approve` let agents run any command
  without asking. Combined with the point above, a single injected message can act on your
  machine. Prefer `isolation: worktree`, a clean git state, and the milder permission modes.
- **Shell access is the vendor's business.** `policy.yaml` only guards what crewmux itself reads;
  it does not restrict what an agent does in its own shell.
- **Same user, same machine.** Anything running as your user can read your tmux sessions and the
  agents' environment. crewmux is not a sandbox.
