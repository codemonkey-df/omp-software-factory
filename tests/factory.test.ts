import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";

import { type ActionParams, runAction } from "../src/actions.ts";
import { type Board, FactoryError, type Job, slugify } from "../src/factory.ts";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const run = (repo: string, action: ActionParams["action"], fields: Omit<ActionParams, "action"> = {}) =>
  runAction({ action, ...fields }, repo) as Promise<Record<string, any>>;

const runAs = (
  repo: string,
  sessionId: string,
  action: ActionParams["action"],
  fields: Omit<ActionParams, "action"> = {},
) => runAction({ action, ...fields }, repo, undefined, sessionId) as Promise<Record<string, any>>;

const board = (repo: string): Board => JSON.parse(readFileSync(join(repo, "factory", "board.json"), "utf8"));
const job = (repo: string, id: string): Job => board(repo).jobs.find((j) => j.id === id)!;
const newId = async (repo: string, title: string): Promise<string> => (await run(repo, "new", { title })).id;

function writeReviews(repo: string, id: string, n: number, verdicts: Record<string, string>): void {
  const folder = join(repo, "factory", "jobs", id, `round-${n}`);
  for (const [name, verdict] of Object.entries(verdicts)) {
    writeFileSync(join(folder, `review-${name}.md`), `VERDICT: ${verdict}\n\nnotes\n`);
  }
}

function builderCommit(repo: string, id: string, file: string, content: string): void {
  const wt = join(repo, job(repo, id).worktree);
  writeFileSync(join(wt, file), content);
  git(wt, "add", ".");
  git(wt, "commit", "-qm", `${id}: work`);
}

