import { afterEach, describe, expect, it, vi } from "vitest";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import { FakeToolCallingModel } from "langchain";
import { ChatSession } from "@/chat/ChatSession";
import { createVaultTools } from "@/tools/VaultTools";
import { VaultRetrieval } from "@/index/VaultRetrieval";
import type { NoteStoreCall } from "@/index/note-sqlite/protocol";
import { ConsoleDebug } from "@/plugin/ConsoleDebug";
import { LocalTraceHandler } from "@/plugin/LocalTracing";

afterEach(() => vi.restoreAllMocks());

describe("local retrieval tracing", () => {
  it("preserves ordered SQL candidates, status and signal without reading notes", async () => {
    const hits = [
      {
        path: "secret/a.md",
        score: 0.2,
        lexicalScore: 1,
        evidence: { uid: "u", profile: "p", startOffset: 2, endOffset: 5, sectionPath: ["s"] },
      },
      { path: "secret/b.md", score: 0.1, semanticScore: 0.8 },
    ];
    const call = vi.fn(async () => ({
      hits,
      mode: "lexical",
      degraded: true,
      degradationReason: "semantic-unavailable",
    })) as unknown as NoteStoreCall;
    const read = vi.fn();
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    const retrieval = new VaultRetrieval(
      call,
      undefined,
      undefined,
      read,
      new ConsoleDebug(() => true)
    );
    const controller = new AbortController();
    const result = await retrieval.searchCandidates(
      { query: "private query", mode: "hybrid", limit: 2 },
      controller.signal,
      true
    );
    expect(result.hits).toEqual(hits);
    expect(result.status).toEqual({
      mode: "lexical",
      degraded: true,
      degradationReason: "semantic-unavailable",
    });
    expect(result.signal.aborted).toBe(false);
    expect(call).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    controller.abort();
    expect(result.signal.aborted).toBe(true);
    const payload = JSON.stringify(output.mock.calls);
    expect(payload).toContain('"type":"retriever"');
    expect(payload).not.toContain("private query");
    expect(payload).not.toContain("secret/");
  });

  it("keeps zero-hit status and isolates diagnostic sink failures", async () => {
    const call = vi.fn(async () => ({
      hits: [],
      mode: "lexical",
      degraded: false,
    })) as unknown as NoteStoreCall;
    vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("sink failed");
    });
    const retrieval = new VaultRetrieval(
      call,
      undefined,
      undefined,
      vi.fn(),
      new ConsoleDebug(() => true)
    );
    expect(await retrieval.searchCandidates({ query: "x", mode: "lexical" })).toMatchObject({
      hits: [],
      status: { mode: "lexical", degraded: false },
    });
    expect(call).toHaveBeenCalledOnce();
  });

  it("reports fixed structural fields and cancellation without inputs or error text", () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    const controller = new AbortController();
    const handler = new LocalTraceHandler(new ConsoleDebug(() => true), controller.signal);
    handler.handleToolStart({ secret: "serialized" }, "private arguments", "child", "parent");
    controller.abort();
    handler.handleToolError(new Error("private error"), "child");
    expect(output).toHaveBeenCalledOnce();
    const payload = JSON.stringify(output.mock.calls);
    expect(payload).toContain('"parentRunId":"parent"');
    expect(payload).toContain('"outcome":"cancelled"');
    expect(payload).not.toMatch(/serialized|private/);
    const disabled = new LocalTraceHandler(new ConsoleDebug(() => false));
    disabled.handleRetrieverStart({}, "private query", "other");
    disabled.handleRetrieverEnd([], "other");
    expect(output).toHaveBeenCalledOnce();
  });
  it("uses the native chain parent ID and ignores the dynamic run name", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    const manager = new CallbackManager("parent-id");
    manager.addHandler(new LocalTraceHandler(new ConsoleDebug(() => true)), true);
    const run = await manager.handleChainStart(
      { lc: 1, type: "not_implemented", id: [] },
      {},
      "child-id",
      undefined,
      undefined,
      undefined,
      "private dynamic name"
    );
    await run.handleChainEnd({});
    expect(output).toHaveBeenCalledOnce();
    expect(output.mock.calls[0][1]).toMatchObject({
      type: "chain",
      runId: "child-id",
      parentRunId: "parent-id",
    });
    expect(JSON.stringify(output.mock.calls)).not.toContain("private dynamic name");
  });

  it("classifies a cancelled search even when the parent turn signal remains active", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    const parent = new AbortController();
    const call = vi.fn(
      (_method: string, _payload: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("private failure", "AbortError")),
            { once: true }
          );
        })
    ) as unknown as NoteStoreCall;
    const debug = new ConsoleDebug(() => true);
    const retrieval = new VaultRetrieval(call, undefined, undefined, vi.fn(), debug);
    const result = retrieval.searchCandidates(
      { query: "private query", mode: "lexical" },
      parent.signal,
      false,
      [new LocalTraceHandler(debug, parent.signal)]
    );
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
    retrieval.cancelSearches();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(parent.signal.aborted).toBe(false);
    expect(output.mock.calls[0][1]).toMatchObject({ type: "retriever", outcome: "cancelled" });
    expect(JSON.stringify(output.mock.calls)).not.toMatch(/private/);
  });

  it("carries native tool parentage through a streamed Voce turn", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    const debug = new ConsoleDebug(() => true);
    const vault = {
      readNote: async (path: string) => ({ path, content: "private note" }),
      resolveLink: async () => null,
      discoverLinks: async () => [],
    };
    const retrieval = new VaultRetrieval(
      async () => ({ hits: [{ path: "private.md", score: 1 }], mode: "lexical", degraded: false }),
      undefined,
      undefined,
      vault.readNote,
      debug
    );
    const model = new FakeToolCallingModel({
      toolCalls: [[{ id: "call-1", name: "vault_search", args: { query: "private query" } }], []],
    });
    const session = new ChatSession(
      model,
      () => createVaultTools(vault, retrieval),
      vault,
      () => {},
      debug
    );
    const state = await session.send({ content: "private prompt", attachmentPaths: [] });
    expect(state.turns.at(-1)).toMatchObject({ status: "complete" });
    const events = output.mock.calls
      .filter(([label]) => label === "[Trama] Local trace")
      .map(([, fields]) => fields as Record<string, unknown>);
    const tool = events.find((event) => event.type === "tool");
    const retriever = events.find((event) => event.type === "retriever");
    expect(tool).toBeDefined();
    expect(retriever?.parentRunId).toBe(tool?.runId);
    expect(events.some((event) => event.type === "model")).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/private|call-1/);
  });
  it("keeps interleaved queries, results, and run IDs independent", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    const pending = new Map<string, (result: unknown) => void>();
    const call = vi.fn(
      (_method: string, payload: { query: string }) =>
        new Promise((resolve) => pending.set(payload.query, resolve))
    ) as unknown as NoteStoreCall;
    const retrieval = new VaultRetrieval(
      call,
      undefined,
      undefined,
      vi.fn(),
      new ConsoleDebug(() => true)
    );
    const first = retrieval.searchCandidates({ query: "first", mode: "lexical" });
    const second = retrieval.searchCandidates({ query: "second", mode: "lexical" });
    await vi.waitFor(() => expect(pending.size).toBe(2));
    pending.get("second")!({
      hits: [{ path: "second.md", score: 2 }],
      mode: "lexical",
      degraded: false,
    });
    pending.get("first")!({
      hits: [{ path: "first.md", score: 1 }],
      mode: "lexical",
      degraded: false,
    });
    expect((await first).hits[0].path).toBe("first.md");
    expect((await second).hits[0].path).toBe("second.md");
    const ids = output.mock.calls.map(([, fields]) => (fields as Record<string, unknown>).runId);
    expect(new Set(ids).size).toBe(2);
    expect(call).toHaveBeenCalledTimes(2);
  });
});

