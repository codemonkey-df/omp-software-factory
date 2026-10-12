Build a simple, visual "software factory" in this repo using an OMP (oh-my-pi) skill,
subagents, OpenSpec, git worktrees, and markdown files. Keep it small: a viewer should
understand the whole thing in a few minutes. Inspect the repo first so the agents know
its language, test command, install command, dev-server command, and conventions. Also
check OMP's own docs for (a) where project skills and custom agents are discovered and
their file format, and (b) how to message or resume a named subagent. Use what you
find; do not guess.

## The orchestrator

The factory is one skill, /factory. Whichever OMP session runs it becomes the
orchestrator: it runs the loop below, spawns every agent with the `task` tool, collects
results with `wait`, and is the only writer of factory/board.json. The orchestrator
always runs in the MAIN checkout.

## Specs use OpenSpec (no spec-writer agent)

Run `openspec init` if openspec/ doesn't exist. For each job the orchestrator runs the
OpenSpec propose step inside that job's worktree to create
openspec/changes/<job-id>/ (proposal, specs, design, tasks), so the spec travels on the
job's branch. Run it non-interactively: skip explore, make reasonable assumptions, record
them in proposal.md under "Assumptions". The spec's scenarios are the acceptance
criteria the builder and reviewers use. The OpenSpec archive step runs ONLY at merge
time, in the main checkout, one job at a time (see Merge queue).

## Parallel jobs with git worktrees

- Several jobs run at the same time. Each job gets its own worktree and branch:
    git worktree add .factory-worktrees/<job-id> -b factory/<job-id> <base>
  .factory-worktrees/ is gitignored. <base> is the current main HEAD.
- The builder and all four reviewers for a job work INSIDE that job's worktree for code.
  Never two jobs in one worktree; never edit the main checkout from a job.
- Shared state lives in the main checkout so the dashboard sees everything:
  factory/board.json, factory/jobs/<job-id>/ (build.md, round-N/, decision.md).
  When spawning an agent, pass absolute paths: the worktree path (code) and the main
  checkout's factory/jobs/<job-id>/ path (where it writes its one output file).
- Concurrency cap: max_parallel (default 3, stored in board.json). Jobs beyond the cap
  sit in stage "queued" and start automatically as slots free up.
- Isolation: after creating a worktree, run the repo's install command there, and give
  each job its own dev-server/test port (base port + job index) so parallel jobs don't
  collide. Record worktree path and port in board.json.
- Merge queue: builds and reviews run in parallel, but merges to main are serial. For
  the next approved job: rebase factory/<job-id> onto current main, rerun the tests, then
  merge, run the OpenSpec archive step in the main checkout, remove the worktree
  (git worktree remove) and delete nothing else. If the rebase conflicts or the tests
  fail, send it back to its builder once with the conflict/failure; if that fails too,
  set needs-human.
- Cleanup: /factory cleanup removes worktrees of merged jobs and runs `git worktree prune`.
- Parallel OMP subagents are fine for different jobs; within one job only the builder
  edits code.

## The loop (edit this to change the factory)

(Per job. Many copies of this loop run at once, each in its own worktree.)

                   ┌──────────────────┐
                   │     feature      │
                   └─────────┬────────┘
                             ▼
                   ┌──────────────────┐
                   │ queued (if cap)  │  → create worktree + branch
                   └─────────┬────────┘
                             ▼
                   ┌──────────────────┐
                   │ OpenSpec propose │   (OpenSpec skill, run by orchestrator)
                   │  proposal+specs  │
                   └─────────┬────────┘
                             ▼
                   ┌──────────────────┐
                   │     builder      │◄────────────────────┐
                   │   role: slow     │                     │
                   └─────────┬────────┘                     │
        ┌─────────────┬──────┴──────┬─────────────┐         │
        ▼             ▼             ▼             ▼         │
  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐   │
  │  security │ │     ux    │ │ ui design │ │    code   │   │
  │ role: slow│ │role:default│ │role:default│ │role:default│  │
  └─────┬─────┘ └─────┬─────┘ └─────┬─────┘ └─────┬─────┘   │
        └─────────────┴──────┬──────┴─────────────┘         │
                             ▼                              │
                   ┌──────────────────┐   any CHANGES:      │
                   │   WAIT FOR ALL   ├─────────────────────┘
                   │   4 reviews in   │   resume builder
                   └─────────┬────────┘   (max 2 rounds)
                             ▼ all PASS
                   ┌──────────────────┐
                   │     approver     │
                   │   role: slow     │
                   └─┬───────────────┬┘
             APPROVE │               │ ESCALATE
                     ▼               ▼
        ┌──────────────────┐ ┌─────────────┐
        │   MERGE QUEUE    │ │ needs-human │ ◄── /factory approve
        │ rebase, test,    │ └─────────────┘
        │ merge, archive   │
        │ (one at a time)  │
        └──────────────────┘

