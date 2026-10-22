import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { ProvenanceRecord, ReadonlyVault } from "@/domain/vault";
import type { StructuredErrorShape } from "@/domain/errors";
import { StructuredError } from "@/domain/errors";
import type { VaultRetrieval } from "@/index/VaultRetrieval";

export interface VaultToolOutcome {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: StructuredErrorShape;
  readonly provenance: readonly ProvenanceRecord[];
}

export type VaultToolFactory = () => StructuredToolInterface[];

const PATH_ARGUMENT = z.object({ path: z.string().min(1) }).strict();
const DISCOVER_LINKS_ARGUMENT = z
  .object({
    path: z.string().min(1),
    limit: z
      .number()
      .int()
      .positive()
      .safe()
      .describe("Maximum links to return (default: 25).")
      .optional(),
  })
  .strict();
const FOLLOW_LINK_ARGUMENT = z
  .object({
    link: z.string().min(1),
    sourcePath: z.string().min(1),
  })
  .strict();
const SEARCH_ARGUMENT = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .describe("An exact term, phrase, or natural-language concept to search for."),
    limit: z
      .number()
      .int()
      .positive()
      .safe()
      .describe("Maximum search results to return (default: 10).")
      .optional(),
  })
  .strict();

const DEFAULT_LINK_LIMIT = 25;
const DEFAULT_SEARCH_LIMIT = 10;

function failure(error: unknown, provenance: readonly ProvenanceRecord[] = []): VaultToolOutcome {
  const cancelled = error instanceof Error && /cancel/i.test(error.message);
  const structured = error instanceof StructuredError ? error : undefined;
  return {
    ok: false,
    error: {
      code: cancelled ? "cancelled" : (structured?.code ?? "unavailable"),
      message: error instanceof Error ? error.message : "Tool failed",
      retryable: cancelled ? false : (structured?.retryable ?? true),
    },
    provenance,
  };
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

/** Creates native LangChain tools around read-only vault operations and indexed SQLite retrieval. */
export function createVaultTools(
  vault: ReadonlyVault,
  retrieval: VaultRetrieval
): StructuredToolInterface[] {
  const wrap =
    <Input extends Record<string, unknown>>(
      operation: (input: Input, signal: AbortSignal) => Promise<VaultToolOutcome>
    ) =>
    async (input: Input, runtime: { signal?: AbortSignal }) => {
      const result = await operation(input, runtime.signal ?? new AbortController().signal);
      const serialized = JSON.stringify(result.ok ? result.data : result.error) ?? "";
      return [serialized, result] as const;
    };

  return [
    tool(
      wrap<{ path: string }>(async ({ path }, signal) => {
        try {
          const targetPath =
            path.trim() !== path || path.toLowerCase().endsWith(".md")
              ? path
              : await vault.resolveLink(path, null, signal);
          if (!targetPath)
            throw new Error(
              `No visible note matches '${path}'. Use an exact vault-relative .md path or a unique note title.`
            );
          const note = await vault.readNote(targetPath, signal);
          return {
            ok: true,
            data: note,
            provenance: [{ path: note.path, startLine: note.startLine, endLine: note.endLine }],
          };
        } catch (error) {
          return failure(error);
        }
      }),
      {
        name: "read_note",
        description:
          "Read a Markdown note by exact vault-relative .md path, unique note title, or complete [[wikilink]]. Use follow_link for source-relative links.",
        schema: PATH_ARGUMENT,
        responseFormat: "content_and_artifact",
      }
    ),
    tool(
      wrap<{ path: string; limit?: number }>(async ({ path, limit }, signal) => {
        try {
          const resultLimit = limit ?? DEFAULT_LINK_LIMIT;
          const probeLimit = resultLimit < Number.MAX_SAFE_INTEGER ? resultLimit + 1 : resultLimit;
          const discovered = await vault.discoverLinks(path, signal, probeLimit);
          const links = discovered.slice(0, resultLimit);
          const truncated = probeLimit > resultLimit && discovered.length > resultLimit;
          return {
            ok: true,
            data: { links, truncated, resultLimit },
            provenance: linkProvenance(links, path),
          };
        } catch (error) {
          return failure(error, [{ path }]);
        }
      }),
      {
        name: "discover_links",
        description: "Discover resolved and unresolved links in a note.",
        schema: DISCOVER_LINKS_ARGUMENT,
        responseFormat: "content_and_artifact",
      }
    ),
    tool(
      wrap<{ link: string; sourcePath: string }>(async ({ link, sourcePath }, signal) => {
        try {
          const details = vault.resolveLinkDetails
            ? await vault.resolveLinkDetails(link, sourcePath, signal)
            : { path: await vault.resolveLink(link, sourcePath, signal) };
          if (!details) return { ok: true, data: { path: null }, provenance: [] };
          const target = details.path ? await vault.readNote(details.path, signal) : null;
          return {
            ok: true,
            data: { path: details.path, note: target },
            provenance: [
              {
                path: sourcePath,
                ...(details.startLine !== undefined || details.endLine !== undefined
                  ? { startLine: details.startLine, endLine: details.endLine }
                  : {}),
              },
              ...(target
                ? [{ path: target.path, startLine: target.startLine, endLine: target.endLine }]
                : []),
            ],
          };
        } catch (error) {
          return failure(error, [{ path: sourcePath }]);
        }
      }),
      {
        name: "follow_link",
        description:
          "Resolve link text or a complete [[wikilink]] relative to the sourcePath note that contains it.",
        schema: FOLLOW_LINK_ARGUMENT,
        responseFormat: "content_and_artifact",
      }
    ),
    tool(
      wrap<{ query: string; limit?: number }>(async ({ query, limit }, signal) => {
        try {
          const resultLimit = limit ?? DEFAULT_SEARCH_LIMIT;
          const { documents, status } = await retrieval.runnable.invoke(
            { query, mode: "hybrid", limit: resultLimit },
            { signal }
          );
          const results = documents.slice(0, resultLimit).map((document) => ({
            path: String(document.metadata.path),
            context: document.pageContent,
          }));
          return {
            ok: true,
            data: {
              results,
              mode: status.mode,
              degraded: status.degraded,
              degradationReason: status.degradationReason,
            },
            provenance: results.map(({ path }) => ({ path })),
          };
        } catch (error) {
          return failure(error);
        }
      }),
      {
        name: "vault_search",
        description: "Search the current vault index and return matching note paths with context.",
        schema: SEARCH_ARGUMENT,
        responseFormat: "content_and_artifact",
      }
    ),
  ];
}