function hasOpenspec(): boolean {
  try {
    execFileSync("openspec", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let repo: string;

beforeEach(async () => {
  repo = join(mkdtempSync(join(tmpdir(), "factory-test-")), "app");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "factory@test");
  git(repo, "config", "user.name", "factory");
  writeFileSync(join(repo, "app.txt"), "v1\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  await run(repo, "init", { skip_openspec: true });
  await run(repo, "profile", { test: "true", install: "" });
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "factory init");
});

describe("setup", () => {
  test("init creates state and is idempotent", async () => {
    await run(repo, "init", { skip_openspec: true });
    assert.equal(board(repo).max_parallel, 3);
    assert.equal(board(repo).repo.base_branch, "main");
    assert.equal(board(repo).repo.integration, "merge");
    assert.ok(existsSync(join(repo, "factory", "dashboard.html")));
    assert.ok(existsSync(join(repo, "factory", "backlog.md")));
    assert.equal(readFileSync(join(repo, ".gitignore"), "utf8").split(".factory-worktrees/").length - 1, 1);
    assert.equal(readFileSync(join(repo, "AGENTS.md"), "utf8").split("factory:begin").length - 1, 1);
  });

  test("refuses to run from inside a job worktree", async () => {
    const id = await newId(repo, "x");
    await run(repo, "start", { skip_install: true });
    await assert.rejects(run(join(repo, job(repo, id).worktree), "status"), FactoryError);
  });
});

describe("jobs", () => {
  test("new allocates letter-prefixed sequential ids", async () => {
    assert.equal(await newId(repo, "Rate limiting"), "job-001-rate-limiting");
    assert.equal(await newId(repo, "Search filters!"), "job-002-search-filters");
    assert.equal(job(repo, "job-001-rate-limiting").stage, "queued");
  });

  test("slug drops filler words and stays short", () => {
    const title = 'add a GET /time endpoint that returns the current server time as JSON {"time": ...}';
    assert.equal(slugify(title), "get-time-endpoint-returns-current");
    assert.equal(slugify("!!!"), "job");
  });

  test("start respects max_parallel and creates worktrees", async () => {
    await run(repo, "parallel", { n: 2 });
    const ids = [await newId(repo, "f0"), await newId(repo, "f1"), await newId(repo, "f2")];
    const started = await run(repo, "start", { skip_install: true });
    assert.deepEqual(
      started.started.map((j: Job) => j.id),
      ids.slice(0, 2),
    );
    const first = job(repo, ids[0]!);
    assert.equal(first.stage, "spec");
    assert.equal(first.branch, "feature/main/f0");
    assert.equal(first.port, 3001);
    assert.ok(existsSync(join(repo, first.worktree, "app.txt")));
    assert.equal(job(repo, ids[2]!).stage, "queued");
  });

  test("collect waits for all four reviews", async () => {
    const id = await newId(repo, "x");
    await run(repo, "start", { skip_install: true });
    await run(repo, "round", { id, n: 1 });
    writeReviews(repo, id, 1, { security: "PASS", ux: "CHANGES" });
    assert.equal((await run(repo, "collect", { id })).complete, false);
    assert.deepEqual(job(repo, id).reviews, { security: "PASS", ux: "CHANGES", ui: "pending", code: "pending" });

    writeReviews(repo, id, 1, { ui: "PASS", code: "PASS" });
    const done = await run(repo, "collect", { id });
    assert.equal(done.complete, true);
    assert.equal(done.all_pass, false);
    assert.deepEqual(done.changes, ["ux"]);
    assert.ok(job(repo, id).files.includes(`factory/jobs/${id}/round-1/review-ux.md`));
  });

  test("decide routes APPROVE and ESCALATE", async () => {
    const a = await newId(repo, "alpha");
    const b = await newId(repo, "beta");
    await run(repo, "start", { skip_install: true });
    writeFileSync(join(repo, "factory", "jobs", a, "decision.md"), "APPROVE\n\nok\n");
    writeFileSync(join(repo, "factory", "jobs", b, "decision.md"), "ESCALATE\n\nrisky\n");
    assert.equal((await run(repo, "decide", { id: a })).decision, "APPROVE");
    assert.equal((await run(repo, "decide", { id: b })).decision, "ESCALATE");
    assert.equal(job(repo, a).stage, "merge-queue");
    assert.equal(job(repo, b).stage, "needs-human");
    assert.deepEqual(board(repo).merge_queue, [a]);
  });
});

describe("merge queue", () => {
  test("success merges, keeps the branch and removes the worktree", async () => {
    const id = await newId(repo, "feature");
    await run(repo, "start", { skip_install: true });
    builderCommit(repo, id, "feature.txt", "hello\n");
    await run(repo, "enqueue", { id });

    assert.equal((await run(repo, "merge")).ok, true);
    assert.equal(readFileSync(join(repo, "feature.txt"), "utf8"), "hello\n");
    assert.equal(job(repo, id).stage, "merged");
    assert.deepEqual(board(repo).merge_queue, []);
    assert.ok(!existsSync(join(repo, ".factory-worktrees", id)));
    assert.ok(git(repo, "branch", "--list", job(repo, id).branch));
    assert.equal(git(repo, "status", "--porcelain"), "");
  });

  test("rebases later jobs onto the new main", async () => {
    const a = await newId(repo, "alpha");
    const b = await newId(repo, "beta");
    await run(repo, "start", { skip_install: true });
    builderCommit(repo, a, "a.txt", "a\n");
    builderCommit(repo, b, "b.txt", "b\n");
    await run(repo, "enqueue", { id: a });
    await run(repo, "enqueue", { id: b });
    assert.equal((await run(repo, "merge")).ok, true);
    assert.equal((await run(repo, "merge")).ok, true);
    assert.ok(existsSync(join(repo, "a.txt")) && existsSync(join(repo, "b.txt")));
  });

  test("conflict goes back to the builder once, then needs-human", async () => {
    const a = await newId(repo, "alpha");
    const b = await newId(repo, "beta");
    await run(repo, "start", { skip_install: true });
    builderCommit(repo, a, "app.txt", "from a\n");
    builderCommit(repo, b, "app.txt", "from b\n");
    await run(repo, "enqueue", { id: a });
    await run(repo, "enqueue", { id: b });
    assert.equal((await run(repo, "merge")).ok, true);

    const first = await run(repo, "merge");
    assert.equal(first.reason, "rebase-conflict");
    assert.equal(first.next, "build");
    assert.match(first.detail, /app\.txt/);
    assert.equal(job(repo, b).stage, "build");

    await run(repo, "enqueue", { id: b });
    assert.equal((await run(repo, "merge")).next, "needs-human");
    assert.equal(job(repo, b).stage, "needs-human");
  });

  test("successful merge clears an earlier failure note", async () => {
    const a = await newId(repo, "alpha");
    const b = await newId(repo, "beta");
    await run(repo, "start", { skip_install: true });
    builderCommit(repo, a, "app.txt", "from a\n");
    builderCommit(repo, b, "app.txt", "from b\n");
    await run(repo, "enqueue", { id: a });
    await run(repo, "enqueue", { id: b });
    await run(repo, "merge");
    await run(repo, "merge");
    assert.equal(job(repo, b).note, "merge rebase-conflict");

    git(join(repo, job(repo, b).worktree), "reset", "-q", "--hard", "main");
    builderCommit(repo, b, "b.txt", "b\n");
    await run(repo, "enqueue", { id: b });
    assert.equal((await run(repo, "merge")).ok, true);
    assert.equal(job(repo, b).note, "");
  });

  test("failing tests are reported and nothing merges", async () => {
    await run(repo, "profile", { test: "echo boom; exit 3" });
    const id = await newId(repo, "x");
    await run(repo, "start", { skip_install: true });
    builderCommit(repo, id, "x.txt", "x\n");
    await run(repo, "enqueue", { id });
    const result = await run(repo, "merge");
    assert.equal(result.reason, "tests-failed");
    assert.match(result.detail, /boom/);
    assert.ok(!existsSync(join(repo, "x.txt")));
  });

  test("refuses while another merge holds the lock", async () => {
    const id = await newId(repo, "x");
    await run(repo, "start", { skip_install: true });
    await run(repo, "enqueue", { id });
    writeFileSync(join(repo, "factory", ".merge.lock"), "busy");
    await assert.rejects(run(repo, "merge"), /merge already running/);
  });

  test("cleanup removes leftover worktrees of merged jobs", async () => {
    const id = await newId(repo, "x");
    await run(repo, "start", { skip_install: true });
    await run(repo, "set", { id, stage: "merged" });
    assert.deepEqual((await run(repo, "cleanup")).removed, [id]);
    assert.ok(!existsSync(join(repo, ".factory-worktrees", id)));
  });

  test("archives the OpenSpec change at merge time", { skip: !hasOpenspec() && "openspec not installed" }, async () => {
    execFileSync("openspec", ["init", "--tools", "none"], { cwd: repo, stdio: "ignore" });
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "openspec");
    const id = await newId(repo, "greeting");
    await run(repo, "start", { skip_install: true });
    const wt = join(repo, job(repo, id).worktree);
    execFileSync("openspec", ["new", "change", id], { cwd: wt, stdio: "ignore" });
    const change = join(wt, "openspec", "changes", id);
    writeFileSync(join(change, "proposal.md"), "## Why\nGreet.\n\n## What Changes\n- greet\n");
    mkdirSync(join(change, "specs", "greeting"), { recursive: true });
    writeFileSync(
      join(change, "specs", "greeting", "spec.md"),
      "## ADDED Requirements\n\n### Requirement: Greet\nThe system SHALL greet.\n\n" +
        "#### Scenario: hello\n- **WHEN** asked\n- **THEN** it says hello\n",
    );
    writeFileSync(join(change, "tasks.md"), "- [x] 1.1 greet\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-qm", "spec + impl");
    await run(repo, "set", { id, files: [`${job(repo, id).worktree}/openspec/changes/${id}/proposal.md`] });
    await run(repo, "enqueue", { id });

    const result = await run(repo, "merge");
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(existsSync(join(repo, "openspec", "specs", "greeting", "spec.md")));
    assert.ok(!existsSync(join(repo, "openspec", "changes", id)));
    const archived = job(repo, id).files.filter((f) => f.includes("/archive/"));
    assert.equal(archived.length, 1);
    assert.ok(existsSync(join(repo, archived[0]!)));
  });
});

describe("branch naming", () => {
  test("uses {type}/{base}/{slug} with the job type and base", async () => {
    git(repo, "branch", "Branch_A");
    await run(repo, "new", { title: "Login form" });
    await run(repo, "new", { title: "Crash on save", type: "bugfix", base: "Branch_A" });
    await run(repo, "new", { title: "Rename config", type: "change" });
    await run(repo, "new", { title: "Fix token leak", type: "hotfix", base: "Branch_A" });
    assert.deepEqual(
      board(repo).jobs.map((j) => [j.type, j.base_branch, j.branch]),
      [
        ["feature", "main", "feature/main/login-form"],
        ["bugfix", "Branch_A", "bugfix/Branch_A/crash-save"],
        ["change", "main", "change/main/rename-config"],
        ["hotfix", "Branch_A", "hotfix/Branch_A/fix-token-leak"],
      ],
    );
  });

  test("same slug gets a numeric suffix", async () => {
    await run(repo, "new", { title: "Login form" });
    assert.equal((await run(repo, "new", { title: "login form" })).branch, "feature/main/login-form-002");
  });

  test("custom pattern", async () => {
    await run(repo, "profile", { branch_pattern: "factory/{id}" });
    assert.equal((await run(repo, "new", { title: "x" })).branch, "factory/job-001-x");
  });

  test("a pattern nesting under the base branch itself is rejected", async () => {
    await run(repo, "profile", { branch_pattern: "{base}/{id}" });
    await assert.rejects(run(repo, "new", { title: "x" }), /branch "main" exists/);
  });

  test("explains a git branch/folder clash", async () => {
    git(repo, "branch", "feature/main");
    await assert.rejects(run(repo, "new", { title: "x" }), /branch "feature\/main" exists/);
  });

  test("rejects unknown type and missing base", async () => {
    await assert.rejects(run(repo, "new", { title: "x", type: "chore" }), /unknown job type/);
    await assert.rejects(run(repo, "new", { title: "x", base: "nope" }), /does not exist/);
    await assert.rejects(run(repo, "profile", { integration: "yolo" }), /unknown integration/);
  });

  test("boards from older versions are upgraded on load", async () => {
    const old = board(repo) as unknown as Record<string, any>;
    old.repo = { main_branch: "main", base_port: 3000, install: "", test: "true", dev: "" };
    writeFileSync(join(repo, "factory", "board.json"), JSON.stringify(old));
    const status = await run(repo, "status");
    assert.equal(status.repo.base_branch, "main");
    assert.equal(status.repo.integration, "merge");
  });
});

describe("integration modes", () => {
  beforeEach(() => {
    git(repo, "checkout", "-qb", "Branch_A");
    writeFileSync(join(repo, "a.txt"), "parent work\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Branch_A work");
    git(repo, "checkout", "-q", "main");
  });

  test("merge mode stacks jobs onto a parent branch without touching main", async () => {
    await run(repo, "profile", { base_branch: "Branch_A" });
    const a = await newId(repo, "alpha");
    const b = await newId(repo, "beta");
    await run(repo, "start", { skip_install: true });
    assert.ok(existsSync(join(repo, job(repo, a).worktree, "a.txt")));
    builderCommit(repo, a, "alpha.txt", "a\n");
    builderCommit(repo, b, "beta.txt", "b\n");
    await run(repo, "enqueue", { id: a });
    await run(repo, "enqueue", { id: b });
    const mainBefore = git(repo, "rev-parse", "main");

    assert.equal((await run(repo, "merge")).merged_into, "Branch_A");
    assert.equal((await run(repo, "merge")).ok, true);
    assert.equal(git(repo, "rev-parse", "main"), mainBefore);
    const files = git(repo, "ls-tree", "--name-only", "Branch_A").split("\n");
    assert.ok(["a.txt", "alpha.txt", "beta.txt"].every((f) => files.includes(f)));
    assert.equal(git(repo, "rev-list", "--merges", "--count", "Branch_A"), "0");
  });

  test("merge mode refuses a protected base", async () => {
    await run(repo, "profile", { base_branch: "Branch_A", protected_branches: ["Branch_A"] });
    const id = await newId(repo, "x");
    await run(repo, "start", { skip_install: true });
    builderCommit(repo, id, "x.txt", "x\n");
    await run(repo, "enqueue", { id });
    const before = git(repo, "rev-parse", "Branch_A");
    const result = await run(repo, "merge");
    assert.equal(result.reason, "base-protected");
    assert.equal(job(repo, id).stage, "needs-human");
    assert.equal(git(repo, "rev-parse", "Branch_A"), before);
  });

  test("merge mode waits while the base is checked out elsewhere", async () => {
    await run(repo, "profile", { base_branch: "Branch_A" });
    const id = await newId(repo, "x");
    await run(repo, "start", { skip_install: true });
    await run(repo, "enqueue", { id });
    git(repo, "worktree", "add", "-q", join(repo, "..", "elsewhere"), "Branch_A");
    assert.equal((await run(repo, "merge")).reason, "base-checked-out");
    assert.equal(job(repo, id).stage, "merge-queue");
  });

  test("branch mode rebases and tests, leaves the base alone, stops at ready", async () => {
    await run(repo, "profile", { base_branch: "Branch_A", integration: "branch" });
    const id = await newId(repo, "alpha");
    await run(repo, "start", { skip_install: true });
    builderCommit(repo, id, "alpha.txt", "a\n");
    git(repo, "checkout", "-q", "Branch_A");
    writeFileSync(join(repo, "later.txt"), "moved on\n");
    git(repo, "add", "later.txt");
    git(repo, "commit", "-qm", "base moved");
    git(repo, "checkout", "-q", "main");
    await run(repo, "enqueue", { id });
    const before = git(repo, "rev-parse", "Branch_A");

    const result = await run(repo, "merge");
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.branch, "feature/Branch_A/alpha");
    assert.equal(job(repo, id).stage, "ready");
    assert.equal(git(repo, "rev-parse", "Branch_A"), before);
    assert.equal(git(repo, "merge-base", "Branch_A", job(repo, id).branch), before);
    assert.ok(existsSync(join(repo, job(repo, id).worktree)));
    assert.deepEqual((await run(repo, "cleanup")).merged_detected, []);
  });

  test("cleanup detects a ready branch a human merged", async () => {
    await run(repo, "profile", { base_branch: "Branch_A", integration: "branch" });
    const id = await newId(repo, "alpha");
    await run(repo, "start", { skip_install: true });
    builderCommit(repo, id, "alpha.txt", "a\n");
    await run(repo, "enqueue", { id });
    await run(repo, "merge");
    git(repo, "checkout", "-q", "Branch_A");
    git(repo, "merge", "-q", "--no-ff", "-m", "human merge", job(repo, id).branch);
    git(repo, "checkout", "-q", "main");

    const result = await run(repo, "cleanup");
    assert.deepEqual(result.merged_detected, [id]);
    assert.deepEqual(result.removed, [id]);
    assert.equal(job(repo, id).stage, "merged");
  });

  test("branch mode pushes when configured", async () => {
    const remote = join(repo, "..", "remote.git");
    git(repo, "init", "-q", "--bare", remote);
    git(repo, "remote", "add", "origin", remote);
    await run(repo, "profile", { base_branch: "Branch_A", integration: "branch", push: true });
    const id = await newId(repo, "alpha");
    await run(repo, "start", { skip_install: true });
    builderCommit(repo, id, "alpha.txt", "a\n");
    await run(repo, "enqueue", { id });
    assert.equal((await run(repo, "merge")).pushed, true);
    assert.equal(git(remote, "rev-parse", job(repo, id).branch), git(repo, "rev-parse", job(repo, id).branch));
  });

  test("branch mode archives OpenSpec on the job branch", { skip: !hasOpenspec() && "openspec not installed" }, async () => {
    git(repo, "checkout", "-q", "Branch_A");
    execFileSync("openspec", ["init", "--tools", "none"], { cwd: repo, stdio: "ignore" });
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "openspec");
    git(repo, "checkout", "-q", "main");
    await run(repo, "profile", { base_branch: "Branch_A", integration: "branch" });
    const id = await newId(repo, "greeting");
    await run(repo, "start", { skip_install: true });
    const wt = join(repo, job(repo, id).worktree);
    execFileSync("openspec", ["new", "change", id], { cwd: wt, stdio: "ignore" });
    const change = join(wt, "openspec", "changes", id);
    writeFileSync(join(change, "proposal.md"), "## Why\nGreet.\n\n## What Changes\n- greet\n");
    mkdirSync(join(change, "specs", "greeting"), { recursive: true });
    writeFileSync(
      join(change, "specs", "greeting", "spec.md"),
      "## ADDED Requirements\n\n### Requirement: Greet\nThe system SHALL greet.\n\n" +
        "#### Scenario: hello\n- **WHEN** asked\n- **THEN** it says hello\n",
    );
    writeFileSync(join(change, "tasks.md"), "- [x] 1.1 greet\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-qm", "spec + impl");
    await run(repo, "enqueue", { id });

    const result = await run(repo, "merge");
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(existsSync(join(wt, "openspec", "specs", "greeting", "spec.md")));
    assert.equal(git(wt, "status", "--porcelain"), "");
    assert.equal(git(repo, "ls-tree", "--name-only", "main", "openspec"), "");
    assert.ok(git(repo, "ls-tree", "-r", "--name-only", job(repo, id).branch).includes("openspec/specs/greeting/spec.md"));
  });
});