Model roles are OMP roles (default / slow / smol / plan / task / advisor). Set the actual
models in OMP config, not in the agent files. If round 2 still has any CHANGES, the job
goes straight to needs-human.

## Target file system

AGENTS.md                          # short factory rules that every OMP session reads
<omp skills dir>/factory/SKILL.md  # the orchestrator's instructions (path per OMP docs)
<omp agents dir>/                  # builder, review-security, review-ux, review-ui,
                                   #   review-code, approver (path per OMP docs)
.factory-worktrees/<job-id>/       # one git worktree per active job (gitignored)
openspec/
  changes/003-rate-limiting/       # proposal.md, specs/, design.md, tasks.md (on the job branch)
  specs/                           # current behavior, grows via archive at merge time
factory/
  board.json                       # durable state, drives the dashboard
  dashboard.html                   # visual board, polls board.json
  backlog.md                       # queue of features for /factory next
  jobs/003-rate-limiting/          # one folder per job (same id as the OpenSpec change)
    build.md
    round-1/                       # one folder per review round,
      review-security.md           # one file per reviewer
      review-ux.md
      review-ui.md
      review-code.md
    decision.md

## Example files

Custom agent file: use the format from OMP's docs. Content to include:
  name, one-line description of when the orchestrator should use it, allowed tools
  (read/grep/glob/bash/write as needed), model role, and a body saying what it reads,
  what it does, and which single file it writes.

factory/board.json
{ "max_parallel": 3,
  "merge_queue": ["002-search-filters"],
  "jobs": [ { "id": "003-rate-limiting", "branch": "factory/003-rate-limiting",
  "worktree": ".factory-worktrees/003-rate-limiting", "port": 3003,
  "stage": "review", "round": 2,
  "files": ["openspec/changes/003-rate-limiting/proposal.md", "factory/jobs/003-rate-limiting/build.md"],
  "reviews": { "security": "CHANGES", "ux": "PASS", "ui": "pending", "code": "PASS" } } ] }

Stages: queued, spec, build, review, approve, merge-queue, merged, needs-human.

## Rules
- Agents get context from files, not the conversation, and write only their own file.
- Each review starts with VERDICT: PASS or CHANGES; decision.md starts with
  APPROVE or ESCALATE.
- The builder works and commits only in its job's worktree on branch factory/<job-id>,
  implements the OpenSpec tasks.md checklist, and tests against the spec's scenarios.
- Reviewers judge the diff against the OpenSpec specs/design for that change. They are
  read-only on code and each writes only its own review file.
- WAIT FOR ALL: a review round is done only when every reviewer's file exists in
  the round folder. Never resume the builder mid-round.
- Spawn the builder with a name (builder-<job-id>) and resume that same builder for each
  new round via OMP's subagent messaging, pointing it at the round folder.
- Never run two merges at once. Never archive OpenSpec changes in parallel.

## Commands
/factory <feature>               run a new job through the loop
/factory <feature1> | <feature2> | ...   start several jobs in parallel (respects max_parallel)
/factory next [n]                run the first n unchecked items in backlog.md in parallel (default 1)
/factory parallel <n>            set max_parallel
/factory approve <job-id>        send a needs-human job to the merge queue
/factory rework <job-id> <note>  send a job back to the builder with feedback
/factory cleanup                 remove worktrees of merged jobs, git worktree prune

## Dashboard
One self-contained HTML file, served from the repo root with `python3 -m http.server`
and opened at /factory/dashboard.html (so it can also read openspec/ and worktree
files). Jobs are cards moving across the loop's stages, so parallel jobs are visible
side by side. Each card shows its branch and port. Each review round shows as a row of
reviewer chips that fill in as verdicts land. A merge-queue lane shows what merges next.
needs-human jobs stand out. Click a card to read its markdown files (the paths listed
in board.json, including the OpenSpec spec). Clean and minimal.