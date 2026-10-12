/**
 * Deterministic state and git plumbing for the /factory skill.
 *
 * The orchestrator calls this (through the `factory` tool) for everything that must be
 * exact: board.json edits, job ids, worktrees, ports, round bookkeeping and the serial
 * merge queue. Judgement (specs, code, reviews) stays with the agents.
 *
 * Runs inside OMP's process, so every external command is async: a blocking call would
 * freeze the session and its in-process subagents for the duration of a test run.
 */

import { spawn } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const TEMPLATES = fileURLToPath(new URL("../templates/", import.meta.url));
export const REVIEWERS = ["security", "ux", "ui", "code"] as const;
export const STAGES = [
  "queued",
  "spec",
  "build",
  "review",
  "approve",
  "merge-queue",
  "merged",
  "needs-human",
] as const;
const ACTIVE_STAGES = new Set<Stage>(["spec", "build", "review", "approve"]);
const WORKTREES_DIR = ".factory-worktrees";
const AGENTS_BEGIN = "<!-- factory:begin -->";
const AGENTS_END = "<!-- factory:end -->";
const MAX_MERGE_ATTEMPTS = 2;
const OUTPUT_TAIL = 3000;
const SLUG_WORDS = 5;
const SLUG_STOPWORDS = new Set(
  ("a an the to of for and or that which with as in on into by is are be it its this so should please " +
    "add implement create make new").split(" "),
);

export type Reviewer = (typeof REVIEWERS)[number];
export type Stage = (typeof STAGES)[number];
export type Verdict = "PASS" | "CHANGES" | "INVALID" | "pending";

export interface RepoProfile {
  main_branch: string;
  base_port: number;
  install: string;
  test: string;
  dev: string;
  language?: string;
}

export interface Job {
  id: string;
  title: string;
  number: number;
  branch: string;
  worktree: string;
  port: number;
  stage: Stage;
  round: number;
  merge_attempts: number;
  files: string[];
  reviews: Record<Reviewer, Verdict>;
  note: string;
  created: string;
  updated: string;
  base?: string;
  merged_at?: string;
}

