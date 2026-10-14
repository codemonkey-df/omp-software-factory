/** One entry point for every factory action, shared by the OMP tool and the CLI. */

import { Factory, FactoryError, type Integration } from "./factory.ts";

export const ACTIONS = [
  "init",
  "profile",
  "parallel",
  "new",
  "start",
  "set",
  "round",
  "collect",
  "decide",
  "enqueue",
  "merge",
  "status",
  "cleanup",
] as const;

export type Action = (typeof ACTIONS)[number];

export interface ActionParams {
  action: Action;
  id?: string;
  title?: string;
  type?: string;
  base?: string;
  n?: number;
  stage?: string;
  round?: number;
  note?: string;
  files?: string[];
  install?: string;
  test?: string;
  dev?: string;
  language?: string;
  base_branch?: string;
  /** Legacy name of base_branch. */
  main_branch?: string;
  integration?: string;
  branch_pattern?: string;
  push?: boolean;
  remote?: string;
  protected_branches?: string[];
  base_port?: number;
  max_parallel?: number;
  skip_install?: boolean;
  skip_openspec?: boolean;
}

function required<T>(value: T | undefined, name: string, action: string): T {
  if (value === undefined || value === "") throw new FactoryError(`action "${action}" needs "${name}"`);
  return value;
}

/** Execute one action in the repo containing `cwd`; returns a JSON-serialisable result. */
export async function runAction(
  params: ActionParams,
  cwd: string,
  signal?: AbortSignal,
  sessionId?: string,
): Promise<unknown> {
  const fac = await Factory.fromCwd(cwd, sessionId);
  const { action } = params;
  const id = (): string => required(params.id, "id", action);
  const baseBranch = params.base_branch ?? params.main_branch;
  switch (action) {
    case "init":
      return fac.init({
        maxParallel: params.max_parallel,
        basePort: params.base_port,
        baseBranch,
        integration: params.integration,
        openspec: !params.skip_openspec,
      });
    case "profile":
      return fac.profile({
        install: params.install,
        test: params.test,
        dev: params.dev,
        language: params.language,
        base_branch: baseBranch,
        integration: params.integration as Integration | undefined,
        branch_pattern: params.branch_pattern,
        push: params.push,
        remote: params.remote,
        protected_branches: params.protected_branches,
        base_port: params.base_port,
      });
    case "parallel":
      return fac.parallel(required(params.n, "n", action));
    case "new":
      return fac.newJob(required(params.title, "title", action), { type: params.type, base: params.base });
    case "start":
      return fac.start({ install: !params.skip_install, signal });
    case "set":
      return fac.set(id(), { stage: params.stage, round: params.round, note: params.note, files: params.files });
    case "round":
      return fac.round(id(), required(params.n, "n", action));
    case "collect":
      return fac.collect(id());
    case "decide":
      return fac.decide(id());
    case "enqueue":
      return fac.enqueue(id());
    case "merge":
      return fac.merge(params.id, signal);
    case "status":
      return fac.status();
    case "cleanup":
      return fac.cleanup();
    default:
      throw new FactoryError(`unknown action ${String(action)}; expected one of ${ACTIONS.join(", ")}`);
  }
}
