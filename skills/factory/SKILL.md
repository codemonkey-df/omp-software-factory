---
name: factory
description: Software factory orchestrator. Use when the user runs /factory (init, <feature>, next, parallel, approve, rework, status, dashboard, cleanup) to run features through OpenSpec spec -> builder -> 4 reviewers -> approver -> serial merge queue, in parallel git worktrees, with a live dashboard.
---

# /factory — orchestrator

The session running this skill is the ORCHESTRATOR. It runs in the repo's MAIN checkout,
spawns every agent with the `task` tool, collects results with `wait`, and is the only
writer of `factory/board.json`, always through the helper below, never by hand.

```bash
F="python3 $(realpath skill://factory)/scripts/factory.py"   # every command prints JSON
```

`$F` below means that helper. Bash only expands `skill://` for path tools like `realpath`,
so resolve it as shown (or use the `[Skill directory: …]` path) and run it from ROOT. If
your shell does not keep variables between calls, write the absolute path out each time.

Paths used below (always pass ABSOLUTE paths to agents):
- `ROOT` = main checkout (`git rev-parse --show-toplevel`)
- `WT` = `ROOT/.factory-worktrees/<id>` — the job's code
- `CHANGE` = `WT/openspec/changes/<id>` — the job's OpenSpec change (on the job branch)
- `JOB` = `ROOT/factory/jobs/<id>` — the job's records (build.md, round-N/, decision.md)
- `PORT`, `BRANCH`, `BASE` (= board `repo.main_branch`): from `$F status` / board.json

## Commands