describe.skipIf(!process.env.TRAMA_SYNTHETIC_NETWORK)("synthetic tracing host", () => {
  it("captures tracing attempts without making network requests", async () => {
    const requests: { url: string; headers: string }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        headers: (() => {
          const entries: Record<string, string> = {};
          new Headers(init?.headers).forEach((value, key) => {
            entries[key] = value;
          });
          return JSON.stringify(entries);
        })(),
      });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    const debug = new ConsoleDebug(() => true);
    const vault = {
      readNote: async (path: string) => ({ path, content: "note" }),
      resolveLink: async () => null,
      discoverLinks: async () => [],
    };
    const retrieval = new VaultRetrieval(
      async () => ({ hits: [], mode: "lexical", degraded: false }),
      undefined,
      undefined,
      vault.readNote,
      debug
    );
    await retrieval.searchCandidates({ query: "term", mode: "lexical" });
    const model = new FakeToolCallingModel({
      toolCalls: [[{ id: "call", name: "vault_search", args: { query: "term" } }], []],
    });
    const session = new ChatSession(
      model,
      () => createVaultTools(vault, retrieval),
      vault,
      () => {},
      debug
    );
    expect(
      (await session.send({ content: "prompt", attachmentPaths: [] })).turns.at(-1)
    ).toMatchObject({ status: "complete" });
    if (process.env.TRAMA_SYNTHETIC_NETWORK === "enabled") {
      await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0), { timeout: 5000 });
      expect(JSON.stringify(requests)).not.toContain("synthetic-model-key");
      expect(requests.every(({ headers }) => !/x-api-key|authorization/i.test(headers))).toBe(true);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(requests).toEqual([]);
    }
    expect(JSON.stringify(output.mock.calls)).toContain('"type":"retriever"');
    expect(JSON.stringify(output.mock.calls)).not.toContain("synthetic-model-key");
    vi.unstubAllGlobals();
  });
});
