# omp-sw-factory

A small, visual software factory for [oh-my-pi](https://omp.sh) (OMP): one `/factory`
skill orchestrates subagents, [OpenSpec](https://github.com/Fission-AI/OpenSpec) specs,
one git worktree per job, and markdown files, with a live HTML dashboard.

```
job → queued → OpenSpec propose → builder ⇄ 4 reviewers (max 2 rounds) → approver → integration queue
                                   (slow)   security/ux/ui/code          (slow)    rebase onto base, test, archive,
                                                                                    then stack onto base OR hand off
```

## Install (once)

Needs `omp`, `git` and `openspec` (`npm i -g @fission-ai/openspec`). No build step: OMP
loads the TypeScript extension directly.

```bash
./install.sh            # links this package as an OMP plugin: /factory in every repo
./install.sh ~/code/app # or: copy into ~/code/app/.omp/ (pinned to that repo)
```

`./install.sh` runs `omp plugin link <this dir>`, so edits here are live everywhere (restart
`omp` to reload the extension). Turn it off with `omp plugin disable omp-sw-factory`
(`omp plugin uninstall` needs `bun` on `PATH`).

The pinned mode copies the skill, agents and command into `<repo>/.omp/` and the
extension into `<repo>/.omp/extensions/sw-factory/`; commit them to share the factory
with everyone who opens that repo in OMP.

## Use (per repo)

```text
cd ~/code/app && omp
/factory init                      # asks base branch + merge/branch mode, profiles the repo, commits
/factory dashboard                 # serves http://localhost:8765/factory/dashboard.html
/factory add rate limiting to the public API          # type inferred (feature)
/factory bugfix: crash when saving an empty form      # explicit type
/factory hotfix: token leak in logs @release-2.3      # explicit type and base branch
/factory search filters | CSV export | dark mode      # parallel jobs (max_parallel, default 3)
/factory next 2                    # first 2 unchecked items in factory/backlog.md
/factory parallel 4
/factory config integration=branch push=true          # see "Branches and integration"
/factory approve job-003-rate-limiting
/factory rework job-003-rate-limiting "use a sliding window, not fixed buckets"
/factory done job-003-rate-limiting                   # you merged its branch yourself
/factory status
/factory cleanup
```

Each repo has its own `factory/` state, so separate OMP instances can run factories for
different repos at the same time.

## Branches and integration

Set in `factory/board.json` under `repo` (by `/factory init`, `/factory config`, or the
`factory` tool's `profile` action):

| Key | Default | Meaning |
|---|---|---|
| `base_branch` | current branch at init | parent branch jobs start from and land on, e.g. `Branch_A`; per job: `@<branch>` |
| `integration` | `merge` | `merge`: stack approved jobs onto the base. `branch`: leave each job as a tested branch for a human |
| `branch_pattern` | `{type}/{base}/{slug}` | job branch name; placeholders `{type}` `{base}` `{slug}` `{id}` `{number}` |
| `protected_branches` | `[]` | never merged automatically, in any mode (job goes to needs-human) |
| `push` | `false` | branch mode: push the job branch to `remote` when it is ready |
| `remote` | `origin` | remote for `push` |

Job types are `feature`, `bugfix`, `change` and `hotfix`, so branches look like
`feature/Branch_A/login-form` or `hotfix/Branch_A/token-leak`. A repeated name gets the
job number appended (`feature/Branch_A/login-form-004`).

Both modes integrate one job at a time and always rebase the job onto the current base
and rerun the test command first, so a job never lands on (or is handed off against) a
base it was not tested on.

- `merge` only fast-forwards the base: no merge commits, no force pushes, and other jobs
  are rebased onto the new tip before they land. The main checkout can stay on another
  branch (e.g. `main` while jobs stack onto `Branch_A`). The factory never pushes in this mode.
- `branch` never touches the base. The job ends in the `ready` stage with the spec
  archived on its branch; you review and merge it (PR or locally). `/factory cleanup`
  notices branches merged into their base; for squash merges use `/factory done <id>`.

Git cannot have a branch and a folder of branches with the same name: with a branch
`Branch_A`, a pattern like `{base}/{slug}` (`Branch_A/login-form`) is impossible, which is
why the default puts the type first. `/factory` tells you when a pattern clashes.

## What lives where

| Path | What |
|---|---|
| `commands/factory.md` | the `/factory` slash command (loads the skill) |
| `skills/factory/SKILL.md` | the orchestrator's loop: edit this to change the factory |
| `src/index.ts` | OMP extension: registers the `factory` tool (main session only; subagents are refused) |
| `src/factory.ts` | the exact work behind it: board.json, ids, branch names, worktrees, ports, rounds, serial integration |
| `src/cli.ts` | the same actions from a shell, for debugging: `node src/cli.ts status` |
| `templates/` | `dashboard.html`, `backlog.md`, the `AGENTS.md` section |
| `agents/` | `builder`, `review-security`, `review-ux`, `review-ui`, `review-code`, `approver` |

In a target repo the factory creates:

```
AGENTS.md                         # factory rules section (between factory:begin/end markers)
.factory-worktrees/<job-id>/      # one worktree per active job (gitignored)
openspec/changes/<job-id>/        # on the job branch; archived into openspec/specs on that branch at integration
factory/board.json                # state; drives the dashboard
factory/profile.md                # language, install/test/dev commands, conventions
factory/backlog.md
factory/dashboard.html
factory/jobs/<job-id>/build.md, round-N/review-*.md, decision.md
```

Job ids look like `job-003-rate-limiting`: OpenSpec change names must start with a letter.

## Models and OMP settings

Agents use OMP roles (`@slow` for builder, security and approver; `@default` for the
other reviewers). Map them in `~/.omp/agent/config.yml`:

```yaml
modelRoles:
  default: <provider/model>
  slow: <provider/model>:high
task:
  maxConcurrency: 6        # parallel subagents; 1 job needs up to 4 at once (reviewers)
  maxRecursionDepth: 1     # orchestrator → agents is enough
```

`async.enabled` must be `true` (the default) so the orchestrator can run jobs in parallel
and collect them with `wait`.

## Develop

Node 23.6+ runs the TypeScript sources directly (OMP itself runs them under Bun).

```bash
npm install          # typescript + @types/node, dev only
npm run check        # tsc --noEmit, then node --test tests/*.test.ts
```
