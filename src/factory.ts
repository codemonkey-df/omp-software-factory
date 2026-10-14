/**
 * Deterministic state and git plumbing for the /factory skill.
 *
 * The orchestrator calls this (through the `factory` tool) for everything that must be
 * exact: board.json edits, job ids, branch names, worktrees, ports, round bookkeeping and
 * the serial integration queue. Judgement (specs, code, reviews) stays with the agents.
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
  "ready",
  "merged",
  "needs-human",
] as const;
export const JOB_TYPES = ["feature", "bugfix", "change", "hotfix"] as const;
/** merge: stack approved jobs onto their base branch. branch: hand off a tested branch for a human to merge. */
export const INTEGRATIONS = ["merge", "branch"] as const;
export const DEFAULT_BRANCH_PATTERN = "{type}/{base}/{slug}";

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
export type JobType = (typeof JOB_TYPES)[number];
export type Integration = (typeof INTEGRATIONS)[number];
export type Verdict = "PASS" | "CHANGES" | "INVALID" | "pending";

export interface RepoProfile {
  base_branch: string;
  integration: Integration;
  branch_pattern: string;
  push: boolean;
  remote: string;
  protected_branches: string[];
  base_port: number;
  install: string;
  test: string;
  dev: string;
  language?: string;
  /** Boards written before base_branch existed. */
  main_branch?: string;
}

export interface Job {
  id: string;
  title: string;
  type: JobType;
  number: number;
  base_branch: string;
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
  base_sha?: string;
  merged_at?: string;
  ready_at?: string;
  pushed?: boolean;
  /** OMP session that created the job; omitted on CLI/legacy boards. */
  session_id?: string;
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

async function branchExists(cwd: string, name: string): Promise<boolean> {
  return (await sh(["git", "show-ref", "--verify", "--quiet", `refs/heads/${name}`], cwd)).code === 0;
}

/** Turn a feature request into a short kebab-case slug (at most 5 meaningful words). */
export function slugify(title: string): string {
  const words = (title.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !SLUG_STOPWORDS.has(w));
  return words.slice(0, SLUG_WORDS).join("-").slice(0, 40).replace(/-+$/, "") || "job";
}

/** Fill a branch pattern such as `{type}/{base}/{slug}`. */
export function renderBranch(pattern: string, fields: Record<"type" | "base" | "slug" | "id" | "number", string>) {
  return pattern.replace(/\{(type|base|slug|id|number)\}/g, (_, key: keyof typeof fields) => fields[key]);
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

function oneOf<T extends string>(value: string, allowed: readonly T[], what: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new FactoryError(`unknown ${what} "${value}"; expected one of ${allowed.join(", ")}`);
  }
  return value as T;
}

/**
 * Whether a job is in this OMP session's view. No session (CLI) sees everything.
 * Jobs without `session_id` stay visible so older boards keep working.
 */
export function sessionOwnsJob(job: Pick<Job, "session_id">, sessionId?: string): boolean {
  if (!sessionId) return true;
  return job.session_id === undefined || job.session_id === sessionId;
}

/** All factory operations against one main checkout. */
export class Factory {
  readonly root: string;
  readonly state: string;
  readonly boardPath: string;
  readonly jobsDir: string;
  /** When set, status/start/merge/mutations only see jobs tagged with this OMP session. */
  readonly sessionId?: string;

  constructor(root: string, sessionId?: string) {
    this.root = existsSync(root) ? realpathSync(root) : root;
    this.state = join(root, "factory");
    this.boardPath = join(this.state, "board.json");
    this.jobsDir = join(this.state, "jobs");
    this.sessionId = sessionId;
  }

