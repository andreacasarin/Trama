import { ProvenanceRecord, ReadonlyVault, StructuredErrorShape } from "@/domain/contracts";

export interface JsonSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}
export interface ToolResult {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: StructuredErrorShape;
  readonly provenance: readonly ProvenanceRecord[];
}
export interface ReadonlyTool {
  readonly definition: ToolDefinition;
  execute(input: unknown, signal: AbortSignal): Promise<ToolResult>;
}
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export class ToolRegistry {
  private readonly byName: ReadonlyMap<string, ReadonlyTool>;
  readonly definitions: readonly ToolDefinition[];
  constructor(tools: readonly ReadonlyTool[]) {
    const map = new Map<string, ReadonlyTool>();
    for (const tool of tools) {
      if (map.has(tool.definition.name)) throw new Error(`Duplicate tool: ${tool.definition.name}`);
      map.set(tool.definition.name, tool);
    }
    this.byName = map;
    this.definitions = Object.freeze(tools.map((tool) => Object.freeze({ ...tool.definition })));
  }
  get(name: string): ReadonlyTool | undefined {
    return this.byName.get(name);
  }

  /** Validates and executes a named tool, turning malformed calls into model-readable errors. */
  async execute(name: unknown, input: unknown, signal: AbortSignal): Promise<ToolResult> {
    if (typeof name !== "string" || !name) return invalid("Tool name must be a non-empty string");
    const tool = this.byName.get(name);
    if (!tool) return invalid(`Unknown tool: ${name}`);
    if (!objectInput(input)) return invalid("Tool arguments must be an object");
    const schema = tool.definition.inputSchema;
    const value = input as Record<string, unknown>;
    for (const required of schema.required ?? []) {
      if (!(required in value)) return invalid(`Missing required argument: ${required}`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) return invalid(`Unknown argument: ${key}`);
      }
    }
    return tool.execute(Object.freeze({ ...value }), signal);
  }
}

