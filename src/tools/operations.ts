import { z, type ZodType } from "zod";

export type Shape = Record<string, ZodType>;

// An operation is not a tool: nothing serves its name and scope never sees it; an agent's tools
// axis names the composite tool and its action ("capsid_read_doc.versions").

export interface OperationConfig {
  description: string;
  inputSchema: Shape;
}

export interface OperationResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

// The dispatcher has parsed arguments before the call, so the table stores each handler taking
// unknown.
type OperationHandler = (args: unknown) => OperationResult | Promise<OperationResult>;

interface Operation {
  config: OperationConfig;
  handler: OperationHandler;
}

function withStructure(result: OperationResult): OperationResult {
  if (result.isError === true || result.structuredContent !== undefined) return result;
  const text = result.content.map((c) => c.text).join("\n");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const structured =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { text };
  return { ...result, structuredContent: structured };
}

export class Operations {
  private readonly table = new Map<string, Operation>();

  define<S extends Shape>(
    name: string,
    config: { description: string; inputSchema: S },
    handler: (args: z.infer<z.ZodObject<S>>) => OperationResult | Promise<OperationResult>,
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

  async run(name: string, args: Record<string, unknown>, label: string): Promise<OperationResult> {
    const op = this.get(name);
    const parsed = z.object(op.config.inputSchema).safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(arguments)"}: ${i.message}`)
        .join("; ");
      return {
        content: [{ type: "text", text: `invalid arguments for ${label}: ${issues}` }],
        isError: true,
      };
    }
    return withStructure(await op.handler(parsed.data));
  }

  private get(name: string): Operation {
    const op = this.table.get(name);
    if (!op) throw new Error(`no operation '${name}'`);
    return op;
  }
}
