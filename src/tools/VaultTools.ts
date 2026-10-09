import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { ProvenanceRecord, ReadonlyVault } from "@/domain/vault";
import type { StructuredErrorShape } from "@/domain/errors";
import type { VaultRetrieval } from "@/index/VaultRetrieval";

export interface VaultToolOutcome {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: StructuredErrorShape;
  readonly provenance: readonly ProvenanceRecord[];
}

export type VaultToolObserver = (
  name: string,
  call: {
    readonly id: string;
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  },
  result: VaultToolOutcome,
  durationMs: number
) => void;

export type VaultToolFactory = (observer: VaultToolObserver) => StructuredToolInterface[];

const PATH_ARGUMENT = z.object({ path: z.string().min(1) }).strict();
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
  })
  .strict();

const MAX_LINKS = 100;
const MAX_LINK_CONTENT = 16_000;
const MAX_SEARCH_RESULTS = 7;
export const MAX_TOOL_CONTENT = 32_000;

function failure(error: unknown, provenance: readonly ProvenanceRecord[] = []): VaultToolOutcome {
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
  retrieval: VaultRetrieval,
  observer: VaultToolObserver
): StructuredToolInterface[] {
  let contentSize = 0;
  const wrap =
    <Input extends Record<string, unknown>>(
      name: string,
      operation: (input: Input, signal: AbortSignal) => Promise<VaultToolOutcome>
    ) =>
    async (input: Input, runtime: { signal?: AbortSignal; toolCallId: string }) => {
      const started = Date.now();
      const result = await operation(input, runtime.signal ?? new AbortController().signal);
      const serialized = JSON.stringify(result.ok ? result.data : result.error) ?? "";
      const content =
        contentSize + serialized.length > MAX_TOOL_CONTENT
          ? "Tool-result content limit reached; use the evidence already collected."
          : serialized;
      contentSize += serialized.length;
      observer(
        name,
        { id: runtime.toolCallId, name, arguments: input },
        result,
        Date.now() - started
      );
      return [content, result] as const;
    };

  return [
    tool(
      wrap<{ path: string }>("read_note", async ({ path }, signal) => {
        try {
          const note = await vault.readNote(path, signal);
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
        description: "Read a bounded Markdown note.",
        schema: PATH_ARGUMENT,
        responseFormat: "content_and_artifact",
      }
    ),
    tool(
      wrap<{ path: string }>("discover_links", async ({ path }, signal) => {
        try {
          const discovered = await vault.discoverLinks(path, signal, MAX_LINKS);
          let links = discovered.slice(0, MAX_LINKS);
          let truncated = discovered.length >= MAX_LINKS;
          let serialized = JSON.stringify({ links, truncated, resultLimit: MAX_LINKS });
          while (links.length && serialized.length > MAX_LINK_CONTENT) {
            links = links.slice(0, -1);
            truncated = true;
            serialized = JSON.stringify({ links, truncated, resultLimit: MAX_LINKS });
          }
          return {
            ok: true,
            data: { links, truncated, resultLimit: MAX_LINKS },
            provenance: linkProvenance(links, path),
          };
        } catch (error) {
          return failure(error, [{ path }]);
        }
      }),
      {
        name: "discover_links",
        description: "Discover resolved and unresolved links in a note.",
        schema: PATH_ARGUMENT,
        responseFormat: "content_and_artifact",
      }
    ),
    tool(
      wrap<{ link: string; sourcePath: string }>(
        "follow_link",
        async ({ link, sourcePath }, signal) => {
          try {
            const details = vault.resolveLinkDetails
              ? await vault.resolveLinkDetails(link, sourcePath, signal)
              : { path: await vault.resolveLink(link, sourcePath, signal) };
            if (!details) return { ok: true, data: { path: null }, provenance: [] };
            const target = details.path ? await vault.readNote(details.path, signal) : null;
            return {
              ok: true,
              data: { path: details.path },
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
        }
      ),
      {
        name: "follow_link",
        description: "Resolve a wikilink relative to its source note.",
        schema: FOLLOW_LINK_ARGUMENT,
        responseFormat: "content_and_artifact",
      }
    ),
    tool(
      wrap<{ query: string }>("vault_search", async ({ query }, signal) => {
        try {
          const { documents, status } = await retrieval.runnable.invoke(
            { query, mode: "hybrid" },
            { signal }
          );
          const results = documents.slice(0, MAX_SEARCH_RESULTS).map((document) => ({
            path: String(document.metadata.path),
            context: document.pageContent.slice(0, 1_600),
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
        description:
          "Search the current vault index and return matching note paths with bounded context.",
        schema: SEARCH_ARGUMENT,
        responseFormat: "content_and_artifact",
      }
    ),
  ];
}
