import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { ProvenanceRecord, ReadonlyVault } from "@/domain/vault";
import type { StructuredErrorShape } from "@/domain/errors";
import { StructuredError, isCancelled } from "@/domain/errors";
import type { VaultRetrieval } from "@/index/VaultRetrieval";

export interface VaultToolOutcome {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: StructuredErrorShape;
  readonly provenance: readonly ProvenanceRecord[];
}

export type VaultToolFactory = () => StructuredToolInterface[];

const PATHS_ARGUMENT = z
  .object({
    paths: z.array(z.string().min(1).max(4096)).min(1).max(100),
    sourcePath: z.string().min(1).max(4096).optional(),
  })
  .strict();
const DISCOVER_LINKS_ARGUMENT = z
  .object({
    path: z.string().min(1).max(4096),
    limit: z
      .number()
      .int()
      .positive()
      .safe()
      .max(1000)
      .describe("Maximum links to return (default: 25, maximum: 1000).")
      .optional(),
  })
  .strict();
const SEARCH_ARGUMENT = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .describe("An exact term, phrase, or natural-language concept to search for."),
    limit: z
      .number()
      .int()
      .positive()
      .safe()
      .max(1000)
      .describe("Maximum search results to return (default: 10, maximum: 1000).")
      .optional(),
  })
  .strict();

const DEFAULT_LINK_LIMIT = 25;
const DEFAULT_SEARCH_LIMIT = 10;
const SEARCH_PREVIEW_CHARS = 1_000;
const SEARCH_OUTPUT_CHARS = 12_000;

function failure(error: unknown, provenance: readonly ProvenanceRecord[] = []): VaultToolOutcome {
  const cancelled = isCancelled(error);
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

async function readOneNote(
  vault: ReadonlyVault,
  path: string,
  signal: AbortSignal,
  sourcePath?: string
): Promise<{ note: unknown; provenance: readonly ProvenanceRecord[] }> {
  const isPath = path.trim() !== path || path.toLowerCase().endsWith(".md");
  const details =
    sourcePath && !isPath
      ? vault.resolveLinkDetails
        ? await vault.resolveLinkDetails(path, sourcePath, signal)
        : { path: await vault.resolveLink(path, sourcePath, signal) }
      : undefined;
  const targetPath = isPath
    ? path
    : (details?.path ?? (sourcePath ? null : await vault.resolveLink(path, null, signal)));
  if (!targetPath)
    throw new Error(
      `No visible note matches '${path}'. Use an exact vault-relative .md path or a unique note title.`
    );
  const note = await vault.readNote(targetPath, signal);
  return {
    note,
    provenance: [
      ...(details
        ? [
            {
              path: sourcePath!,
              ...(details.startLine !== undefined || details.endLine !== undefined
                ? { startLine: details.startLine, endLine: details.endLine }
                : {}),
            },
          ]
        : []),
      { path: note.path, startLine: note.startLine, endLine: note.endLine },
    ],
  };
}

async function readNotes(
  vault: ReadonlyVault,
  paths: readonly string[],
  signal: AbortSignal,
  sourcePath?: string
): Promise<VaultToolOutcome> {
  const results: {
    requestedPath: string;
    note?: unknown;
    error?: StructuredErrorShape;
    provenance?: readonly ProvenanceRecord[];
  }[] = [];
  for (let offset = 0; offset < paths.length; offset += 4) {
    if (signal.aborted) return failure(new DOMException("Operation cancelled", "AbortError"));
    const batch = paths.slice(offset, offset + 4);
    const completed = await Promise.all(
      batch.map(async (requestedPath) => {
        try {
          const result = await readOneNote(vault, requestedPath, signal, sourcePath);
          return { requestedPath, ...result };
        } catch (error) {
          return { requestedPath, error: failure(error).error };
        }
      })
    );
    if (signal.aborted) return failure(new DOMException("Operation cancelled", "AbortError"));
    results.push(...completed);
  }
  return {
    ok: true,
    data: {
      results: results.map(({ requestedPath, note, error }) =>
        error ? { requestedPath, error } : { requestedPath, note }
      ),
    },
    provenance: results.flatMap((result) => result.provenance ?? []),
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
      wrap<{ paths: string[]; sourcePath?: string }>(async ({ paths, sourcePath }, signal) =>
        readNotes(vault, paths, signal, sourcePath)
      ),
      {
        name: "read_notes",
        description:
          "Read full content from multiple Markdown notes in one call. Provide canonical vault-relative .md paths when known, or unique titles and complete [[wikilinks]]. Set sourcePath to resolve supplied links relative to their source note.",
        schema: PATHS_ARGUMENT,
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
        description:
          "Discover resolved and unresolved outgoing links, with a bounded result count (default: 25).",
        schema: DISCOVER_LINKS_ARGUMENT,
        responseFormat: "content_and_artifact",
      }
    ),
    tool(
      wrap<{ query: string; limit?: number }>(async ({ query, limit }, signal) => {
        try {
          const resultLimit = limit ?? DEFAULT_SEARCH_LIMIT;
          const {
            hits,
            status,
            signal: searchSignal,
          } = await retrieval.searchCandidates(
            { query, mode: "hybrid", limit: resultLimit },
            signal
          );
          const results: { path: string; context: string; contextTruncated: boolean }[] = [];
          let hydratedCount = 0;
          for (const hit of hits) {
            if (results.length >= resultLimit) break;
            const document = await retrieval.readSearchCandidate(hit, searchSignal);
            if (!document) continue;
            hydratedCount++;
            const context = document.pageContent.slice(0, SEARCH_PREVIEW_CHARS);
            const candidate = {
              path: String(document.metadata.path),
              context,
              contextTruncated: document.pageContent.length > context.length,
            };
            const nextResults = [...results, candidate];
            const data = {
              results: nextResults,
              candidateCount: hits.length,
              hydratedCount,
              returnedCount: nextResults.length,
              omittedCount: hits.length - nextResults.length,
              mode: status.mode,
              degraded: status.degraded,
              degradationReason: status.degradationReason,
            };
            if (JSON.stringify(data).length > SEARCH_OUTPUT_CHARS) break;
            results.push(candidate);
          }
          return {
            ok: true,
            data: {
              results,
              candidateCount: hits.length,
              hydratedCount,
              returnedCount: results.length,
              omittedCount: hits.length - results.length,
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
        description:
          "Search the vault for ranked discovery excerpts with canonical note paths. Excerpts and the total response are bounded; read_notes returns full note content when needed.",
        schema: SEARCH_ARGUMENT,
        responseFormat: "content_and_artifact",
      }
    ),
  ];
}
