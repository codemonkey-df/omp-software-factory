/** OMP extension: registers the `factory` tool used by the /factory orchestrator. */

import { ACTIONS, type ActionParams, runAction } from "./actions.ts";
import { FactoryError, INTEGRATIONS, JOB_TYPES } from "./factory.ts";
import type { ExtensionAPI, ToolResult } from "./omp-types.ts";

const DESCRIPTION = `Software-factory state and git plumbing for the /factory orchestrator (see skill://factory).
Only the main-session orchestrator may call it; run from the repo's MAIN checkout. Returns JSON.
Actions (fields):
- init (base_branch?, integration?, max_parallel?, base_port?, skip_openspec?): create factory/, AGENTS.md rules, openspec/.
  base_branch defaults to the current branch; integration "merge" (default) or "branch"
- profile (language?, install?, test?, dev?, base_port?, base_branch?, integration?, branch_pattern?, push?, remote?,
  protected_branches?): record repo commands and integration config.
  integration: "merge" = stack approved jobs onto base_branch; "branch" = leave a rebased, tested branch for a human.
  branch_pattern placeholders {type} {base} {slug} {id} {number}; default "{type}/{base}/{slug}".
  protected_branches are never merged automatically (job goes to needs-human).
- parallel (n): set max_parallel
- new (title, type?, base?): queue a job; type feature|bugfix|change|hotfix (default feature); base overrides
  base_branch for this job. Returns id job-NNN-slug and branch (e.g. feature/Branch_A/login-form)
- start (skip_install?): fill free slots: worktree + job branch from its base branch HEAD, install, port
- set (id, stage?, round?, note?, files?): update a job; files are repo-relative paths to show on the dashboard
- round (id, n): open review round n; returns the 4 reviewer OUTPUT paths
- collect (id): read verdicts of the current round; complete only when all 4 files exist
- decide (id): apply decision.md (APPROVE -> merge queue, ESCALATE -> needs-human)
- enqueue (id): put a job in the integration queue
- merge (id?): integrate the head of the queue: rebase onto base, test, archive OpenSpec on the job branch, then
  merge mode: fast-forward base, remove worktree (stage merged); branch mode: optional push, stage ready
- status: board summary, config and free slots
- cleanup: mark ready jobs a human merged into their base as merged, remove merged worktrees, git worktree prune`;

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
      type: z.enum(JOB_TYPES).optional(),
      base: z.string().optional(),
      n: z.number().optional(),
      stage: z.string().optional(),
      round: z.number().optional(),
      note: z.string().optional(),
      files: z.array(z.string()).optional(),
      install: z.string().optional(),
      test: z.string().optional(),
      dev: z.string().optional(),
      language: z.string().optional(),
      base_branch: z.string().optional(),
      main_branch: z.string().optional(),
      integration: z.enum(INTEGRATIONS).optional(),
      branch_pattern: z.string().optional(),
      push: z.boolean().optional(),
      remote: z.string().optional(),
      protected_branches: z.array(z.string()).optional(),
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
