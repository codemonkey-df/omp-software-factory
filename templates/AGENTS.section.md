## Software factory (/factory)

This repo runs a software factory. Rules for every session and subagent:

- The `/factory` orchestrator runs in the MAIN checkout and is the only writer of
  `factory/board.json` (always via the `factory` tool, never by hand).
- Each job `job-NNN-<slug>` has its own git worktree `.factory-worktrees/<job-id>/` on
  branch `factory/<job-id>`. Code for a job is edited ONLY inside that worktree, ONLY by
  that job's builder. Never edit the main checkout from a job.
- Specs are OpenSpec changes at `openspec/changes/<job-id>/` on the job branch. Their
  scenarios are the acceptance criteria.
- Shared job records live in the main checkout under `factory/jobs/<job-id>/`.
  Agents read context from files and write exactly one output file each.
- Reviews start with `VERDICT: PASS` or `VERDICT: CHANGES`; `decision.md` starts with
  `APPROVE` or `ESCALATE`.
- Merges to the main branch are serial (merge queue); OpenSpec archive runs only at merge time.
- Repo profile (language, install/test/dev commands, conventions): `factory/profile.md`.
