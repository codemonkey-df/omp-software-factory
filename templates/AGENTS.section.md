## Software factory (/factory)

This repo runs a software factory. Rules for every session and subagent:

- The `/factory` orchestrator runs in the MAIN checkout and is the only writer of
  `factory/board.json` (always via the `factory` tool, never by hand).
- Each job `job-NNN-<slug>` has its own git worktree `.factory-worktrees/<job-id>/` on its
  own branch, named `<type>/<base-branch>/<slug>` by default (type: feature, bugfix,
  change, hotfix). Code for a job is edited ONLY inside that worktree, ONLY by that job's
  builder. Never edit the main checkout from a job.
- Specs are OpenSpec changes at `openspec/changes/<job-id>/` on the job branch. Their
  scenarios are the acceptance criteria.
- Shared job records live in the main checkout under `factory/jobs/<job-id>/`.
  Agents read context from files and write exactly one output file each.
- Reviews start with `VERDICT: PASS` or `VERDICT: CHANGES`; `decision.md` starts with
  `APPROVE` or `ESCALATE`.
- Integration is serial (one job at a time) and only through the `factory` tool: jobs are
  either stacked onto their base branch or left as tested branches for human review, as
  configured in `factory/board.json` (`repo.integration`). Nobody else merges into or
  pushes a base branch. OpenSpec archive runs only at integration time.
- Repo profile (language, install/test/dev commands, conventions): `factory/profile.md`.
