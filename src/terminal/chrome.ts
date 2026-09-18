/**
 * The harness frame, as raw tmux commands (pure — tested by comparing output).
 * Each project runs its own tmux server (`-L crewmux-<project>`), so everything is set globally (-g)
 * on that server: window options then apply to every window, and bindings can't leak into other projects.
 * Top status line = role tabs; left pane in each agent window = `agent panel`.
 * State comes from user options the harness sets: window @dot @color @vendor @unread, session @asks @ask_role.
 */

export const PANEL_COLUMNS = 32;

export const THEME = {
  bar: "#17372c",
  barInk: "#bfe3d2",
  barHi: "#3fb68b",
  barHiInk: "#08231a",
  current: "#0e1214",
  dim: "#66716b",
  alert: "#e07a7a",
  alertInk: "#1a0b0b",
  border: "#26302c",
} as const;

export interface ChromeInput {
  /** Shell command that runs this CLI, e.g. "/usr/bin/node /…/dist/cli.js" (already shell-quoted). */
  cli: string;
  /** Project root — the CLI finds .crewmux/ from here. Must not contain a single quote. */
  cwd: string;
}

const tab = (current: boolean) => {
  const base = current ? `#[bg=${THEME.current},fg=#ffffff]` : `#[bg=${THEME.bar},fg=${THEME.barInk}]`;
  const reset = current ? `#[bg=${THEME.current},fg=#ffffff]` : `#[bg=${THEME.bar},fg=${THEME.barInk}]`;
  // commas inside #{?…} must be escaped as #,
  return `${base} #[fg=#{?#{@color},#{@color},${THEME.barInk}}]#{?#{@dot},#{@dot},≡}${reset} #I:#W#[fg=${THEME.dim}]#{?#{@vendor}, #{@vendor},}${reset}`
    + `#{?#{&&:#{@unread},#{!=:#{@unread},0}}, #[bg=${THEME.alert}#,fg=${THEME.alertInk}] ✉#{@unread} ${reset},} `;
};

export function chromeCommands({ cli, cwd }: ChromeInput): string[][] {
  if (/['"$`\\]/.test(cwd)) throw new Error(`project path must not contain quotes, $, backticks or backslashes: ${cwd}`);
  if (cli.includes("'")) throw new Error(`CLI path must not contain a single quote: ${cli}`);
  /**
   * Run a CLI subcommand from a key binding WITHOUT blocking the client: -b = background,
   * result shown for 4s in the status line instead of a view-mode pane that needs `q`.
   * Single quotes at the tmux level keep tmux from touching $… ; formats (#W, #{client_name}) still expand.
   */
  const inBackground = (args: string) =>
    `run-shell -b 'out=$(cd "${cwd}" && ${cli} ${args} 2>&1); tmux display-message -c "#{client_name}" -d 4000 "$out"'`;
  const set = (name: string, value: string) => ["set-option", "-g", name, value];
  const bindings = Array.from({ length: 9 }, (_, i) => ["bind-key", "-n", `M-${i + 1}`, "select-window", "-t", `:${i + 1}`]);
  return [
    set("status-position", "top"),
    set("status-style", `bg=${THEME.bar},fg=${THEME.barInk}`),
    set("status-left-length", "40"),
    set("status-left", `#[bg=${THEME.barHi},fg=${THEME.barHiInk},bold] #{session_name} #[default] `),
    set("status-right-length", "60"),
    set("status-right", `#{?#{&&:#{@asks},#{!=:#{@asks},0}},#[fg=${THEME.alert}]? #{@asks} question(s) · C-b a #[default]· ,}%H:%M `),
    set("window-status-format", tab(false)),
    set("window-status-current-format", tab(true)),
    set("window-status-separator", ""),
    set("pane-border-status", "top"),
    set("pane-border-format", ` #{?#{@label},#{@label},#{pane_current_command}} `),
    set("pane-border-style", `fg=${THEME.border}`),
    set("pane-active-border-style", `fg=${THEME.barHi}`),
    set("mouse", "on"),
    set("renumber-windows", "on"), // closing an agent must not leave a gap behind Alt-<n>
    // Terminal tab/window title (Windows Terminal, VS Code, …): "crewmux · <project> · <agent>".
    set("set-titles", "on"),
    set("set-titles-string", "crewmux · #{s/^crewmux-//:session_name} · #W"),
    // Seeing a window clears its unread badge.
    ["set-hook", "-g", "after-select-window", "set-option -w @unread 0"],
    ...bindings,
    ["bind-key", "m", "display-popup", "-E", "-w", "90%", "-h", "80%", "-d", cwd, `${cli} panel --popup`],
    // Ctrl held after the prefix: C-b C-m (= Enter) behaves like C-b m.
    ["bind-key", "C-m", "display-popup", "-E", "-w", "90%", "-h", "80%", "-d", cwd, `${cli} panel --popup`],
    // Add / remove agents while running (roles.yaml is re-read on open).
    ["bind-key", "n", "command-prompt", "-p", "open role:", inBackground("open %1")],
    // Same on Ctrl-b Ctrl-n — people often keep Ctrl held after the prefix.
    ["bind-key", "C-n", "command-prompt", "-p", "open role:", inBackground("open %1")],
    ["bind-key", "X", "confirm-before", "-p", "close #W? (y/n)", inBackground("close #W")],
    // Jump to the agent that asked you something; answer in its own UI. Says so when nobody asked.
    ["bind-key", "a", "if-shell", "-F", "#{@ask_role}",
      "run-shell \"tmux select-window -t ':#{@ask_role}' && tmux set-option @asks 0 && tmux set-option -u @ask_role\"",
      "display-message -d 3000 'no agent is waiting for your answer'"],
    ["bind-key", "C-a", "if-shell", "-F", "#{@ask_role}",
      "run-shell \"tmux select-window -t ':#{@ask_role}' && tmux set-option @asks 0 && tmux set-option -u @ask_role\"",
      "display-message -d 3000 'no agent is waiting for your answer'"],
  ];
}
