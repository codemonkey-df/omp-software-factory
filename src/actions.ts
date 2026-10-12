/** One entry point for every factory action, shared by the OMP tool and the CLI. */

import { Factory, FactoryError } from "./factory.ts";

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
  n?: number;
  stage?: string;
  round?: number;
  note?: string;
  files?: string[];
  install?: string;
  test?: string;
  dev?: string;
  language?: string;
  main_branch?: string;
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
export async function runAction(params: ActionParams, cwd: string, signal?: AbortSignal): Promise<unknown> {
  const fac = await Factory.fromCwd(cwd);
  const { action } = params;
  const id = (): string => required(params.id, "id", action);
  switch (action) {
    case "init":
      return fac.init({
        maxParallel: params.max_parallel,
        basePort: params.base_port,
        openspec: !params.skip_openspec,
      });
    case "profile":
      return fac.profile({
        install: params.install,
        test: params.test,
        dev: params.dev,
        language: params.language,
        main_branch: params.main_branch,
        base_port: params.base_port,
      });
    case "parallel":
      return fac.parallel(required(params.n, "n", action));
    case "new":
      return fac.newJob(required(params.title, "title", action));
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