  /** Locate the main checkout from any directory inside the repo; refuse worktrees. */
  static async fromCwd(cwd: string, sessionId?: string): Promise<Factory> {
    const top = await git(cwd, "rev-parse", "--show-toplevel");
    const common = await git(top, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const mainRoot = basename(common) === ".git" ? dirname(common) : top;
    if (realpathSync(mainRoot) !== realpathSync(top)) {
      throw new FactoryError(`run the factory from the main checkout (${mainRoot}), not a worktree`);
    }
    return new Factory(top, sessionId);
  }

  // ----- board -----------------------------------------------------------------------

  load(): Board {
    if (!existsSync(this.boardPath)) throw new FactoryError("factory not initialised: run `/factory init`");
    const board = JSON.parse(readFileSync(this.boardPath, "utf8")) as Board;
    const repo = board.repo;
    repo.base_branch ??= repo.main_branch ?? "main";
    delete repo.main_branch;
    repo.integration ??= "merge";
    repo.branch_pattern ??= DEFAULT_BRANCH_PATTERN;
    repo.push ??= false;
    repo.remote ??= "origin";
    repo.protected_branches ??= [];
    for (const job of board.jobs) {
      job.type ??= "feature";
      job.base_branch ??= repo.base_branch;
    }
    return board;
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

  private isVisible(job: Job): boolean {
    return sessionOwnsJob(job, this.sessionId);
  }

  private visibleJobs(board: Board): Job[] {
    return board.jobs.filter((j) => this.isVisible(j));
  }

  private visibleQueue(board: Board): string[] {
    return board.merge_queue.filter((id) => {
      const job = board.jobs.find((j) => j.id === id);
      return job !== undefined && this.isVisible(job);
    });
  }

  private assertOwned(job: Job): void {
    if (!this.isVisible(job)) {
      throw new FactoryError(`${job.id} belongs to another OMP session`);
    }
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
  async init(
    opts: { maxParallel?: number; basePort?: number; baseBranch?: string; integration?: string; openspec?: boolean } = {},
  ) {
    const { maxParallel = 3, basePort = 3000, openspec = true } = opts;
    mkdirSync(this.jobsDir, { recursive: true });
    writeFileSync(join(this.jobsDir, ".gitkeep"), "");
    const created: string[] = [];
    if (!existsSync(this.boardPath)) {
      const base = opts.baseBranch ?? (await git(this.root, "rev-parse", "--abbrev-ref", "HEAD"));
      if (!(await branchExists(this.root, base))) throw new FactoryError(`base branch "${base}" does not exist`);
      this.save({
        max_parallel: maxParallel,
        repo: {
          base_branch: base,
          integration: oneOf(opts.integration ?? "merge", INTEGRATIONS, "integration"),
          branch_pattern: DEFAULT_BRANCH_PATTERN,
          push: false,
          remote: "origin",
          protected_branches: [],
          base_port: basePort,
          install: "",
          test: "",
          dev: "",
        },
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

  /** Record repo commands and integration settings (base branch, mode, branch pattern, push). */
  async profile(updates: Partial<RepoProfile>): Promise<RepoProfile> {
    const board = this.load();
    if (updates.integration !== undefined) oneOf(updates.integration, INTEGRATIONS, "integration");
    if (updates.base_branch !== undefined && !(await branchExists(this.root, updates.base_branch))) {
      throw new FactoryError(`base branch "${updates.base_branch}" does not exist locally`);
    }
    if (updates.branch_pattern !== undefined && !updates.branch_pattern.includes("{slug}")) {
      if (!updates.branch_pattern.includes("{id}")) throw new FactoryError("branch_pattern needs {slug} or {id}");
    }
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

  // ----- branches --------------------------------------------------------------------

  /**
   * Pick the job's branch name from the pattern and check git can create it. Git stores
   * branches as paths, so `a/b` cannot coexist with a branch `a` or with branches `a/b/...`.
   */
  private async allocateBranch(board: Board, fields: Parameters<typeof renderBranch>[1]): Promise<string> {
    const taken = new Set(board.jobs.map((j) => j.branch));
    let name = renderBranch(board.repo.branch_pattern, fields);
    if (taken.has(name) || (await branchExists(this.root, name))) name = `${name}-${fields.number}`;
    if (taken.has(name) || (await branchExists(this.root, name))) {
      throw new FactoryError(`branch ${name} already exists`);
    }
    const format = await sh(["git", "check-ref-format", "--branch", name], this.root);
    if (format.code !== 0) throw new FactoryError(`"${name}" is not a valid git branch name`);

    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      if (taken.has(prefix) || (await branchExists(this.root, prefix))) {
        throw new FactoryError(
          `cannot create branch "${name}": branch "${prefix}" exists, and git cannot have a branch and ` +
            `a folder of branches with the same name. Change branch_pattern (default ${DEFAULT_BRANCH_PATTERN}).`,
        );
      }
    }
    const children = await git(this.root, "for-each-ref", "--count=1", "--format=%(refname:short)", `refs/heads/${name}/`);
    if (children || [...taken].some((b) => b.startsWith(`${name}/`))) {
      throw new FactoryError(`cannot create branch "${name}": branches under "${name}/" already exist`);
    }
    return name;
  }

  // ----- job lifecycle ---------------------------------------------------------------

  /** Register a queued job: id job-NNN-slug, branch from the pattern, base branch. */
  async newJob(title: string, opts: { type?: string; base?: string } = {}): Promise<Job> {
    const board = this.load();
    const type = oneOf(opts.type ?? "feature", JOB_TYPES, "job type");
    const base = opts.base ?? board.repo.base_branch;
    if (!(await branchExists(this.root, base))) {
      throw new FactoryError(`base branch "${base}" does not exist locally (create it or fetch it first)`);
    }
    const numbers = board.jobs.map((j) => Number(/^job-(\d+)-/.exec(j.id)?.[1] ?? 0));
    const number = Math.max(0, ...numbers) + 1;
    const padded = String(number).padStart(3, "0");
    const slug = slugify(title);
    const id = `job-${padded}-${slug}`;
    const branch = await this.allocateBranch(board, { type, base, slug, id, number: padded });
    const job: Job = {
      id,
      title,
      type,
      number,
      base_branch: base,
      branch,
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
    if (this.sessionId) job.session_id = this.sessionId;
    board.jobs.push(job);
    this.save(board);
    return job;
  }

  /** Start queued jobs while slots are free: worktree + branch from its base's HEAD, install. */
  async start(opts: { install?: boolean; signal?: AbortSignal } = {}) {
    const { install = true, signal } = opts;
    const board = this.load();
    const mine = this.visibleJobs(board);
    let active = mine.filter((j) => ACTIVE_STAGES.has(j.stage)).length;
    const started: Job[] = [];
    const warnings: { id: string; install: string }[] = [];
    for (const job of mine) {
      if (active >= board.max_parallel) break;
      if (job.stage !== "queued") continue;
      const wt = join(this.root, job.worktree);
      const baseSha = await git(this.root, "rev-parse", `refs/heads/${job.base_branch}`);
      await git(this.root, "worktree", "add", "-q", wt, "-b", job.branch, baseSha);
      mkdirSync(join(this.jobsDir, job.id), { recursive: true });
      if (install && board.repo.install) {
        const result = await sh(board.repo.install, wt, { PORT: String(job.port) }, signal);
        if (result.code !== 0) warnings.push({ id: job.id, install: tail(result.stderr || result.stdout) });
      }
      this.touch(job, { stage: "spec", base_sha: baseSha });
      started.push(job);
      active += 1;
      this.save(board);
    }
    this.save(board);
    const stillQueued = this.visibleJobs(board)
      .filter((j) => j.stage === "queued")
      .map((j) => j.id);
    return { started, still_queued: stillQueued, warnings };
  }

  /** Update a job's stage, round, note or file list. */
  set(id: string, opts: { stage?: string; round?: number; note?: string; files?: string[] }): Job {
    const board = this.load();
    const job = this.job(board, id);
    this.assertOwned(job);
    if (opts.stage !== undefined) {
      job.stage = oneOf(opts.stage, STAGES, "stage");
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
    this.assertOwned(job);
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
    this.assertOwned(job);
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
    this.assertOwned(job);
    this.addFile(job, rel);
    if (decision === "APPROVE") this.enqueueJob(board, job);
    else this.touch(job, { stage: "needs-human", note: "approver escalated" });
    this.save(board);
    return { id, decision, stage: job.stage };
  }

  /** Put a job in the integration queue (/factory approve, and after a merge fix). */
  enqueue(id: string) {
    const board = this.load();
    const job = this.job(board, id);
    this.assertOwned(job);
    this.enqueueJob(board, job);
    this.save(board);
    return { id, merge_queue: this.visibleQueue(board) };
  }

  private enqueueJob(board: Board, job: Job): void {
    if (job.stage === "merged") throw new FactoryError(`${job.id} is already merged`);
    this.touch(job, { stage: "merge-queue" });
    if (!board.merge_queue.includes(job.id)) board.merge_queue.push(job.id);
  }

  // ----- integration queue -----------------------------------------------------------

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

  /**
   * Integrate the head of the queue (one at a time). Always: rebase onto the job's base
   * branch and rerun the tests. Then, by repo.integration:
   * - merge:  fast-forward the base, archive OpenSpec in the main checkout, remove the worktree.
   * - branch: archive OpenSpec on the job branch, optionally push, stop at "ready" for a human.
   */
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
    if (id) this.assertOwned(this.job(board, id));
    const next = id ?? this.visibleQueue(board)[0];
    if (!next) return { ok: true, merged: null, detail: "merge queue empty" };
    const job = this.job(board, next);
    const { integration, test, protected_branches: protectedBranches } = board.repo;
    const base = job.base_branch;
    const wt = join(this.root, job.worktree);

    if (integration === "merge") {
      if (protectedBranches.includes(base)) {
        this.touch(job, { stage: "needs-human", note: `${base} is protected: no automatic merge` });
        board.merge_queue = board.merge_queue.filter((j) => j !== job.id);
        this.save(board);
        return {
          ok: false,
          id: job.id,
          reason: "base-protected",
          next: "needs-human",
          detail: `${base} is in protected_branches; set integration=branch or merge ${job.branch} by hand`,
        };
      }
      const holder = await this.checkedOutAt(base);
      if (holder && holder !== this.root) {
        return {
          ok: false,
          id: job.id,
          reason: "base-checked-out",
          next: "retry",
          detail: `${base} is checked out in ${holder}; switch that worktree to another branch first`,
        };
      }
      if (holder === this.root) {
        const porcelain = (await sh(["git", "status", "--porcelain"], this.root)).stdout;
        const dirty = porcelain.split("\n").filter((line) => line && !line.slice(3).startsWith("factory/"));
        if (dirty.length) {
          return {
            ok: false,
            id: job.id,
            reason: "main-not-clean",
            next: "retry",
            detail: `main checkout is on ${base} with changes outside factory/: ${dirty.join(", ")}`,
          };
        }
      }
    }

    if ((await sh(["git", "rebase", `refs/heads/${base}`], wt)).code !== 0) {
      const conflicts = (await sh(["git", "diff", "--name-only", "--diff-filter=U"], wt)).stdout.trim();
      await sh(["git", "rebase", "--abort"], wt);
      return this.mergeFailed(board, job, "rebase-conflict", `conflicting files:\n${conflicts}`);
    }

    if (test) {
      const tests = await sh(test, wt, { PORT: String(job.port) }, signal);
      if (tests.code !== 0) return this.mergeFailed(board, job, "tests-failed", tail(tests.stdout + tests.stderr));
    }

    board.merge_queue = board.merge_queue.filter((j) => j !== job.id);
    return integration === "branch" ? this.handOff(board, job, wt) : this.mergeIntoBase(board, job, wt);
  }

  /** Path of the worktree that has `branch` checked out, if any. */
  private async checkedOutAt(branch: string): Promise<string | null> {
    const list = await git(this.root, "worktree", "list", "--porcelain");
    let path: string | null = null;
    for (const line of list.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      if (line === `branch refs/heads/${branch}` && path) return realpathSync(path);
    }
    return null;
  }

  /** Archive the OpenSpec change on the job branch and commit it there. */
  private async archiveOnBranch(board: Board, job: Job, wt: string): Promise<string | null> {
    const archived = await this.archive(job, wt);
    if (archived) {
      await git(wt, "add", "-A", "--", "openspec");
      if ((await sh(["git", "diff", "--cached", "--quiet"], wt)).code !== 0) {
        await git(wt, "commit", "-q", "-m", `${job.id}: archive OpenSpec change`);
      }
    }
    this.save(board);
    return archived;
  }

  private archiveFailed(board: Board, job: Job, err: unknown) {
    this.touch(job, { stage: "needs-human", note: "tested, but OpenSpec archive failed" });
    this.save(board);
    return { ok: false, id: job.id, reason: "archive-failed", detail: String(err), next: "needs-human" };
  }

  /** Fast-forward the base branch to the job branch; the base is never rewritten. */
  private async mergeIntoBase(board: Board, job: Job, wt: string) {
    let archived: string | null;
    try {
      archived = await this.archiveOnBranch(board, job, wt);
    } catch (err) {
      return this.archiveFailed(board, job, err);
    }
    const base = job.base_branch;
    const oldSha = await git(this.root, "rev-parse", `refs/heads/${base}`);
    const newSha = await git(wt, "rev-parse", "HEAD");
    if ((await sh(["git", "merge-base", "--is-ancestor", oldSha, newSha], this.root)).code !== 0) {
      return this.mergeFailed(board, job, "base-moved", `${base} moved during the merge; retry`);
    }
    const holder = await this.checkedOutAt(base);
    if (holder === this.root) await git(this.root, "merge", "--ff-only", "-q", job.branch);
    else await git(this.root, "update-ref", "-m", `factory: merge ${job.id}`, `refs/heads/${base}`, newSha, oldSha);

    this.touch(job, { stage: "merged", note: "", merged_at: now() });
    if (holder === this.root) this.repointToRoot(job);
    this.save(board);
    if (holder === this.root) {
      await git(this.root, "add", "-A", "--", "factory");
      if ((await sh(["git", "diff", "--cached", "--quiet"], this.root)).code !== 0) {
        await git(this.root, "commit", "-q", "-m", `factory: record ${job.id}`);
      }
    }
    const removed = await sh(["git", "worktree", "remove", wt], this.root);
    return {
      ok: true,
      id: job.id,
      integration: "merge",
      merged_into: base,
      archived,
      worktree_removed: removed.code === 0,
      detail: removed.stderr.trim(),
      merge_queue: this.visibleQueue(board),
    };
  }

  private async handOff(board: Board, job: Job, wt: string) {
    let archived: string | null;
    try {
      archived = await this.archiveOnBranch(board, job, wt);
    } catch (err) {
      return this.archiveFailed(board, job, err);
    }
    let pushError = "";
    if (board.repo.push) {
      const push = await sh(["git", "push", "-u", board.repo.remote, job.branch], wt);
      if (push.code !== 0) pushError = tail(push.stderr.trim());
    }
    const pushed = board.repo.push && !pushError;
    this.touch(job, {
      stage: "ready",
      ready_at: now(),
      pushed,
      note: pushError ? "ready, but push failed" : "",
    });
    this.save(board);
    return {
      ok: true,
      id: job.id,
      integration: "branch",
      branch: job.branch,
      base_branch: job.base_branch,
      archived,
      pushed,
      push_error: pushError || undefined,
      detail: `${job.branch} is rebased on ${job.base_branch}, tested and ready for human review`,
      merge_queue: this.visibleQueue(board),
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

  /**
   * Run `openspec archive` in the job's worktree and repoint the job's file list at the
   * archived copy. Returns the archive dir relative to the repo root.
   */
  private async archive(job: Job, wt: string): Promise<string | null> {
    if (!existsSync(join(wt, "openspec", "changes", job.id))) return null;
    const result = await sh(["openspec", "archive", job.id, "-y"], wt);
    if (result.code !== 0) {
      throw new FactoryError(`openspec archive ${job.id} failed: ${tail(result.stdout + result.stderr)}`);
    }
    const archiveRoot = join(wt, "openspec", "changes", "archive");
    const match = readdirSync(archiveRoot)
      .filter((name) => name.endsWith(`-${job.id}`))
      .sort()
      .at(-1);
    if (!match) return null;
    const archived = relative(wt, join(archiveRoot, match));
    const oldPrefix = `${job.worktree}/openspec/changes/${job.id}/`;
    job.files = job.files.map((f) => f.replace(oldPrefix, `${job.worktree}/${archived}/`));
    return archived;
  }

  /** After the worktree is gone, point files at the base branch copy (in the main checkout if it is on base). */
  private repointToRoot(job: Job): void {
    const prefix = `${job.worktree}/`;
    job.files = job.files.map((f) => (f.startsWith(prefix) ? f.slice(prefix.length) : f));
  }

  // ----- housekeeping ----------------------------------------------------------------

  status() {
    const board = this.load();
    const jobs = this.visibleJobs(board);
    const active = jobs.filter((j) => ACTIVE_STAGES.has(j.stage)).length;
    return {
      max_parallel: board.max_parallel,
      free_slots: Math.max(board.max_parallel - active, 0),
      repo: board.repo,
      merge_queue: this.visibleQueue(board),
      jobs: jobs.map(({ id, type, stage, round, port, branch, base_branch, reviews, note, session_id }) => ({
        id,
        type,
        stage,
        round,
        port,
        branch,
        base_branch,
        reviews,
        note,
        session_id,
      })),
    };
  }

  /**
   * Mark "ready" jobs whose branch a human has merged into its base, then remove the
   * worktrees of merged jobs and prune git's worktree list. Squash merges are not
   * detectable: mark those with set(stage: "merged") first.
   */
  async cleanup() {
    const board = this.load();
    const mine = this.visibleJobs(board);
    const detected: string[] = [];
    for (const job of mine) {
      if (job.stage !== "ready") continue;
      const merged = await sh(["git", "merge-base", "--is-ancestor", job.branch, `refs/heads/${job.base_branch}`], this.root);
      if (merged.code === 0) {
        this.touch(job, { stage: "merged", merged_at: now() });
        detected.push(job.id);
      }
    }
    this.save(board);
    const removed: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const job of mine) {
      const wt = join(this.root, job.worktree);
      if (job.stage !== "merged" || !existsSync(wt)) continue;
      const result = await sh(["git", "worktree", "remove", wt], this.root);
      if (result.code === 0) removed.push(job.id);
      else failed.push({ id: job.id, error: result.stderr.trim() });
    }
    await git(this.root, "worktree", "prune");
    const stillReady = this.visibleJobs(board)
      .filter((j) => j.stage === "ready")
      .map((j) => j.branch);
    return { merged_detected: detected, removed, failed, still_ready: stillReady };
  }
}
