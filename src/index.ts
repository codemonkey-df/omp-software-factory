/** OMP extension: registers the `factory` tool used by the /factory orchestrator. */

import { ACTIONS, type ActionParams, runAction } from "./actions.ts";
import { FactoryError } from "./factory.ts";
import type { ExtensionAPI, ToolResult } from "./omp-types.ts";

const DESCRIPTION = `Software-factory state and git plumbing for the /factory orchestrator (see skill://factory).
Only the main-session orchestrator may call it; run from the repo's MAIN checkout. Returns JSON.
Actions (fields):
- init (max_parallel?, base_port?, skip_openspec?): create factory/, AGENTS.md rules, openspec/
- profile (language?, install?, test?, dev?, main_branch?, base_port?): record repo commands
- parallel (n): set max_parallel
- new (title): queue a job, returns its id job-NNN-slug
- start (skip_install?): fill free slots: worktree + branch from main HEAD, install, port
- set (id, stage?, round?, note?, files?): update a job; files are repo-relative paths to show on the dashboard
- round (id, n): open review round n; returns the 4 reviewer OUTPUT paths
- collect (id): read verdicts of the current round; complete only when all 4 files exist
- decide (id): apply decision.md (APPROVE -> merge queue, ESCALATE -> needs-human)
- enqueue (id): put a job in the merge queue
- merge (id?): merge the head of the queue: rebase, test, ff-merge, openspec archive, remove worktree
- status: board summary and free slots
- cleanup: remove worktrees of merged jobs, git worktree prune`;

const text = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  details: value,
});

export default function factoryExtension(pi: ExtensionAPI): void {
  const z = pi.zod;
  pi.setLabel("Software factory");
  pi.registerTool<ActionParams>({
    name: "factory",
    label: "Factory",
    description: DESCRIPTION,
    loadMode: "essential",
    parameters: z.object({
      action: z.enum(ACTIONS),
      id: z.string().optional(),
      title: z.string().optional(),
      n: z.number().optional(),
      stage: z.string().optional(),
      round: z.number().optional(),
      note: z.string().optional(),
      files: z.array(z.string()).optional(),
      install: z.string().optional(),
      test: z.string().optional(),
      dev: z.string().optional(),
      language: z.string().optional(),
      main_branch: z.string().optional(),
      base_port: z.number().optional(),
      max_parallel: z.number().optional(),
      skip_install: z.boolean().optional(),
      skip_openspec: z.boolean().optional(),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (ctx.agent?.kind === "sub") {
        return text({ ok: false, error: "only the /factory orchestrator (main session) may call the factory tool" });
      }
      try {
        return text(await runAction(params, ctx.cwd, signal));
      } catch (err) {
        if (err instanceof FactoryError) return text({ ok: false, error: err.message });
        throw err;
      }
    },
  });
}
