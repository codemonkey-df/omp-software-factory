/**
 * The slice of OMP's extension API this package uses (see omp://extensions.md).
 * Declared locally so the package has no runtime or build dependency on OMP itself.
 */

export interface Schema {
  optional(): Schema;
}

export interface ZodLike {
  object(shape: Record<string, Schema>): Schema;
  string(): Schema;
  number(): Schema;
  boolean(): Schema;
  array(item: Schema): Schema;
  enum(values: readonly [string, ...string[]]): Schema;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  details?: unknown;
}

export interface SessionManager {
  getSessionId(): string;
}

export interface ToolContext {
  cwd: string;
  agent?: { kind: "main" | "sub"; name?: string };
  sessionManager?: SessionManager;
}

export interface ToolDefinition<P> {
  name: string;
  label: string;
  description: string;
  parameters: Schema;
  loadMode?: "discoverable" | "essential";
  execute(
    toolCallId: string,
    params: P,
    signal: AbortSignal | undefined,
    onUpdate: ((update: ToolResult) => void) | undefined,
    ctx: ToolContext,
  ): Promise<ToolResult>;
}

export interface CompletionItem {
  label: string;
  /** Replaces everything typed after the command name. */
  value: string;
  description?: string;
}

export interface CommandContext {
  cwd: string;
  hasUI?: boolean;
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
  sessionManager?: SessionManager;
}

export interface CommandDefinition {
  description: string;
  getArgumentCompletions?: (
    typed: string,
    ctx?: CommandContext,
  ) => CompletionItem[] | null | Promise<CompletionItem[] | null>;
  handler(args: string, ctx: CommandContext): void | Promise<void>;
}

export interface ExtensionAPI {
  zod: ZodLike;
  setLabel(label: string): void;
  registerTool<P>(tool: ToolDefinition<P>): void;
  registerCommand(name: string, command: CommandDefinition): void;
  /** Send text as if the user typed it; starts a turn (or steers a running one). */
  sendUserMessage(text: string): void;
}