| Input | Do |
|---|---|
| `/factory init` | [Init](#init) |
| `/factory <feature>` | `$F new "<feature>"`, then [Run the loop](#scheduler) |
| `/factory <f1> \| <f2> \| ...` | `$F new` for each, then run the loop |
| `/factory next [n]` | First n (default 1) `- [ ]` lines of `factory/backlog.md`: `$F new` each, rewrite the line to `- [x] <text> (<id>)`, then run the loop |
| `/factory parallel <n>` | `$F parallel <n>` |
| `/factory approve <id>` | `$F enqueue <id>` (needs-human → merge queue), then run the loop |
| `/factory rework <id> <note>` | [Rework](#rework), then run the loop |
| `/factory status` | `$F status`, summarise as a short table |
| `/factory dashboard` | Start `python3 -m http.server 8765` in ROOT as a named background bash service; give the user `http://localhost:8765/factory/dashboard.html` |
| `/factory cleanup` | `$F cleanup` |

If `factory/board.json` is missing, run [Init](#init) first.

## Init

1. `$F init` creates `factory/` (board.json, backlog.md, dashboard.html, jobs/), adds
   `.factory-worktrees/` to `.gitignore`, adds the factory rules to `AGENTS.md`, and runs
   `openspec init --tools oh-my-pi` if `openspec/` is missing.
2. Inspect the repo: manifests (package.json, pyproject.toml, go.mod, Cargo.toml, …),
   lockfiles, CI config, README, existing tests. Decide the language/framework,
   install command, test command, dev-server command (must honour `$PORT`), lint/format
   commands, and conventions (layout, naming, test style, UI kit). Do not guess: only
   record commands you found evidence for, and run the test command once to confirm it.
3. Write `factory/profile.md` with those facts (short, one section each), then
   `$F profile --language "<lang>" --install "<cmd>" --test "<cmd>" --dev "<cmd>" [--base-port N]`.
   Also put a 3–5 line project summary into `openspec/config.yaml` under `context: |`.
4. Commit the bootstrap on the main branch: `git add -A && git commit -m "factory: init"`.
   (Worktrees branch from main HEAD, so openspec/ and the profile must be committed.)

## Scheduler

Run this until no job is in spec/build/review/approve and the merge queue is empty
(jobs in needs-human just wait):

1. `$F start` — fills free slots (max_parallel) with queued jobs: worktree + branch
   `factory/<id>` from main HEAD, install command, port. For each started job do
   [Spec](#1-spec) right away, then [Build](#2-build). Report install warnings.
2. Call `wait`. Each result or message belongs to one job (the agent name ends in the job
   id). Advance that job by the step below that matches the agent that finished.
   Results also arrive on their own; do useful work for other jobs before you `wait` again.
3. Whenever the merge queue is non-empty and no merge is running, do [Merge](#5-merge)
   for the head of the queue. One merge at a time, never in parallel.
4. After every state change go back to 1 (a finished or merged job frees a slot).

Never block the whole factory on one job. Parallel jobs are independent.

## The loop (per job)

### 1. Spec
OpenSpec propose, run by YOU, non-interactively, inside WT (not the main checkout):
1. `cd WT && openspec new change <id>`
2. Loop: `openspec status --change <id> --json`; for each artifact whose status is
   `ready`, run `openspec instructions <artifact> --change <id> --json` and write the
   file to its `resolvedOutputPath`, using `template`, following `instruction`, and
   obeying `context`/`rules` (do not copy those into the file). Stop when every id in
   `applyRequires` is `done`. Skip explore. Do not ask the user questions: make reasonable
   assumptions and list them in `proposal.md` under a `## Assumptions` heading.
3. Scenarios (`#### Scenario:` with WHEN/THEN) are the acceptance criteria: make them
   concrete and testable. `openspec validate <id>` must pass.
4. Commit in WT: `git -C WT add openspec && git -C WT commit -m "<id>: spec"`.
5. `$F set <id> --stage build --add-file .factory-worktrees/<id>/openspec/changes/<id>/proposal.md --add-file .factory-worktrees/<id>/openspec/changes/<id>/design.md --add-file .factory-worktrees/<id>/openspec/changes/<id>/tasks.md`
   plus one `--add-file` per `specs/<capability>/spec.md`.

### 2. Build
Spawn ONE builder per job, with the name `builder-<id>` so it can be resumed later:
`task` item `{ name: "builder-<id>", agent: "builder", task: <paths block + "Implement the change.">, solutionSpace: "spec given; implementation open" }`.
Paths block (give every agent this, filled in):
```
JOB_ID=<id>  BRANCH=factory/<id>  BASE=<main branch>  PORT=<port>
WORKTREE=<abs WT>  CHANGE_DIR=<abs CHANGE>  JOB_DIR=<abs JOB>  PROFILE=<abs ROOT>/factory/profile.md
```
When the builder finishes: check `JOB/build.md` exists, then
`$F set <id> --add-file factory/jobs/<id>/build.md`. If build.md lists Blockers,
`$F set <id> --stage needs-human --note "builder blocked"`. Otherwise go to Review.

### 3. Review (WAIT FOR ALL)
1. `$F round <id> <n>` (n = 1 for the first round, else previous + 1). It returns the
   four OUTPUT paths and resets the reviewer chips.
2. Spawn all four in ONE `task` batch: agents `review-security`, `review-ux`,
   `review-ui`, `review-code`, names `<agent>-<id>-r<n>`, each with the paths block plus
   `ROUND_DIR=<abs JOB>/round-<n>  OUTPUT=<that reviewer's path>`.
3. After each reviewer result: `$F collect <id>`. Until `complete` is true, do nothing
   else for this job. Never resume the builder mid-round. If a reviewer finished
   without writing its file, or `invalid` lists it, spawn that reviewer again.
4. When complete:
   - `all_pass` → `$F set <id> --stage approve`, go to Approve.
   - Any CHANGES and n == 1 → resume the same builder: `$F set <id> --stage build`, then
     `write agent://builder-<id>` with: "Round 1 review requested changes. Read every
     file in <abs JOB>/round-1/ that starts VERDICT: CHANGES, fix them in WORKTREE,
     commit, and append `## Round 2` to build.md." When it finishes, run Review with n = 2.
   - Any CHANGES and n >= 2 → `$F set <id> --stage needs-human --note "changes after round <n>"`.

### 4. Approve
Spawn `approver` (name `approver-<id>`) with the paths block plus `OUTPUT=<abs JOB>/decision.md`.
When it finishes: `$F decide <id>`. APPROVE puts it in the merge queue; ESCALATE puts it in
needs-human (tell the user the approver's question; they answer with
`/factory approve <id>` or `/factory rework <id> <note>`).

### 5. Merge
Only the orchestrator merges, one job at a time: `$F merge`. It takes the head of the
queue, rebases `factory/<id>` onto main in WT, reruns the test command, fast-forwards
main, runs `openspec archive <id> -y` in the main checkout, commits the archive plus the
job records, and removes the worktree (the branch is kept).
- `ok: true` → tell the user it merged; continue the scheduler.
- `reason: main-not-clean` → the main checkout has changes outside `factory/`; ask the
  user to commit/stash them, then retry.
- `next: build` (rebase conflict or failing tests, first time) → `write agent://builder-<id>`
  with the `detail`: "Merge failed: <reason>. Rebase WORKTREE onto <BASE>, resolve,
  rerun tests, commit, append `## Merge fix` to build.md." When it finishes: `$F enqueue <id>`.
- `next: needs-human` → second failure (or archive failed); report it.

### Rework
`/factory rework <id> <note>`: write the note to `JOB/rework.md` and
`$F set <id> --stage build --add-file factory/jobs/<id>/rework.md`. If needed, recreate the
worktree first: `git worktree add .factory-worktrees/<id> factory/<id>`. Then
`write agent://builder-<id>`: "Rework requested: read <abs JOB>/rework.md, implement it,
commit, append `## Rework` to build.md". When it finishes, run Review with the next n;
CHANGES in that round go to needs-human.

## Resuming agents
- Messaging a finished or parked agent with `write agent://<name>` revives it with its
  own context. Read `history://<name>` to see what it did and `proc://` for live state.
- If `write agent://builder-<id>` fails because the agent no longer exists (new OMP
  session), spawn a new `builder` with the same name and tell it to read
  `JOB/build.md` first for its history.

## Rules
- Agents get context from files, not this conversation; pass paths, never paste content.
  Each agent writes only its one output file.
- Only the builder edits code, only in its job's worktree. Reviewers/approver are read-only.
- Never edit the main checkout's code from a job. Never two jobs in one worktree.
- Never run two merges at once. Never archive OpenSpec changes in parallel or outside merge.
- Keep the user informed with one short line per state change (job, stage, verdicts).
