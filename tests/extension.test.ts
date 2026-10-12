import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";

import factoryExtension from "../src/index.ts";
import type { ExtensionAPI, Schema, ToolContext, ToolDefinition, ZodLike } from "../src/omp-types.ts";

const schema: Schema = { optional: () => schema };
const zod: ZodLike = {
  object: () => schema,
  string: () => schema,
  number: () => schema,
  boolean: () => schema,
  array: () => schema,
  enum: () => schema,
};

function load(): ToolDefinition<any> {
  const tools: ToolDefinition<any>[] = [];
  const pi: ExtensionAPI = {
    zod,
    setLabel: () => {},
    registerTool: (tool) => tools.push(tool),
    registerCommand: () => {},
    sendUserMessage: () => {},
  };
  factoryExtension(pi);
  assert.equal(tools.length, 1);
  return tools[0]!;
}

const call = (ctx: ToolContext, params: object) =>
  load()
    .execute("call-1", params, undefined, undefined, ctx)
    .then((r) => JSON.parse(r.content[0]!.text));

test("registers one essential factory tool", () => {
  const tool = load();
  assert.equal(tool.name, "factory");
  assert.equal(tool.loadMode, "essential");
});

test("refuses calls from subagents", async () => {
  const result = await call({ cwd: process.cwd(), agent: { kind: "sub", name: "builder" } }, { action: "status" });
  assert.equal(result.ok, false);
  assert.match(result.error, /only the \/factory orchestrator/);
});

test("reports factory errors as JSON instead of throwing", async () => {
  const notARepo = mkdtempSync(`${tmpdir()}/factory-norepo-`);
  const result = await call({ cwd: notARepo, agent: { kind: "main" } }, { action: "status" });
  assert.equal(result.ok, false);
  assert.match(result.error, /git rev-parse/);
});
