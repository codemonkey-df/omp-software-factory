#!/usr/bin/env node
/**
 * Debug CLI for the factory actions, outside OMP (unscoped: sees every session's jobs):
 *   node src/cli.ts status
 *   node src/cli.ts set '{"id": "job-001-x", "stage": "needs-human"}'
 */

import { ACTIONS, type Action, runAction } from "./actions.ts";
import { FactoryError } from "./factory.ts";

const [action, json] = process.argv.slice(2);
if (!action || !(ACTIONS as readonly string[]).includes(action)) {
  process.stderr.write(`usage: node src/cli.ts <${ACTIONS.join("|")}> ['{"field": value}']\n`);
  process.exit(2);
}

try {
  const fields = json ? (JSON.parse(json) as Record<string, unknown>) : {};
  const result = await runAction({ ...fields, action: action as Action }, process.cwd());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (err) {
  if (!(err instanceof FactoryError)) throw err;
  process.stdout.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
  process.exit(1);
}
