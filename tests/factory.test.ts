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
    assert.equal(board(repo).repo.main_branch, "main");
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
    assert.equal(first.branch, `factory/${ids[0]}`);
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
    assert.ok(git(repo, "branch", "--list", `factory/${id}`));
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