describe("session isolation", () => {
  test("two sessions in the same repo do not see each other's jobs", async () => {
    const a = await runAs(repo, "sess-a", "new", { title: "session-a-widget" });
    const beforeB = await runAs(repo, "sess-b", "status");
    assert.equal(beforeB.jobs.length, 0);

    const b = await runAs(repo, "sess-b", "new", { title: "session-b-export" });
    const statusA = await runAs(repo, "sess-a", "status");
    const statusB = await runAs(repo, "sess-b", "status");
    assert.deepEqual(
      statusA.jobs.map((j: { id: string }) => j.id),
      [a.id],
    );
    assert.deepEqual(
      statusB.jobs.map((j: { id: string }) => j.id),
      [b.id],
    );
    assert.equal(job(repo, a.id).session_id, "sess-a");
    assert.equal(job(repo, b.id).session_id, "sess-b");
    assert.equal(board(repo).jobs.length, 2);
    assert.equal((await run(repo, "status")).jobs.length, 2);
  });

  test("one session still sees all of its own jobs", async () => {
    await runAs(repo, "sess-a", "new", { title: "one" });
    await runAs(repo, "sess-a", "new", { title: "two" });
    assert.equal((await runAs(repo, "sess-a", "status")).jobs.length, 2);
  });

  test("cross-session set is refused", async () => {
    const a = await runAs(repo, "sess-a", "new", { title: "a" });
    await assert.rejects(runAs(repo, "sess-b", "set", { id: a.id, stage: "needs-human" }), /another OMP session/);
    assert.equal(job(repo, a.id).stage, "queued");
  });

  test("start slots are counted per session", async () => {
    await run(repo, "parallel", { n: 1 });
    const a1 = await runAs(repo, "sess-a", "new", { title: "a1" });
    const a2 = await runAs(repo, "sess-a", "new", { title: "a2" });
    const b1 = await runAs(repo, "sess-b", "new", { title: "b1" });
    const startedA = await runAs(repo, "sess-a", "start", { skip_install: true });
    assert.deepEqual(
      startedA.started.map((j: Job) => j.id),
      [a1.id],
    );
    assert.equal(job(repo, a2.id).stage, "queued");
    const startedB = await runAs(repo, "sess-b", "start", { skip_install: true });
    assert.deepEqual(
      startedB.started.map((j: Job) => j.id),
      [b1.id],
    );
    assert.equal(job(repo, b1.id).stage, "spec");
  });

  test("legacy jobs without session_id stay visible to every session", async () => {
    const id = await newId(repo, "legacy");
    assert.equal(job(repo, id).session_id, undefined);
    assert.equal((await runAs(repo, "sess-a", "status")).jobs.length, 1);
    await runAs(repo, "sess-a", "set", { id, note: "claimed" });
    assert.equal(job(repo, id).note, "claimed");
  });

  test("merge without id skips another session's queue head", async () => {
    const a = await runAs(repo, "sess-a", "new", { title: "alpha" });
    const b = await runAs(repo, "sess-b", "new", { title: "beta" });
    await runAs(repo, "sess-a", "start", { skip_install: true });
    await runAs(repo, "sess-b", "start", { skip_install: true });
    builderCommit(repo, a.id, "a.txt", "a\n");
    builderCommit(repo, b.id, "b.txt", "b\n");
    await runAs(repo, "sess-a", "enqueue", { id: a.id });
    await runAs(repo, "sess-b", "enqueue", { id: b.id });
    assert.deepEqual(board(repo).merge_queue, [a.id, b.id]);
    assert.deepEqual((await runAs(repo, "sess-b", "status")).merge_queue, [b.id]);

    const merged = await runAs(repo, "sess-b", "merge");
    assert.equal(merged.ok, true);
    assert.equal(merged.id, b.id);
    assert.equal(job(repo, a.id).stage, "merge-queue");
    assert.equal(job(repo, b.id).stage, "merged");
  });
});