export interface Board {
  max_parallel: number;
  repo: RepoProfile;
  merge_queue: string[];
  jobs: Job[];
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A factory command could not be completed. */
export class FactoryError extends Error {
  override name = "FactoryError";
}

const now = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const tail = (text: string): string => text.slice(-OUTPUT_TAIL);
const pendingReviews = (): Record<Reviewer, Verdict> =>
  Object.fromEntries(REVIEWERS.map((r) => [r, "pending"])) as Record<Reviewer, Verdict>;

/** Run a command (argv array, or a shell string) without throwing on non-zero exit. */
export function sh(
  cmd: string[] | string,
  cwd: string,
  env: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const options = { cwd, env: { ...process.env, ...env }, signal };
    const child =
      typeof cmd === "string"
        ? spawn(cmd, { ...options, shell: true })
        : spawn(cmd[0] ?? "", cmd.slice(1), options);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => resolve({ code: 127, stdout, stderr: stderr + String(err) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Run git and return trimmed stdout, throwing FactoryError on failure. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await sh(["git", ...args], cwd);
  if (result.code !== 0) throw new FactoryError(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** Turn a feature request into a short kebab-case slug (at most 5 meaningful words). */
export function slugify(title: string): string {
  const words = (title.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !SLUG_STOPWORDS.has(w));
  return words.slice(0, SLUG_WORDS).join("-").slice(0, 40).replace(/-+$/, "") || "job";
}

/** First-line verdict of a review/decision file: null if missing, INVALID if unrecognised. */
export function readVerdict<T extends string>(path: string, allowed: readonly T[]): T | "INVALID" | null {
  if (!existsSync(path)) return null;
  const first = readFileSync(path, "utf8")
    .split("\n")
    .find((line) => line.trim());
  const words = first?.toUpperCase().match(/[A-Z]+/g) ?? [];
  return (words.find((w) => (allowed as readonly string[]).includes(w)) as T | undefined) ?? "INVALID";
}

/** All factory operations against one main checkout. */
export class Factory {
  readonly root: string;
  readonly state: string;
  readonly boardPath: string;
  readonly jobsDir: string;

  constructor(root: string) {
    this.root = root;
    this.state = join(root, "factory");
    this.boardPath = join(this.state, "board.json");
    this.jobsDir = join(this.state, "jobs");
  }

  /** Locate the main checkout from any directory inside the repo; refuse worktrees. */
  static async fromCwd(cwd: string): Promise<Factory> {
    const top = await git(cwd, "rev-parse", "--show-toplevel");
    const common = await git(top, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const mainRoot = basename(common) === ".git" ? dirname(common) : top;
    if (realpathSync(mainRoot) !== realpathSync(top)) {
      throw new FactoryError(`run the factory from the main checkout (${mainRoot}), not a worktree`);
    }
    return new Factory(top);
  }

  // ----- board -----------------------------------------------------------------------

  load(): Board {
    if (!existsSync(this.boardPath)) throw new FactoryError("factory not initialised: run `/factory init`");
    return JSON.parse(readFileSync(this.boardPath, "utf8")) as Board;
  }

  save(board: Board): void {
    const tmp = `${this.boardPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(board, null, 2)}\n`);
    renameSync(tmp, this.boardPath);
  }

  job(board: Board, id: string): Job {
    const job = board.jobs.find((j) => j.id === id);
    if (!job) throw new FactoryError(`unknown job ${id}`);
    return job;
  }

  private touch(job: Job, fields: Partial<Job> = {}): Job {
    Object.assign(job, fields, { updated: now() });
    return job;
  }

  private addFile(job: Job, rel: string): void {
    if (!job.files.includes(rel)) job.files.push(rel);
  }

  // ----- setup -----------------------------------------------------------------------

  /** Create factory state, gitignore entries, AGENTS.md section and OpenSpec. */
  async init(opts: { maxParallel?: number; basePort?: number; openspec?: boolean } = {}) {
    const { maxParallel = 3, basePort = 3000, openspec = true } = opts;
    mkdirSync(this.jobsDir, { recursive: true });
    writeFileSync(join(this.jobsDir, ".gitkeep"), "");
    const created: string[] = [];
    if (!existsSync(this.boardPath)) {
      const branch = await git(this.root, "rev-parse", "--abbrev-ref", "HEAD");
      this.save({
        max_parallel: maxParallel,
        repo: { main_branch: branch, base_port: basePort, install: "", test: "", dev: "" },
        merge_queue: [],
        jobs: [],
      });
      created.push("factory/board.json");
    }
    const backlog = join(this.state, "backlog.md");
    if (!existsSync(backlog)) {
      copyFileSync(join(TEMPLATES, "backlog.md"), backlog);
      created.push("factory/backlog.md");
    }
    copyFileSync(join(TEMPLATES, "dashboard.html"), join(this.state, "dashboard.html"));
    this.ensureGitignore();
    this.ensureAgentsSection();
    if (openspec && !existsSync(join(this.root, "openspec"))) {
      const result = await sh(["openspec", "init", "--tools", "oh-my-pi"], this.root);
      if (result.code !== 0) {
        throw new FactoryError(`openspec init failed: ${(result.stderr || result.stdout).trim()}`);
      }
      created.push("openspec/");
    }
    return { root: this.root, created, board: this.load() };
  }

  private ensureGitignore(): void {
    const path = join(this.root, ".gitignore");
    const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
    const missing = [`${WORKTREES_DIR}/`, "factory/.merge.lock", "factory/board.json.tmp"].filter(
      (w) => !lines.includes(w),
    );
    if (missing.length) writeFileSync(path, `${[...lines, ...missing].join("\n")}\n`);
  }

  private ensureAgentsSection(): void {
    const path = join(this.root, "AGENTS.md");
    let text = existsSync(path) ? readFileSync(path, "utf8") : "";
    const section = readFileSync(join(TEMPLATES, "AGENTS.section.md"), "utf8").trim();
    const block = `${AGENTS_BEGIN}\n${section}\n${AGENTS_END}`;
    const start = text.indexOf(AGENTS_BEGIN);
    const end = text.indexOf(AGENTS_END);
    if (start >= 0 && end > start) {
      text = text.slice(0, start) + block + text.slice(end + AGENTS_END.length);
    } else {
      text = (text.trim() ? `${text.trimEnd()}\n\n` : "") + block;
    }
    writeFileSync(path, `${text.trimEnd()}\n`);
  }

  /** Record the repo's install/test/dev commands, language, main branch or base port. */
  profile(updates: Partial<RepoProfile>): RepoProfile {
    const board = this.load();
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) (board.repo as unknown as Record<string, unknown>)[key] = value;
    }
    this.save(board);
    return board.repo;
  }

  parallel(n: number) {
    if (!Number.isInteger(n) || n < 1) throw new FactoryError("max_parallel must be an integer >= 1");
    const board = this.load();
    board.max_parallel = n;
    this.save(board);
    return { max_parallel: n };
  }

  // ----- job lifecycle ---------------------------------------------------------------

  /** Register a queued job with the next id (job-NNN-slug). */
  newJob(title: string): Job {
    const board = this.load();
    const numbers = board.jobs.map((j) => Number(/^job-(\d+)-/.exec(j.id)?.[1] ?? 0));
    const number = Math.max(0, ...numbers) + 1;
    const id = `job-${String(number).padStart(3, "0")}-${slugify(title)}`;
    const job: Job = {
      id,
      title,
      number,
      branch: `factory/${id}`,
      worktree: `${WORKTREES_DIR}/${id}`,
      port: board.repo.base_port + number,
      stage: "queued",
      round: 0,
      merge_attempts: 0,
      files: [],
      reviews: pendingReviews(),
      note: "",
      created: now(),
      updated: now(),
    };
    board.jobs.push(job);
    this.save(board);
    return job;
  }

  /** Start queued jobs while slots are free: worktree + branch from main HEAD, install. */
  async start(opts: { install?: boolean; signal?: AbortSignal } = {}) {
    const { install = true, signal } = opts;
    const board = this.load();
    let active = board.jobs.filter((j) => ACTIVE_STAGES.has(j.stage)).length;
    const base = await git(this.root, "rev-parse", board.repo.main_branch);
    const started: Job[] = [];
    const warnings: { id: string; install: string }[] = [];
    for (const job of board.jobs) {
      if (active >= board.max_parallel) break;
      if (job.stage !== "queued") continue;
      const wt = join(this.root, job.worktree);
      await git(this.root, "worktree", "add", "-q", wt, "-b", job.branch, base);
      mkdirSync(join(this.jobsDir, job.id), { recursive: true });
      if (install && board.repo.install) {
        const result = await sh(board.repo.install, wt, { PORT: String(job.port) }, signal);
        if (result.code !== 0) warnings.push({ id: job.id, install: tail(result.stderr || result.stdout) });
      }
      this.touch(job, { stage: "spec", base });
      started.push(job);
      active += 1;
      this.save(board);
    }
    this.save(board);
    const stillQueued = board.jobs.filter((j) => j.stage === "queued").map((j) => j.id);
    return { started, still_queued: stillQueued, warnings };
  }

  /** Update a job's stage, round, note or file list. */
  set(id: string, opts: { stage?: string; round?: number; note?: string; files?: string[] }): Job {
    const board = this.load();
    const job = this.job(board, id);
    if (opts.stage !== undefined) {
      if (!(STAGES as readonly string[]).includes(opts.stage)) {
        throw new FactoryError(`unknown stage ${opts.stage}; expected one of ${STAGES.join(", ")}`);
      }
      job.stage = opts.stage as Stage;
      if (opts.stage !== "merge-queue") board.merge_queue = board.merge_queue.filter((j) => j !== id);
    }
    if (opts.round !== undefined) job.round = opts.round;
    if (opts.note !== undefined) job.note = opts.note;
    for (const rel of opts.files ?? []) this.addFile(job, rel);
    this.touch(job);
    this.save(board);
    return job;
  }

  /** Open review round N: folder, stage=review, reviewer chips reset. */
  round(id: string, n: number) {
    const board = this.load();
    const job = this.job(board, id);
    const folder = join(this.jobsDir, id, `round-${n}`);
    mkdirSync(folder, { recursive: true });
    this.touch(job, { stage: "review", round: n, reviews: pendingReviews() });
    this.save(board);
    return {
      id,
      round: n,
      round_dir: folder,
      outputs: Object.fromEntries(REVIEWERS.map((r) => [r, join(folder, `review-${r}.md`)])),
    };
  }

  /** Read verdicts of the current round; complete only when all four files exist. */
  collect(id: string) {
    const board = this.load();
    const job = this.job(board, id);
    const relDir = `factory/jobs/${id}/round-${job.round}`;
    const verdicts = pendingReviews();
    for (const reviewer of REVIEWERS) {
      const rel = `${relDir}/review-${reviewer}.md`;
      const verdict = readVerdict(join(this.root, rel), ["PASS", "CHANGES"] as const);
      verdicts[reviewer] = verdict ?? "pending";
      if (verdict) this.addFile(job, rel);
    }
    this.touch(job, { reviews: verdicts });
    this.save(board);
    const values = Object.values(verdicts);
    const complete = values.every((v) => v !== "pending");
    return {
      id,
      round: job.round,
      complete,
      verdicts,
      invalid: REVIEWERS.filter((r) => verdicts[r] === "INVALID"),
      all_pass: complete && values.every((v) => v === "PASS"),
      changes: REVIEWERS.filter((r) => verdicts[r] === "CHANGES"),
    };
  }

  /** Apply decision.md: APPROVE -> merge queue, ESCALATE -> needs-human. */
  decide(id: string) {
    const rel = `factory/jobs/${id}/decision.md`;
    const decision = readVerdict(join(this.root, rel), ["APPROVE", "ESCALATE"] as const);
    if (decision !== "APPROVE" && decision !== "ESCALATE") {
      throw new FactoryError(`${rel} missing or does not start with APPROVE/ESCALATE`);
    }
    const board = this.load();
    const job = this.job(board, id);
    this.addFile(job, rel);
    if (decision === "APPROVE") this.enqueueJob(board, job);
    else this.touch(job, { stage: "needs-human", note: "approver escalated" });
    this.save(board);
    return { id, decision, stage: job.stage };
  }

  /** Put a job in the merge queue (/factory approve, and after a merge fix). */
  enqueue(id: string) {
    const board = this.load();
    this.enqueueJob(board, this.job(board, id));
    this.save(board);
    return { id, merge_queue: board.merge_queue };
  }

  private enqueueJob(board: Board, job: Job): void {
    if (job.stage === "merged") throw new FactoryError(`${job.id} is already merged`);
    this.touch(job, { stage: "merge-queue" });
    if (!board.merge_queue.includes(job.id)) board.merge_queue.push(job.id);
  }

  // ----- merge queue -----------------------------------------------------------------

  private acquireMergeLock(): () => void {
    const lock = join(this.state, ".merge.lock");
    let fd: number;
    try {
      fd = openSync(lock, "wx");
    } catch {
      throw new FactoryError(`merge already running (remove ${lock} if stale)`);
    }
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return () => rmSync(lock, { force: true });
  }

  /** Merge the next queued job: rebase, test, fast-forward, archive, remove worktree. */
  async merge(id?: string, signal?: AbortSignal) {
    const release = this.acquireMergeLock();
    try {
      return await this.mergeLocked(id, signal);
    } finally {
      release();
    }
  }

  private async mergeLocked(id: string | undefined, signal?: AbortSignal) {
    const board = this.load();
    const next = id ?? board.merge_queue[0];
    if (!next) return { ok: true, merged: null, detail: "merge queue empty" };
    const job = this.job(board, next);
    const { main_branch: main, test } = board.repo;
    const wt = join(this.root, job.worktree);

    const current = await git(this.root, "rev-parse", "--abbrev-ref", "HEAD");
    const porcelain = (await sh(["git", "status", "--porcelain"], this.root)).stdout;
    const dirty = porcelain.split("\n").filter((line) => line && !line.slice(3).startsWith("factory/"));
    if (current !== main || dirty.length) {
      return {
        ok: false,
        id: job.id,
        reason: "main-not-clean",
        next: "retry",
        detail: `main checkout must be on ${main} with no changes outside factory/: ${dirty.join(", ")}`,
      };
    }

    if ((await sh(["git", "rebase", main], wt)).code !== 0) {
      const conflicts = (await sh(["git", "diff", "--name-only", "--diff-filter=U"], wt)).stdout.trim();
      await sh(["git", "rebase", "--abort"], wt);
      return this.mergeFailed(board, job, "rebase-conflict", `conflicting files:\n${conflicts}`);
    }

    if (test) {
      const tests = await sh(test, wt, { PORT: String(job.port) }, signal);
      if (tests.code !== 0) return this.mergeFailed(board, job, "tests-failed", tail(tests.stdout + tests.stderr));
    }

    await git(this.root, "merge", "--ff-only", "-q", job.branch);
    board.merge_queue = board.merge_queue.filter((j) => j !== job.id);
    let archived: string | null;
    try {
      archived = await this.archive(job);
    } catch (err) {
      this.touch(job, { stage: "needs-human", note: "merged, but OpenSpec archive failed" });
      this.save(board);
      return { ok: false, id: job.id, reason: "archive-failed", detail: String(err), next: "needs-human" };
    }
    this.touch(job, { stage: "merged", note: "", merged_at: now() });
    this.save(board);

    const paths = ["openspec", "factory"].filter((p) => existsSync(join(this.root, p)));
    await git(this.root, "add", "-A", "--", ...paths);
    if ((await sh(["git", "diff", "--cached", "--quiet"], this.root)).code !== 0) {
      await git(this.root, "commit", "-q", "-m", `factory: archive ${job.id}`);
    }
    const removed = await sh(["git", "worktree", "remove", wt], this.root);
    return {
      ok: true,
      id: job.id,
      archived,
      worktree_removed: removed.code === 0,
      detail: removed.stderr.trim(),
      merge_queue: board.merge_queue,
    };
  }

  private mergeFailed(board: Board, job: Job, reason: string, detail: string) {
    job.merge_attempts = (job.merge_attempts ?? 0) + 1;
    const next: Stage = job.merge_attempts < MAX_MERGE_ATTEMPTS ? "build" : "needs-human";
    this.touch(job, { stage: next, note: `merge ${reason}` });
    board.merge_queue = board.merge_queue.filter((j) => j !== job.id);
    this.save(board);
    return { ok: false, id: job.id, reason, detail, next };
  }

  /** Archive the job's OpenSpec change in the main checkout and repoint its files. */
  private async archive(job: Job): Promise<string | null> {
    if (!existsSync(join(this.root, "openspec", "changes", job.id))) return null;
    const result = await sh(["openspec", "archive", job.id, "-y"], this.root);
    if (result.code !== 0) {
      throw new FactoryError(`openspec archive ${job.id} failed: ${tail(result.stdout + result.stderr)}`);
    }
    const archiveRoot = join(this.root, "openspec", "changes", "archive");
    const match = readdirSync(archiveRoot)
      .filter((name) => name.endsWith(`-${job.id}`))
      .sort()
      .at(-1);
    if (!match) return null;
    const archived = relative(this.root, join(archiveRoot, match));
    const oldPrefix = `${job.worktree}/openspec/changes/${job.id}/`;
    job.files = job.files.map((f) => f.replace(oldPrefix, `${archived}/`));
    return archived;
  }

  // ----- housekeeping ----------------------------------------------------------------

  status() {
    const board = this.load();
    const active = board.jobs.filter((j) => ACTIVE_STAGES.has(j.stage)).length;
    return {
      max_parallel: board.max_parallel,
      free_slots: Math.max(board.max_parallel - active, 0),
      repo: board.repo,
      merge_queue: board.merge_queue,
      jobs: board.jobs.map(({ id, stage, round, port, branch, reviews, note }) => ({
        id,
        stage,
        round,
        port,
        branch,
        reviews,
        note,
      })),
    };
  }

  /** Remove worktrees of merged jobs and prune git's worktree list. */
  async cleanup() {
    const board = this.load();
    const removed: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const job of board.jobs) {
      const wt = join(this.root, job.worktree);
      if (job.stage !== "merged" || !existsSync(wt)) continue;
      const result = await sh(["git", "worktree", "remove", wt], this.root);
      if (result.code === 0) removed.push(job.id);
      else failed.push({ id: job.id, error: result.stderr.trim() });
    }
    await git(this.root, "worktree", "prune");
    return { removed, failed };
  }
}
