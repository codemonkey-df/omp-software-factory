/**
 * Slash commands: `/factory <subcommand>` with autocomplete, plus one short `/fx:<subcommand>`
 * per subcommand so the `/` menu lists them all with descriptions. Every command hands the
 * request to the orchestrator skill as a user message; nothing here touches the board.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Board, Job, Stage } from "./factory.ts";
import type { CommandContext, CompletionItem, ExtensionAPI } from "./omp-types.ts";

export const SHORT_PREFIX = "fx";

export interface Subcommand {
  name: string;
  /** Usage shown after the name; `<x>` is required, `[x]` optional. */
  args?: string;
  description: string;
  /** The `/factory ...` request the skill understands; defaults to `<name> <args>`. */
  request?: (rest: string) => string;
  /** Stages whose jobs are offered as the first argument. */
  jobStages?: readonly Stage[];
}

const typed = (type: string) => (rest: string) => `${type}: ${rest}`;

export const SUBCOMMANDS: readonly Subcommand[] = [
  { name: "init", description: "Set up the factory here: base branch, merge or branch mode, repo profile" },
  {
    name: "config",
    args: "[key=value ...]",
    description: "Show or set base_branch, integration, branch_pattern, push, protected_branches",
  },
  { name: "new", args: "<request> [@base]", description: "Queue a job; type is inferred", request: (rest) => rest },
  { name: "feature", args: "<request> [@base]", description: "Queue a feature job", request: typed("feature") },
  { name: "bugfix", args: "<request> [@base]", description: "Queue a bugfix job", request: typed("bugfix") },
  { name: "change", args: "<request> [@base]", description: "Queue a change job", request: typed("change") },
  { name: "hotfix", args: "<request> [@base]", description: "Queue a hotfix job", request: typed("hotfix") },
  { name: "next", args: "[n]", description: "Start the next n unchecked items of factory/backlog.md" },
  { name: "parallel", args: "<n>", description: "Set how many jobs run at once" },
  { name: "status", description: "Show jobs, stages and branches" },
  { name: "dash", description: "Serve the live dashboard", request: () => "dashboard" },
  {
    name: "approve",
    args: "<job-id>",
    description: "Send a needs-human job to the integration queue",
    jobStages: ["needs-human"],
  },
  {
    name: "rework",
    args: "<job-id> <note>",
    description: "Send a job back to its builder with a note",
    jobStages: ["build", "review", "approve", "merge-queue", "ready", "needs-human"],
  },
  { name: "done", args: "<job-id>", description: "Mark a ready job as merged by you", jobStages: ["ready"] },
  { name: "cleanup", description: "Detect merged branches, remove finished worktrees" },
  { name: "help", description: "List factory commands" },
];

const byName = new Map(SUBCOMMANDS.map((s) => [s.name, s]));
const needsArgs = (sub: Subcommand): boolean => sub.args?.startsWith("<") ?? false;
const usage = (sub: Subcommand): string => `/factory ${sub.name}${sub.args ? ` ${sub.args}` : ""}`;

export function helpText(): string {
  const width = Math.max(...SUBCOMMANDS.map((s) => usage(s).length));
  const lines = SUBCOMMANDS.map((s) => `${usage(s).padEnd(width)}  ${s.description}`);
  return [
    "Software factory commands (also as /fx:<name>, e.g. /fx:bugfix crash on save):",
    ...lines,
    "/factory <request>  is the same as /factory new <request>",
  ].join("\n");
}

/**
 * Turn `/factory` arguments into the request text the skill handles, `"help"` for the
 * command list, or an error string for missing arguments.
 */
export function toRequest(args: string): { request: string } | { help: true } | { error: string } {
  const text = args.trim();
  const [word = "", ...restWords] = text.split(/\s+/);
  const sub = byName.get(word.toLowerCase());
  if (!text || sub?.name === "help") return { help: true };
  if (!sub) return { request: text };
  const rest = restWords.join(" ");
  if (needsArgs(sub) && !rest) return { error: `usage: ${usage(sub)}` };
  return { request: (sub.request?.(rest) ?? `${sub.name} ${rest}`).trim() };
}

/** Read factory/board.json from `cwd` or the nearest parent; null if there is none. */
export function findBoard(cwd: string): Board | null {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const path = join(dir, "factory", "board.json");
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as Board;
      } catch {
        return null;
      }
    }
    if (dirname(dir) === dir) return null;
  }
}

function jobItems(sub: Subcommand, typedId: string, board: Board | null, valuePrefix: string): CompletionItem[] {
  const stages = new Set(sub.jobStages);
  return (board?.jobs ?? [])
    .filter((j: Job) => stages.has(j.stage) && j.id.startsWith(typedId))
    .map((j) => ({
      label: j.id,
      value: `${valuePrefix}${j.id} `,
      description: `${j.stage} · ${j.branch}${j.note ? ` · ${j.note}` : ""}`,
    }));
}

/** Completions for the text typed after `/factory `. */
export function completeFactory(typed: string, board: Board | null): CompletionItem[] | null {
  const space = typed.indexOf(" ");
  if (space === -1) {
    const prefix = typed.toLowerCase();
    const items = SUBCOMMANDS.filter((s) => s.name.startsWith(prefix)).map((s) => ({
      label: s.args ? `${s.name} ${s.args}` : s.name,
      value: s.args ? `${s.name} ` : s.name,
      description: s.description,
    }));
    return items.length ? items : null;
  }
  const sub = byName.get(typed.slice(0, space).toLowerCase());
  const rest = typed.slice(space + 1);
  if (!sub?.jobStages || rest.includes(" ")) return null;
  const items = jobItems(sub, rest, board, `${sub.name} `);
  return items.length ? items : null;
}

/** Completions for the text typed after `/fx:<name> `. */
export function completeShort(sub: Subcommand, typed: string, board: Board | null): CompletionItem[] | null {
  if (!sub.jobStages || typed.includes(" ")) return null;
  const items = jobItems(sub, typed, board, "");
  return items.length ? items : null;
}

export function orchestratorPrompt(request: string): string {
  return [
    "Use the `factory` skill: read `skill://factory` and follow it exactly as the orchestrator.",
    "",
    `Request: /factory ${request}`,
  ].join("\n");
}

/** Register `/factory` and the `/fx:*` shortcuts. */
export function registerCommands(pi: ExtensionAPI): void {
  let cwd = process.cwd();

  const run = (args: string, ctx: CommandContext): void => {
    cwd = ctx.cwd;
    const parsed = toRequest(args);
    if ("help" in parsed) ctx.ui.notify(helpText(), "info");
    else if ("error" in parsed) ctx.ui.notify(parsed.error, "warning");
    else pi.sendUserMessage(orchestratorPrompt(parsed.request));
  };

  pi.registerCommand("factory", {
    description: "Software factory: spec, build, review, approve, integrate (type a space for subcommands)",
    getArgumentCompletions: (typed) => completeFactory(typed, findBoard(cwd)),
    handler: run,
  });

  for (const sub of SUBCOMMANDS) {
    pi.registerCommand(`${SHORT_PREFIX}:${sub.name}`, {
      description: `${sub.args ? `${sub.args} — ` : ""}${sub.description}`,
      getArgumentCompletions: sub.jobStages ? (typed) => completeShort(sub, typed, findBoard(cwd)) : undefined,
      handler: (args, ctx) => run(`${sub.name} ${args}`, ctx),
    });
  }
}
