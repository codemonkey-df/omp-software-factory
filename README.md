# omp-sw-factory

A small, visual software factory for [oh-my-pi](https://omp.sh) (OMP): one `/factory`
skill orchestrates subagents, [OpenSpec](https://github.com/Fission-AI/OpenSpec) specs,
one git worktree per job, and markdown files, with a live HTML dashboard.

```
feature → queued → OpenSpec propose → builder ⇄ 4 reviewers (max 2 rounds) → approver → merge queue
                                       (slow)   security/ux/ui/code          (slow)    rebase, test, merge, archive
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
/factory init                      # profile the repo, create factory/, openspec/, AGENTS.md rules, commit
/factory dashboard                 # serves http://localhost:8765/factory/dashboard.html
/factory add rate limiting to the public API
/factory search filters | CSV export | dark mode     # parallel jobs (max_parallel, default 3)
/factory next 2                    # first 2 unchecked items in factory/backlog.md
/factory parallel 4
/factory approve job-003-rate-limiting
/factory rework job-003-rate-limiting "use a sliding window, not fixed buckets"
/factory status
/factory cleanup
```

Each repo has its own `factory/` state, so separate OMP instances can run factories for
different repos at the same time.

## What lives where

| Path | What |
|---|---|
| `commands/factory.md` | the `/factory` slash command (loads the skill) |
| `skills/factory/SKILL.md` | the orchestrator's loop: edit this to change the factory |
| `src/index.ts` | OMP extension: registers the `factory` tool (main session only; subagents are refused) |
| `src/factory.ts` | the exact work behind it: board.json, ids, worktrees, ports, rounds, serial merge |
| `src/cli.ts` | the same actions from a shell, for debugging: `node src/cli.ts status` |
| `templates/` | `dashboard.html`, `backlog.md`, the `AGENTS.md` section |
| `agents/` | `builder`, `review-security`, `review-ux`, `review-ui`, `review-code`, `approver` |

In a target repo the factory creates:

```
AGENTS.md                         # factory rules section (between factory:begin/end markers)
.factory-worktrees/<job-id>/      # one worktree per active job (gitignored)
openspec/changes/<job-id>/        # on the job branch; archived into openspec/specs at merge
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
