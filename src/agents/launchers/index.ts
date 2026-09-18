import type { AgentDefinition } from "../../config/schema.js";
import type { AgentLauncher } from "../launcher.js";
import { claudeLauncher } from "./claude.js";
import { codexLauncher } from "./codex.js";
import { declarativeLauncher } from "./declarative.js";

/** claude/codex need code (their flags take JSON/TOML); everything else is data (CliSpec). */
const LAUNCHERS: Record<AgentDefinition["kind"], AgentLauncher> = {
  claude: claudeLauncher,
  codex: codexLauncher,
  grok: declarativeLauncher("grok"),
  custom: declarativeLauncher("custom"),
};

export const launcherFor = (kind: AgentDefinition["kind"]): AgentLauncher => LAUNCHERS[kind];
