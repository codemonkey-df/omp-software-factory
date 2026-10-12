import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";

import { completeFactory, findBoard, helpText, SUBCOMMANDS, toRequest } from "../src/commands.ts";
import type { Board, Job } from "../src/factory.ts";
import factoryExtension from "../src/index.ts";
import type { CommandContext, CommandDefinition, ExtensionAPI, Schema } from "../src/omp-types.ts";

const schema: Schema = { optional: () => schema };
const zod = { object: () => schema, string: () => schema, number: () => schema, boolean: () => schema, array: () => schema, enum: () => schema };

const jobOf = (id: string, stage: Job["stage"]): Job =>
  ({ id, stage, branch: `feature/main/${id}`, note: "" }) as Job;
const board = { jobs: [jobOf("job-001-a", "needs-human"), jobOf("job-002-b", "ready"), jobOf("job-003-c", "merged")] } as Board;

let commands: Map<string, CommandDefinition>;
let sent: string[];
let notes: string[];
let ctx: CommandContext;

beforeEach(() => {
  commands = new Map();
  sent = [];
  notes = [];
  const pi: ExtensionAPI = {
    zod,
    setLabel: () => {},
    registerTool: () => {},
    registerCommand: (name, command) => commands.set(name, command),
    sendUserMessage: (text) => sent.push(text),
  };
  factoryExtension(pi);
  ctx = { cwd: tmpdir(), ui: { notify: (message) => notes.push(message) } };
});

describe("requests", () => {
  test("subcommands map to the skill's request syntax", () => {
    assert.deepEqual(toRequest("bugfix crash on save @Branch_A"), { request: "bugfix: crash on save @Branch_A" });
    assert.deepEqual(toRequest("new add search"), { request: "add search" });
    assert.deepEqual(toRequest("add search"), { request: "add search" });
    assert.deepEqual(toRequest("dash"), { request: "dashboard" });
    assert.deepEqual(toRequest("rework job-001-a use a queue"), { request: "rework job-001-a use a queue" });
    assert.deepEqual(toRequest("config integration=branch"), { request: "config integration=branch" });
  });

  test("empty and help show help; missing arguments are reported", () => {
    assert.deepEqual(toRequest(""), { help: true });
    assert.deepEqual(toRequest("help"), { help: true });
    assert.deepEqual(toRequest("approve"), { error: "usage: /factory approve <job-id>" });
    for (const sub of SUBCOMMANDS) assert.ok(helpText().includes(`/factory ${sub.name}`));
  });
});

describe("completions", () => {
  test("lists subcommands with descriptions and filters by prefix", () => {
    assert.equal(completeFactory("", null)?.length, SUBCOMMANDS.length);
    assert.deepEqual(
      completeFactory("re", null)?.map((i) => [i.label, i.value]),
      [["rework <job-id> <note>", "rework "]],
    );
    assert.equal(completeFactory("status", null)?.[0]?.value, "status");
    assert.equal(completeFactory("zzz", null), null);
  });

  test("offers job ids in the right stages", () => {
    assert.deepEqual(completeFactory("approve ", board)?.map((i) => i.value), ["approve job-001-a "]);
    assert.deepEqual(completeFactory("done job", board)?.map((i) => i.value), ["done job-002-b "]);
    assert.equal(completeFactory("rework job-001-a ", board), null);
    assert.equal(completeFactory("status ", board), null);
  });

  test("finds the board from a subdirectory", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-cmd-"));
    mkdirSync(join(root, "factory"));
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    writeFileSync(join(root, "factory", "board.json"), JSON.stringify(board));
    assert.equal(findBoard(join(root, "src", "deep"))?.jobs.length, 3);
    assert.equal(findBoard(tmpdir()), null);
  });
});

describe("registered commands", () => {
  test("registers /factory and one /fx: command per subcommand", () => {
    assert.ok(commands.has("factory"));
    for (const sub of SUBCOMMANDS) assert.ok(commands.has(`fx:${sub.name}`), sub.name);
    assert.match(commands.get("fx:rework")!.description, /^<job-id> <note> — /);
  });

  test("handlers hand the request to the skill", async () => {
    await commands.get("fx:hotfix")!.handler("token leak", ctx);
    await commands.get("factory")!.handler("status", ctx);
    assert.equal(sent.length, 2);
    assert.match(sent[0]!, /skill:\/\/factory/);
    assert.match(sent[0]!, /Request: \/factory hotfix: token leak$/);
    assert.match(sent[1]!, /Request: \/factory status$/);
  });

  test("help and usage errors stay local", async () => {
    await commands.get("factory")!.handler("", ctx);
    await commands.get("fx:approve")!.handler("", ctx);
    assert.equal(sent.length, 0);
    assert.match(notes[0]!, /\/factory init/);
    assert.equal(notes[1], "usage: /factory approve <job-id>");
  });
});
