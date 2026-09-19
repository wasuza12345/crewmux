import { homedir } from "node:os";
import type { AgentDefinition } from "../../config/schema.js";
import { HARNESS_ENV, harnessEnv, type AgentLauncher, type LaunchContext } from "../launcher.js";
import { autoCompactArgs, effectiveCli, fill } from "../presets.js";

const vars = (ctx: LaunchContext, id: string | undefined) => ({ id, url: ctx.mcpUrl, role: ctx.role });

/** Any CLI described by a CliSpec (kind: custom with `cli:`, or a preset such as grok). */
export const declarativeLauncher = (kind: AgentDefinition["kind"]): AgentLauncher => ({
  kind,
  presetSessionId: (def) => Boolean(effectiveCli(def).cli?.session?.new),
  build(def, ctx) {
    const { command, cli } = effectiveCli(def);
    if (!command) throw new Error(`agent "${def.id}": no command`);
    const home = homedir();
    const f = (list: string[] | undefined, id?: string) => (list ?? []).map((a) => fill(a, vars(ctx, id), home));
    const model = ctx.model ?? def.model;
    const session = cli?.session;
    return {
      command,
      args: [
        ...(ctx.resumeId && session ? f(session.resume, ctx.resumeId) : ctx.providerSessionId && session?.new ? f(session.new, ctx.providerSessionId) : []),
        ...(cli?.prompt ? [cli.prompt.flag, ctx.systemPrompt] : []),
        ...f(cli?.allow),
        ...f(cli?.mcp.args),
        ...(model && cli?.modelFlag ? [cli.modelFlag, model] : []),
        ...autoCompactArgs(def, ctx.compactAt, home),
        ...def.args,
      ],
      env: { ...harnessEnv(ctx), [HARNESS_ENV.prompt]: ctx.systemPrompt },
    };
  },
});
