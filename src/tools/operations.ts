import { z, type ZodType } from "zod";

// An input shape as the SDK takes it: field name to zod (classic) schema.
export type Shape = Record<string, ZodType>;

// The operations behind the served tools (the MCP 4 regroup).
//
// Capsid serves 14 tools and Capsid Admin 8, each one whole job with an `action`
// argument. The work each action does is an operation: a handler with its own input
// shape, defined once by the module that owns it (src/tools/docs-read.ts and the rest)
// and dispatched by the composite tool in src/tools/surface.ts. An operation is not a
// tool: nothing serves its name, scope never sees it, and an agent's tools axis names
// the composite tool and its action ("capsid_read_doc.versions"), never the operation.
//
// The dispatcher validates the arguments against the operation's own shape, which is
// what the SDK did when each operation was a tool, so a handler still receives
// arguments its schema has parsed.

export interface OperationConfig {
  description: string;
  inputSchema: Shape;
}

// The SDK's tool result, as the handlers build it (ok and fail in ./docs).
export interface OperationResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

// Handlers keep the argument types their own shape gives them; the dispatcher has parsed
// them before the call.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OperationHandler = (args: any) => OperationResult | Promise<OperationResult>;

interface Operation {
  config: OperationConfig;
  handler: OperationHandler;
}

export class Operations {
  private readonly table = new Map<string, Operation>();

  define<S extends Shape>(
    name: string,
    config: { description: string; inputSchema: S },
    handler: (args: z.infer<z.ZodObject<S>>) => OperationResult | Promise<OperationResult>
  ): void {
    if (this.table.has(name)) throw new Error(`operation '${name}' is defined twice`);
    this.table.set(name, { config, handler: handler as OperationHandler });
  }

  has(name: string): boolean {
    return this.table.has(name);
  }

  config(name: string): OperationConfig {
    return this.get(name).config;
  }

  names(): string[] {
    return [...this.table.keys()];
  }

  // Parses `args` against the operation's own shape, then runs it. A parse failure is
  // the refusal the SDK gave before: the argument and what was wrong with it.
  async run(name: string, args: Record<string, unknown>, label: string): Promise<OperationResult> {
    const op = this.get(name);
    const parsed = z.object(op.config.inputSchema).safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(arguments)"}: ${i.message}`).join("; ");
      return { content: [{ type: "text", text: `invalid arguments for ${label}: ${issues}` }], isError: true };
    }
    return op.handler(parsed.data);
  }

  private get(name: string): Operation {
    const op = this.table.get(name);
    if (!op) throw new Error(`no operation '${name}'`);
    return op;
  }
}