export function invalid(message: string, provenance: readonly ProvenanceRecord[] = []): ToolResult {
  return { ok: false, error: { code: "invalid_request", message, retryable: false }, provenance };
}
export function failure(error: unknown, provenance: readonly ProvenanceRecord[] = []): ToolResult {
  const cancelled = error instanceof Error && /cancel/i.test(error.message);
  return {
    ok: false,
    error: {
      code: cancelled ? "cancelled" : "unavailable",
      message: error instanceof Error ? error.message : "Tool failed",
      retryable: !cancelled,
    },
    provenance,
  };
}
export function objectInput(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

export class CurrentNoteTool implements ReadonlyTool {
  readonly definition = {
    name: "current_note",
    description: "Read the active Markdown note path.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  } as const;
  constructor(private readonly vault: ReadonlyVault) {}
  async execute(input: unknown, signal: AbortSignal): Promise<ToolResult> {
    if (!objectInput(input)) return invalid("Input must be an object");
    try {
      const note = this.vault.currentNote ? await this.vault.currentNote(signal) : null;
      const path = note ? note.path : await this.vault.currentNotePath(signal);
      return {
        ok: true,
        data: { path },
        provenance:
          typeof path === "string" && path
            ? [{ path, ...(note ? { startLine: note.startLine, endLine: note.endLine } : {}) }]
            : [],
      };
    } catch (e) {
      return failure(e);
    }
  }
}

export class ReadNoteTool implements ReadonlyTool {
  readonly definition = {
    name: "read_note",
    description: "Read a bounded Markdown note.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  } as const;
  constructor(private readonly vault: ReadonlyVault) {}
  async execute(input: unknown, signal: AbortSignal): Promise<ToolResult> {
    const data = objectInput(input);
    if (!data || typeof data.path !== "string" || !data.path)
      return invalid("path must be a non-empty string");
    try {
      const note = await this.vault.readNote(data.path, signal);
      return {
        ok: true,
        data: note,
        provenance: [{ path: note.path, startLine: note.startLine, endLine: note.endLine }],
      };
    } catch (e) {
      return failure(e);
    }
  }
}

export class DiscoverLinksTool implements ReadonlyTool {
  static readonly MAX_LINKS = 100;
  static readonly MAX_SERIALIZED_CONTENT = 16_000;
  readonly definition = {
    name: "discover_links",
    description: "Discover resolved and unresolved links in a note.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  } as const;
  constructor(private readonly vault: ReadonlyVault) {}
  async execute(input: unknown, signal: AbortSignal): Promise<ToolResult> {
    const data = objectInput(input);
    if (!data || typeof data.path !== "string" || !data.path)
      return invalid("path must be a non-empty string");
    try {
      const discovered = await this.vault.discoverLinks(
        data.path,
        signal,
        DiscoverLinksTool.MAX_LINKS
      );
      let links = discovered.slice(0, DiscoverLinksTool.MAX_LINKS);
      let truncated = discovered.length >= DiscoverLinksTool.MAX_LINKS;
      let serialized = JSON.stringify({
        links,
        truncated,
        resultLimit: DiscoverLinksTool.MAX_LINKS,
      });
      while (links.length > 0 && serialized.length > DiscoverLinksTool.MAX_SERIALIZED_CONTENT) {
        links = links.slice(0, -1);
        truncated = true;
        serialized = JSON.stringify({ links, truncated, resultLimit: DiscoverLinksTool.MAX_LINKS });
      }
      return {
        ok: true,
        data: {
          links,
          truncated,
          resultLimit: DiscoverLinksTool.MAX_LINKS,
        },
        provenance: linkProvenance(links, data.path),
      };
    } catch (e) {
      return failure(e, [{ path: data.path }]);
    }
  }
}

export class FollowLinkTool implements ReadonlyTool {
  readonly definition = {
    name: "follow_link",
    description: "Resolve a wikilink relative to its source note.",
    inputSchema: {
      type: "object",
      properties: { link: { type: "string" }, sourcePath: { type: "string" } },
      required: ["link", "sourcePath"],
      additionalProperties: false,
    },
  } as const;
  constructor(private readonly vault: ReadonlyVault) {}
  async execute(input: unknown, signal: AbortSignal): Promise<ToolResult> {
    const data = objectInput(input);
    if (
      !data ||
      typeof data.link !== "string" ||
      typeof data.sourcePath !== "string" ||
      !data.link ||
      !data.sourcePath
    )
      return invalid("link and sourcePath must be non-empty strings");
    try {
      const details = this.vault.resolveLinkDetails
        ? await this.vault.resolveLinkDetails(data.link, data.sourcePath, signal)
        : { path: await this.vault.resolveLink(data.link, data.sourcePath, signal) };
      if (!details) return { ok: true, data: { path: null }, provenance: [] };
      const target = details.path ? await this.vault.readNote(details.path, signal) : null;
      return {
        ok: true,
        data: { path: details.path },
        provenance: [
          {
            path: data.sourcePath,
            ...(details.startLine !== undefined || details.endLine !== undefined
              ? { startLine: details.startLine, endLine: details.endLine }
              : {}),
          },
          ...(target
            ? [{ path: target.path, startLine: target.startLine, endLine: target.endLine }]
            : []),
        ],
      };
    } catch (e) {
      return failure(e, [{ path: data.sourcePath }]);
    }
  }
}

function linkProvenance(
  links: readonly { sourcePath: string; startLine?: number; endLine?: number }[],
  sourcePath: string
): readonly ProvenanceRecord[] {
  const records: ProvenanceRecord[] = links
    .filter((link) => link.startLine !== undefined || link.endLine !== undefined)
    .map((link) => ({ path: link.sourcePath, startLine: link.startLine, endLine: link.endLine }));
  if (records.length < links.length || links.length === 0) records.push({ path: sourcePath });
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.path}\n${record.startLine ?? ""}\n${record.endLine ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface VaultSearchPort {
  search(query: string, signal: AbortSignal, limit: number): Promise<readonly ProvenanceRecord[]>;
}
export class VaultSearchTool implements ReadonlyTool {
  readonly definition = {
    name: "vault_search",
    description: "Search the vault through the bounded retrieval port.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  } as const;
  static readonly MAX_RESULTS = 20;
  constructor(private readonly searchPort: VaultSearchPort) {}
  async execute(input: unknown, signal: AbortSignal): Promise<ToolResult> {
    const data = objectInput(input);
    if (!data || typeof data.query !== "string" || !data.query.trim())
      return invalid("query must be a non-empty string");
    try {
      const results = await this.searchPort.search(data.query, signal, VaultSearchTool.MAX_RESULTS);
      return { ok: true, data: { results }, provenance: results };
    } catch (e) {
      return failure(e);
    }
  }
}
