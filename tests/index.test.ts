import { describe, expect, it, vi } from "vitest";
import { StructuredError, type IndexProgress } from "@/domain/contracts";
import { projectDiagnosticError, type TramaDiagnosticRecord } from "@/diagnostics/TramaDiagnostics";
import { CHUNK_OVERLAP, CHUNK_SIZE, chunkMarkdown } from "@/index/chunking";
import { IndexManager, createIndexFingerprint } from "@/index/IndexManager";
import { LenteSearch } from "@/index/LenteSearch";
import { SqliteWorkerClient } from "@/index/sqlite/client";
import { SQLITE_PROTOCOL_VERSION, sqliteError } from "@/index/sqlite/protocol";
import { createTestSqliteClient } from "./sqlite-test-client";
import { IndexStatusController } from "@/ui/index/IndexStatus";
import { TRAMA_RUNTIME_BUILD_ID } from "@/build/identity";

const signal = new AbortController().signal;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

class HandshakeWorker {
  readonly messages: { value: any; transfer?: readonly ArrayBuffer[] }[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<(event: any) => void>>();
  postMessage(value: any, transfer?: readonly ArrayBuffer[]): void {
    this.messages.push({ value, transfer });
  }
  terminate(): void {
    this.terminated = true;
  }
  addEventListener(type: string, listener: (event: any) => void): void {
    let listeners = this.listeners.get(type);
    if (!listeners) this.listeners.set(type, (listeners = new Set()));
    listeners.add(listener);
  }
  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function fixture(contents: Record<string, string>) {
  return {
    listMarkdownPaths: async () => Object.keys(contents),
    readMarkdown: async (path: string) => {
      if (!Object.prototype.hasOwnProperty.call(contents, path))
        throw new Error(`Missing note: ${path}`);
      return { path, content: contents[path] };
    },
    isMarkdownAvailable: async (path: string) =>
      Object.prototype.hasOwnProperty.call(contents, path),
    estimateMarkdownTextCount: async (paths: readonly string[], size: number, overlap: number) => {
      const stride = Math.max(1, size - overlap);
      return paths.reduce(
        (total, path) =>
          total + (contents[path] ? Math.max(1, Math.ceil(contents[path].length / stride)) : 0),
        0
      );
    },
  };
}

function embeddings(dimensions = 2) {
  return {
    dimensions,
    embed: vi.fn(async (texts: readonly string[]) =>
      texts.map((text) => {
        const lower = text.toLowerCase();
        return Array.from({ length: dimensions }, (_, index) =>
          index === 0 ? (lower.includes("alpha") ? 1 : 0) : lower.includes("beta") ? 1 : 0
        );
      })
    ),
  };
}

function manager(contents: Record<string, string>, identity: object = {}, model = embeddings()) {
  return {
    contents,
    model,
    manager: new IndexManager(fixture(contents), model, "HTTP://127.0.0.1:1234/v1/", "embed", {
      size: 100,
      overlap: 10,
      sqliteClient: createTestSqliteClient(identity),
    }),
  };
}

function racedManager(contents: Record<string, string>, repeat = false) {
  const identity = {};
  const base = createTestSqliteClient(identity);
  let armed = false;
  let fired = 0;
  const client = new SqliteWorkerClient(undefined, async (method, payload, requestSignal) => {
    const result = await base.call(method, payload, requestSignal);
    if (armed && method === "finishLexicalRun" && (repeat || fired === 0)) {
      fired++;
      target.queueChange();
    }
    return result;
  });
  const model = embeddings();
  const target = new IndexManager(fixture(contents), model, "HTTP://127.0.0.1:1234/v1/", "embed", {
    size: 100,
    overlap: 10,
    sqliteClient: client,
  });
  return {
    manager: target,
    arm: () => (armed = true),
    get fired() {
      return fired;
    },
  };
}

describe("semantic index module", () => {
  it("completes the runtime handshake before boot or vault reads", async () => {
    const contents = { "note.md": "alpha\nfirst" };
    const reads: string[] = [];
    const events: string[] = [];
    const base = createTestSqliteClient({});
    const worker = new HandshakeWorker();
    worker.postMessage = ((value: any, transfer?: readonly ArrayBuffer[]) => {
      worker.messages.push({ value, transfer });
      if (value.type === "trama-runtime-handshake") {
        events.push("handshake");
        queueMicrotask(() =>
          worker.emit("message", {
            data: { type: value.type, id: value.id, buildId: TRAMA_RUNTIME_BUILD_ID },
          })
        );
        return;
      }
      events.push(value.method);
      void base.call(value.method, value.payload).then((result) =>
        worker.emit("message", {
          data: { v: SQLITE_PROTOCOL_VERSION, id: value.id, ok: true, result },
        })
      );
    }) as any;
    const vault = {
      ...fixture(contents),
      readMarkdown: async (path: string) => {
        reads.push(path);
        events.push("read");
        return fixture(contents).readMarkdown(path);
      },
    };
    const index = new IndexManager(vault, embeddings(), "http://127.0.0.1:1234/v1", "embed", {
      sqliteClient: new SqliteWorkerClient(worker),
    });

    await index.build(signal);
    expect(worker.messages[0].value.type).toBe("trama-runtime-handshake");
    expect(worker.messages[1].value.method).toBe("boot");
    expect(reads.length).toBeGreaterThan(0);
    expect(events.slice(0, 2)).toEqual(["handshake", "boot"]);
    await index.dispose();
  });

  it("stops at a Worker handshake mismatch before any boot or vault access", async () => {
    const worker = new HandshakeWorker();
    const calls: string[] = [];
    worker.postMessage = ((value: any, transfer?: readonly ArrayBuffer[]) => {
      worker.messages.push({ value, transfer });
      if (value.type === "trama-runtime-handshake")
        queueMicrotask(() =>
          worker.emit("message", {
            data: { type: value.type, id: value.id, buildId: "stale-runtime" },
          })
        );
      else calls.push(value.method);
    }) as any;
    const vault = {
      listMarkdownPaths: async () => {
        calls.push("listMarkdownPaths");
        return ["note.md"];
      },
      readMarkdown: async () => {
        calls.push("readMarkdown");
        return { path: "note.md", content: "alpha" };
      },
      isMarkdownAvailable: async () => true,
    };
    const index = new IndexManager(vault, embeddings(), "http://127.0.0.1:1234/v1", "embed", {
      sqliteClient: new SqliteWorkerClient(worker),
    });

    await expect(index.load()).resolves.toBe(false);
    expect(worker.messages.map(({ value }) => value.type ?? value.method)).toEqual([
      "trama-runtime-handshake",
    ]);
    expect(calls).toEqual([]);
  });

  it("hashes and chunks build and update notes through the SQLite Worker boundary", async () => {
    const contents = { "note.md": "alpha\nfirst" };
    const identity = {};
    const base = createTestSqliteClient(identity);
    const methods: string[] = [];
    const client = new SqliteWorkerClient(undefined, async (method, payload, requestSignal) => {
      methods.push(method);
      return base.call(method, payload, requestSignal);
    });
    const index = new IndexManager(
      fixture(contents),
      embeddings(),
      "http://127.0.0.1:1234/v1",
      "embed",
      { sqliteClient: client }
    );

    await index.build(signal);
    expect(methods).toContain("beginLexicalRun");
    expect(methods).toContain("applyLexicalBatch");
    expect(methods).toContain("finishLexicalRun");
    expect(methods).not.toContain("upsertNote");
    methods.length = 0;
    contents["note.md"] = "beta\nsecond";
    await index.synchronize(signal);
    expect(methods).toContain("beginLexicalRun");
    expect(methods).toContain("applyLexicalBatch");
    expect(methods).toContain("finishLexicalRun");
    expect(methods).not.toContain("upsertNote");
    expect(await index.search("second", signal, 5)).toHaveLength(1);
  });

  it("fails safe when no Worker is injected instead of creating a memory backend", async () => {
    const setup = new IndexManager(
      fixture({ "unavailable.md": "alpha" }),
      embeddings(),
      "http://127.0.0.1:1234/v1",
      "embed"
    );
    await expect(setup.load()).resolves.toBe(false);
    expect(setup.hasUsableIndex()).toBe(false);
  });

  it("does not read or hash notes after a failed SQLite boot", async () => {
    const reads: string[] = [];
    const vault = {
      listMarkdownPaths: async () => ["note.md"],
      readMarkdown: async (path: string) => {
        reads.push(path);
        return { path, content: "alpha" };
      },
      isMarkdownAvailable: async () => true,
    };
    const base = createTestSqliteClient({});
    const methods: string[] = [];
    const client = new SqliteWorkerClient(undefined, async (method, payload, requestSignal) => {
      methods.push(method);
      if (method === "boot") throw sqliteError("storage_unavailable", "SQLite boot failed", true);
      return base.call(method, payload, requestSignal);
    });
    const setup = new IndexManager(vault, embeddings(), "http://127.0.0.1:1234/v1", "embed", {
      sqliteClient: client,
    });

    await expect(setup.load()).resolves.toBe(false);
    await expect(setup.synchronize(signal)).rejects.toMatchObject({
      error: { code: "storage_unavailable", message: "SQLite boot failed", retryable: true },
    });
    expect(reads).toEqual([]);
    expect(methods).toEqual(["boot"]);
  });

  it("surfaces a safe actionable error when the SQLite Worker cannot start", async () => {
    const setup = new IndexManager(
      fixture({ "unavailable.md": "alpha" }),
      embeddings(),
      "http://127.0.0.1:1234/v1",
      "embed",
      {
        workerFactory: () => {
          throw new Error("file:///private/user/vault/.obsidian/plugins/trama/main.js");
        },
      }
    );
    await expect(setup.build(signal)).rejects.toMatchObject({
      error: {
        code: "storage_unavailable",
        message:
          "SQLite Worker could not be started. Ensure the bundled SQLite assets are installed.",
      },
    });
    await expect(setup.build(signal)).rejects.not.toThrow("/private/user/vault");
  });

  it("emits metadata-only lifecycle diagnostics", async () => {
    const records: TramaDiagnosticRecord[] = [];
    const setup = new IndexManager(
      fixture({ "private.md": "alpha PRIVATE_SENTINEL" }),
      embeddings(),
      "http://127.0.0.1:1234/v1",
      "embed",
      { size: 100, overlap: 10, sqliteClient: createTestSqliteClient({}) },
      { emit: (record) => records.push(record) }
    );
    await setup.build(signal);
    await setup.search("alpha", signal, 1);
    expect(JSON.stringify(records)).not.toContain("PRIVATE_SENTINEL");
    expect(records.every((record) => !("text" in record))).toBe(true);
    expect(
      records.some(
        (record) =>
          record.area === "index" &&
          record.event === "index_operation" &&
          record.operation === "build" &&
          record.stage === "completed"
      )
    ).toBe(true);
    expect(records).toContainEqual(
      expect.objectContaining({
        operation: "startup",
        phase: "handshake",
        runtime: expect.objectContaining({
          expectedBuildId: expect.any(String),
          actualBuildId: expect.any(String),
          protocolVersion: expect.any(Number),
          schemaVersion: expect.any(Number),
        }),
      })
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        area: "index",
        event: "index_operation",
        operation: "search",
        stage: "completed",
        phase: "lexical",
        durationMs: expect.any(Number),
        counts: { results: 1 },
      })
    );
  });

  it("reports a first-note hash failure as a safe failed build", async () => {
    const records: TramaDiagnosticRecord[] = [];
    const progress: IndexProgress[] = [];
    const base = createTestSqliteClient({});
    let failed = false;
    const client = new SqliteWorkerClient(undefined, async (method, payload, requestSignal) => {
      if (method === "applyLexicalBatch" && !failed) {
        failed = true;
        throw sqliteError(
          "storage_unavailable",
          "SQLite failed for /private/vault/Secret.md",
          true
        );
      }
      return base.call(method, payload, requestSignal);
    });
    const setup = new IndexManager(
      fixture({ "Secret.md": "alpha" }),
      embeddings(),
      "http://127.0.0.1:1234/v1",
      "embed",
      { onProgress: (value) => progress.push(value), sqliteClient: client },
      { emit: (record) => records.push(record) }
    );

    await expect(setup.build(signal)).rejects.toMatchObject({
      error: { code: "storage_unavailable", retryable: true },
    });
    const failure = records.find(
      (record) =>
        record.area === "index" &&
        record.event === "index_operation" &&
        record.operation === "build" &&
        record.stage === "failed"
    );
    expect(failure).toBeDefined();
    expect(JSON.stringify(failure)).not.toContain("Secret.md");
    expect(progress.some((entry) => entry.phase === "read")).toBe(true);
  });

  it("builds and searches hydrated evidence through the mutable backend", async () => {
    const setup = manager({ "a.md": "alpha note", "b.md": "beta note" });
    await setup.manager.build(signal);
    await expect(setup.manager.search("alpha", signal, 5)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "a.md", excerpt: "alpha note", startLine: 1 }),
      ])
    );
    await expect(setup.manager.getState()).resolves.toMatchObject({
      incomplete: false,
      changeCounter: expect.any(Number),
    });
    expect(setup.manager.vaultSearchState()).toMatchObject({
      semantic: { state: "incompatible", searchable: false },
      freshness: "locally-reconciled",
    });
  });

  it("defaults vault search to hybrid and allows explicit lexical retrieval", async () => {
    const setup = manager({ "a.md": "alpha note" });
    await setup.manager.build(signal);
    await setup.manager.prepareSemantic(signal);
    setup.model.embed.mockClear();

    await expect(setup.manager.search("alpha", signal, 5, "lexical")).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "a.md" })])
    );
    expect(setup.model.embed).not.toHaveBeenCalled();

    await expect(setup.manager.search("alpha", signal, 5)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "a.md" })])
    );
    expect(setup.model.embed).toHaveBeenCalledTimes(1);
  });

  it("reports semantic preparation against the whole missing-vector count", async () => {
    const progress: IndexProgress[] = [];
    const model = embeddings();
    const index = new IndexManager(
      fixture({ "a.md": "alpha", "b.md": "beta" }),
      model,
      "http://127.0.0.1:1234/v1",
      "embed",
      {
        prepareBatchSize: 1,
        onProgress: (value) => progress.push(value),
        sqliteClient: createTestSqliteClient({}),
      }
    );

    await index.build(signal);
    await index.prepareSemantic(signal);

    const vectors = progress.filter((value) => value.phase === "build-vector");
    expect(vectors[0]).toMatchObject({ completed: 0, total: 2, determinate: true });
    expect(vectors.at(-1)).toMatchObject({ completed: 1, total: 1, determinate: true });
  });

  it("keeps automatic semantic work to one small batch and preserves explicit Prepare", async () => {
    const model = embeddings();
    model.embed.mockImplementation(async (texts) => texts.map(() => [1, 0]));
    const index = new IndexManager(
      fixture({ "a.md": "x".repeat(160), "b.md": "y" }),
      model,
      "http://127.0.0.1:1234/v1",
      "embed",
      { size: 64, overlap: 0, prepareBatchSize: 1, sqliteClient: createTestSqliteClient({}) }
    );
    await index.build(signal);
    expect(index.hasCompatibleSemanticVectors()).toBe(false);

    await expect(index.prepareSemanticCacheBatch(signal)).resolves.toMatchObject({
      stored: 1,
      converged: false,
    });
    expect(model.embed).toHaveBeenCalledTimes(1);
    expect(model.embed.mock.calls[0][0]).toHaveLength(1);
    expect(index.hasCompatibleSemanticVectors()).toBe(false);

    await expect(index.prepareSemantic(signal)).resolves.toMatchObject({
      stored: 2,
      converged: true,
    });
    expect(model.embed).toHaveBeenCalledTimes(3);
  });

  it("reports pending semantic work for a fresh lexical-only index", async () => {
    const model = embeddings();
    const index = new IndexManager(
      fixture({ "a.md": "alpha" }),
      model,
      "http://127.0.0.1:1234/v1",
      "embed",
      { size: 64, overlap: 0, sqliteClient: createTestSqliteClient({}) }
    );

    await index.build(signal);
    expect(index.hasCompatibleSemanticVectors()).toBe(false);
    expect(index.hasPendingSemanticWork()).toBe(true);

    await expect(index.prepareSemantic(signal)).resolves.toMatchObject({
      stored: 1,
      converged: true,
    });
    expect(model.embed).toHaveBeenCalledTimes(1);
    expect((await index.getState())?.semanticHeadCount).toBe(1);
    expect(index.hasPendingSemanticWork()).toBe(false);
  });

  it("keeps committed automatic semantic batches when the next request is cancelled", async () => {
    const model = embeddings();
    model.embed.mockImplementation(async (texts) => texts.map(() => [1, 0]));
    const index = new IndexManager(
      fixture({ "a.md": "x".repeat(160) }),
      model,
      "http://127.0.0.1:1234/v1",
      "embed",
      { size: 64, overlap: 0, sqliteClient: createTestSqliteClient({}) }
    );
    await index.build(signal);
    await index.prepareSemanticCacheBatch(signal);
    const committed = (await index.getState())!.semanticHeadCount;
    expect(committed).toBe(1);

    const abort = new AbortController();
    const nextBatch = index.prepareSemanticCacheBatch(abort.signal);
    await expect(nextBatch).resolves.toMatchObject({ converged: true });
    expect((await index.getState())?.semanticHeadCount).toBe(committed);
  });

  it("automatically prepares only chunks invalidated by a lexical update", async () => {
    const contents = { "a.md": "alpha stable", "b.md": "beta stable" };
    const setup = manager(contents);
    await setup.manager.build(signal);
    await setup.manager.prepareSemantic(signal);
    expect(setup.manager.hasCompatibleSemanticVectors()).toBe(true);

    contents["a.md"] = "alpha changed";
    await setup.manager.synchronize(signal);
    setup.model.embed.mockClear();
    expect((await setup.manager.getState())?.semanticHeadCount).toBe(2);

    await expect(setup.manager.prepareSemanticCacheBatch(signal)).resolves.toMatchObject({
      stored: 1,
      converged: true,
    });
    expect(setup.model.embed).toHaveBeenCalledTimes(1);
    expect(setup.model.embed.mock.calls[0][0]).toEqual([
      '{"v":1,"heading":[],"body":"alpha changed"}',
    ]);
  });

  it("does not consider vectors compatible after the embedding identity changes", async () => {
    const identity = {};
    const setup = manager({ "a.md": "alpha" }, identity);
    await setup.manager.build(signal);
    await setup.manager.prepareSemantic(signal);
    const changedModel = new IndexManager(
      fixture({ "a.md": "alpha" }),
      embeddings(),
      "http://127.0.0.1:1234/v1",
      "embed-v2",
      { size: 100, overlap: 10, sqliteClient: createTestSqliteClient(identity) }
    );
    await changedModel.load();
    expect(changedModel.hasCompatibleSemanticVectors()).toBe(false);
    expect(await changedModel.getState()).toMatchObject({ compatibleVectorCount: 0 });
  });

  it("rebuilds semantic vectors without rebuilding the lexical index", async () => {
    const setup = manager({ "a.md": "alpha", "b.md": "beta" });
    await setup.manager.build(signal);
    await setup.manager.prepareSemantic(signal);
    const before = await setup.manager.getState();
    const pending = deferred<(0 | 1)[][]>();
    setup.model.embed.mockImplementationOnce(() => pending.promise);

    const rebuild = setup.manager.rebuildSemantic(signal);
    await vi.waitFor(() =>
      expect(setup.manager.capabilities().semantic).toMatchObject({
        activity: "updating",
        searchable: false,
      })
    );
    await vi.waitFor(async () =>
      expect(await setup.manager.getState()).toMatchObject({ vectorCount: 0, noteCount: 2 })
    );
    expect(await setup.manager.search("alpha", signal, 5)).toHaveLength(1);
    pending.resolve([
      [1, 0],
      [0, 1],
    ]);
    await expect(rebuild).resolves.toMatchObject({
      operation: "rebuild",
      stored: 2,
      converged: true,
    });
    expect((await setup.manager.getState())?.changeCounter).toBeGreaterThan(before!.changeCounter);
  });

  it("finishes semantic preparation for its indexed corpus despite queued note edits", async () => {
    const contents = { "a.md": "alpha", "b.md": "beta" };
    const model = embeddings();
    const progress: IndexProgress[] = [];
    const index = new IndexManager(fixture(contents), model, "http://127.0.0.1:1234/v1", "embed", {
      prepareBatchSize: 1,
      onProgress: (value) => progress.push(value),
      sqliteClient: createTestSqliteClient({}),
    });
    await index.build(signal);
    const pending = deferred<(0 | 1)[][]>();
    model.embed.mockImplementationOnce(() => pending.promise);

    const preparation = index.prepareSemantic(signal);
    await vi.waitFor(() => expect(model.embed).toHaveBeenCalledOnce());
    contents["a.md"] = "alpha changed";
    index.queueChange();
    await expect(index.synchronize(signal)).rejects.toMatchObject({ code: "busy" });
    await expect(index.build(signal)).rejects.toMatchObject({ code: "busy" });
    pending.resolve([[1, 0]]);

    await expect(preparation).resolves.toMatchObject({ converged: false, stored: 2, skipped: 0 });
    expect(model.embed).toHaveBeenCalledTimes(2);
    expect(progress.filter((value) => value.phase === "build-vector").at(-1)).toMatchObject({
      completed: expect.any(Number),
      total: expect.any(Number),
    });
    expect(index.capabilities()).toMatchObject({
      freshness: "unknown",
      semantic: { state: "ready", searchable: true },
    });
    await expect(index.synchronize(signal)).resolves.toMatchObject({ converged: true });
    await expect(index.prepareSemantic(signal)).resolves.toMatchObject({
      converged: true,
      stored: 1,
    });
  });

  it("keeps indexed lexical and semantic results available while notes are stale", async () => {
    const setup = manager({ "a.md": "alpha", "b.md": "alpha beta", "c.md": "beta" });
    await setup.manager.build(signal);
    await setup.manager.prepareSemantic(signal);

    setup.contents["c.md"] = "gamma";
    setup.manager.queueChange();
    expect(setup.manager.capabilities().freshness).toBe("unknown");
    await expect(setup.manager.search("alpha", signal, 5)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "a.md" })])
    );
    await expect(setup.manager.findRelated("a.md", signal, 5)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "b.md" })])
    );

    await setup.manager.synchronize(signal);
    expect(setup.manager.capabilities().semantic).toMatchObject({
      state: "partial",
      searchable: true,
    });
    await expect(setup.manager.findRelated("a.md", signal, 5)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "b.md" })])
    );
  });

  it("reports lexical degradation when hybrid query embedding fails", async () => {
    const setup = manager({ "a.md": "alpha note" });
    await setup.manager.build(signal);
    await setup.manager.prepareSemantic(signal);
    setup.model.embed.mockClear();
    setup.model.embed.mockRejectedValueOnce(new Error("embedding service unavailable"));

    const lente = new LenteSearch(setup.manager, { getMtime: () => 1 });
    await expect(lente.search("alpha")).resolves.toMatchObject({
      mode: "lexical",
      degraded: true,
      degradationReason: "query-embedding-failed",
      results: [expect.objectContaining({ path: "a.md" })],
    });
    expect(setup.model.embed).toHaveBeenCalledTimes(1);
  });

  it("keeps unchanged synchronization write-free and embedding-free", async () => {
    const setup = manager({ "a.md": "alpha" });
    await setup.manager.build(signal);
    const before = await setup.manager.getState();
    setup.model.embed.mockClear();
    await expect(setup.manager.synchronize(signal)).resolves.toEqual({
      changed: false,
      converged: true,
    });
    expect(setup.model.embed).not.toHaveBeenCalled();
    await expect(setup.manager.getState()).resolves.toEqual(before);
  });

  it("reopens a complete backend without startup embedding or invalidation", async () => {
    const identity = {};
    const setup = manager({ "a.md": "alpha" }, identity);
    await setup.manager.build(signal);
    expect((await setup.manager.getState())?.incomplete).toBe(false);
    setup.model.embed.mockClear();

    const reopened = new IndexManager(
      fixture({ "a.md": "alpha" }),
      setup.model,
      "HTTP://127.0.0.1:1234/v1/",
      "embed",
      { size: 100, overlap: 10, sqliteClient: createTestSqliteClient(identity) }
    );
    await expect(reopened.load()).resolves.toBe(true);
    await expect(reopened.getState()).resolves.toMatchObject({ incomplete: false, noteCount: 1 });
    expect(setup.model.embed).not.toHaveBeenCalled();
  });

  it("marks mutable state incomplete during changes and converges after update", async () => {
    const setup = manager({ "a.md": "alpha" });
    await setup.manager.build(signal);
    const before = (await setup.manager.getState())!;
    setup.contents["a.md"] = "beta";
    setup.contents["b.md"] = "beta addition";
    await expect(setup.manager.synchronize(signal)).resolves.toEqual({
      changed: true,
      converged: true,
    });
    const after = (await setup.manager.getState())!;
    expect(after.incomplete).toBe(false);
    expect(after.changeCounter).toBeGreaterThan(before.changeCounter);
    expect((await setup.manager.search("beta", signal, 5)).map((result) => result.path)).toEqual(
      expect.arrayContaining(["a.md", "b.md"])
    );
  });

  it("reconciles rename and delete without embedding unchanged content", async () => {
    const contents: Record<string, string> = { "old.md": "alpha", "delete.md": "beta" };
    const setup = manager(contents);
    await setup.manager.build(signal);
    setup.model.embed.mockClear();
    delete contents["old.md"];
    contents["new.md"] = "alpha";
    delete contents["delete.md"];
    await expect(setup.manager.synchronize(signal)).resolves.toEqual({
      changed: true,
      converged: true,
    });
    expect(setup.model.embed).not.toHaveBeenCalled();
    expect((await setup.manager.search("alpha", signal, 5)).map((result) => result.path)).toEqual([
      "new.md",
    ]);
    await expect(setup.manager.search("beta", signal, 5)).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "delete.md" })])
    );
  });

  it("reconciles one changed path without reading unaffected notes", async () => {
    const contents = { "a.md": "alpha", "b.md": "beta" };
    const reads: string[] = [];
    const setup = manager(contents);
    const scoped = new IndexManager(
      {
        ...fixture(contents),
        readMarkdown: async (path: string, requestSignal: AbortSignal) => {
          reads.push(path);
          if (requestSignal.aborted) throw new StructuredError("cancelled", "cancelled", true);
          return fixture(contents).readMarkdown(path);
        },
      },
      setup.model,
      "http://127.0.0.1:1234/v1",
      "embed",
      { size: 100, overlap: 10, sqliteClient: createTestSqliteClient({}) }
    );
    await scoped.build(signal);
    reads.length = 0;
    contents["a.md"] = "alpha changed";

    await expect(
      scoped.reconcileChanges([{ type: "upsert", path: "a.md" }], signal)
    ).resolves.toEqual({
      changed: true,
      converged: true,
    });
    expect(reads).toEqual(["a.md"]);
    expect((await scoped.search("beta", signal, 5)).map((result) => result.path)).toContain("b.md");
  });

  it("keeps scoped reconciliation bounded to touched paths and RPCs", async () => {
    const contents = { "a.md": "alpha", "b.md": "beta" };
    const base = createTestSqliteClient({});
    const calls: { method: string; payload: any }[] = [];
    const client = new SqliteWorkerClient(undefined, async (method, payload, requestSignal) => {
      calls.push({ method, payload });
      return base.call(method, payload, requestSignal);
    });
    const index = new IndexManager(fixture(contents), embeddings(), "http://embedding", "m", {
      sqliteClient: client,
      size: 100,
      overlap: 10,
    });
    await index.build(signal);
    calls.length = 0;
    contents["a.md"] = "alpha changed";
    await expect(
      index.reconcileChanges([{ type: "upsert", path: "a.md" }], signal)
    ).resolves.toEqual({ changed: true, converged: true });
    expect(calls.map(({ method }) => method)).toEqual([
      "beginLexicalRun",
      "applyLexicalBatch",
      "finishLexicalRun",
    ]);
    expect(calls[0].payload).not.toHaveProperty("summaries");
    expect(calls[0].payload.scope).toMatchObject({
      renames: [],
      deletes: [],
      mayClearIncomplete: true,
    });
    expect(calls[1].payload.notes).toHaveLength(1);
  });

  it("keeps sequential scoped add, modify, delete, and rename complete", async () => {
    const contents: Record<string, string> = {
      "a.md": "alpha",
      "b.md": "beta",
      "c.md": "alpha gamma",
    };
    const setup = manager(contents);
    await setup.manager.build(signal);

    contents["added.md"] = "beta delta";
    setup.manager.recordPathMutation({ type: "upsert", path: "added.md" });
    await expect(setup.manager.reconcileQueuedChanges(signal)).resolves.toEqual({
      changed: true,
      converged: true,
    });

    contents["a.md"] = "alpha changed";
    setup.manager.recordPathMutation({ type: "upsert", path: "a.md" });
    await expect(setup.manager.reconcileQueuedChanges(signal)).resolves.toEqual({
      changed: true,
      converged: true,
    });
    await expect(setup.manager.prepareSemantic(signal)).resolves.toMatchObject({ converged: true });

    delete contents["b.md"];
    setup.manager.recordPathMutation({ type: "delete", path: "b.md" });
    await expect(setup.manager.reconcileQueuedChanges(signal)).resolves.toEqual({
      changed: true,
      converged: true,
    });

    contents["renamed.md"] = contents["c.md"];
    delete contents["c.md"];
    setup.manager.recordPathMutation({ type: "rename", from: "c.md", to: "renamed.md" });
    await expect(setup.manager.reconcileQueuedChanges(signal)).resolves.toEqual({
      changed: true,
      converged: true,
    });
    await expect(setup.manager.getState()).resolves.toMatchObject({
      incomplete: false,
      noteCount: 3,
    });
    await expect(setup.manager.search("gamma", signal, 5, "lexical")).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "renamed.md" })])
    );
  });

  it.each([1, 16, 17, 1100])(
    "does not add status reads while a full run grows to %s notes",
    async (noteCount) => {
      const contents = Object.fromEntries(
        Array.from({ length: noteCount }, (_, index) => [`note-${index}.md`, `word-${index}`])
      );
      const base = createTestSqliteClient({});
      const methods: string[] = [];
      const client = new SqliteWorkerClient(undefined, async (method, payload, requestSignal) => {
        methods.push(method);
        return base.call(method, payload, requestSignal);
      });
      const index = new IndexManager(fixture(contents), embeddings(), "http://embedding", "m", {
        sqliteClient: client,
        size: 100,
        overlap: 10,
      });
      await index.build(signal);
      expect(methods.filter((method) => method === "getState")).toHaveLength(0);
      expect(methods.filter((method) => method === "applyLexicalBatch")).toHaveLength(
        Math.ceil(noteCount / 16)
      );
    },
    30_000
  );

  it("applies upsert, delete, rename, and disappeared upsert mutations", async () => {
    const contents: Record<string, string> = { "old.md": "alpha" };
    const setup = manager(contents);
    await setup.manager.build(signal);
    contents["new.md"] = "alpha";
    delete contents["old.md"];
    expect(
      await setup.manager.reconcileChanges(
        [{ type: "rename", from: "old.md", to: "new.md" }],
        signal
      )
    ).toEqual({ changed: true, converged: true });
    expect((await setup.manager.search("alpha", signal, 5)).map((result) => result.path)).toEqual([
      "new.md",
    ]);

    contents["created.md"] = "beta";
    await setup.manager.reconcileChanges([{ type: "upsert", path: "created.md" }], signal);
    expect((await setup.manager.search("beta", signal, 5)).map((result) => result.path)).toContain(
      "created.md"
    );
    delete contents["created.md"];
    expect(
      await setup.manager.reconcileChanges([{ type: "delete", path: "created.md" }], signal)
    ).toEqual({
      changed: true,
      converged: true,
    });
    expect(
      await setup.manager.reconcileChanges([{ type: "delete", path: "created.md" }], signal)
    ).toEqual({
      changed: false,
      converged: true,
    });
    contents["vanished.md"] = "gamma";
    await setup.manager.reconcileChanges([{ type: "upsert", path: "vanished.md" }], signal);
    delete contents["vanished.md"];
    await setup.manager.reconcileChanges([{ type: "upsert", path: "vanished.md" }], signal);
    expect(
      (await setup.manager.search("beta", signal, 5)).map((result) => result.path)
    ).not.toContain("created.md");
  });

  it("handles rename transitions across index eligibility boundaries", async () => {
    const contents: Record<string, string> = { "folder/old.md": "alpha" };
    const setup = manager(contents);
    const index = new IndexManager(
      fixture(contents),
      setup.model,
      "http://127.0.0.1:1234/v1",
      "embed",
      {
        sqliteClient: createTestSqliteClient({}),
        isIndexEligible: (path) => !path.startsWith("private/"),
      }
    );
    await index.build(signal);
    contents["private/old.md"] = "alpha";
    delete contents["folder/old.md"];
    await index.reconcileChanges(
      [{ type: "rename", from: "folder/old.md", to: "private/old.md" }],
      signal
    );
    await expect(index.search("alpha", signal, 5)).rejects.toMatchObject({ code: "unavailable" });

    contents["private/old.md"] = "beta";
    contents["folder/new.md"] = "beta";
    await index.reconcileChanges(
      [{ type: "rename", from: "private/old.md", to: "folder/new.md" }],
      signal
    );
    expect((await index.search("beta", signal, 5)).map((result) => result.path)).toEqual([
      "folder/new.md",
    ]);
  });

  it("keeps queued work dirty when scoped finish races a vault event", async () => {
    const identity = {};
    const base = createTestSqliteClient(identity);
    let armed = false;
    const client = new SqliteWorkerClient(undefined, async (method, payload, requestSignal) => {
      const result = await base.call(method, payload, requestSignal);
      if (armed && method === "finishLexicalRun") target.queueChange();
      return result;
    });
    const target = new IndexManager(
      fixture({ "a.md": "alpha" }),
      embeddings(),
      "http://embedding",
      "m",
      {
        sqliteClient: client,
      }
    );
    await target.build(signal);
    armed = true;
    await expect(
      target.reconcileChanges([{ type: "upsert", path: "a.md" }], signal)
    ).resolves.toEqual({
      changed: false,
      converged: false,
    });
    expect((await target.getState())?.incomplete).toBe(true);
    expect(target.hasPendingWork()).toBe(true);
  });

  it("cleans a real scoped run when a path event arrives after begin", async () => {
    const identity = {};
    const base = createTestSqliteClient(identity);
    const contents = { "a.md": "alpha" };
    let injectEvent = false;
    const client = new SqliteWorkerClient(undefined, async (method, payload, requestSignal) => {
      const result = await base.call(method, payload, requestSignal);
      if (injectEvent && method === "beginLexicalRun") {
        injectEvent = false;
        target.recordPathMutation({ type: "upsert", path: "a.md" });
      }
      return result;
    });
    const target = new IndexManager(fixture(contents), embeddings(), "http://embedding", "m", {
      sqliteClient: client,
    });
    await target.build(signal);
    contents["a.md"] = "alpha changed";
    injectEvent = true;

    await expect(
      target.reconcileChanges([{ type: "upsert", path: "a.md" }], signal)
    ).resolves.toEqual({ changed: true, converged: false });
    expect(target.hasPendingWork()).toBe(true);
    await expect(target.reconcileQueuedChanges(signal)).resolves.toMatchObject({
      converged: true,
    });
  });

  it("keeps scoped failures incomplete, then lets full synchronization repair a missed path", async () => {
    const contents = { "a.md": "alpha", "b.md": "beta" };
    const setup = manager(contents);
    await setup.manager.build(signal);
    contents["a.md"] = "alpha updated";
    await expect(
      setup.manager.reconcileChanges([{ type: "upsert", path: "a.md" }], signal)
    ).resolves.toMatchObject({ converged: true });

    contents["b.md"] = "beta updated";
    await expect(setup.manager.synchronize(signal)).resolves.toMatchObject({ converged: true });
    expect((await setup.manager.search("updated", signal, 5)).map((result) => result.path)).toEqual(
      expect.arrayContaining(["a.md", "b.md"])
    );
  });

  it("leaves a failed scoped read incomplete", async () => {
    const base = fixture({ "a.md": "alpha" });
    let failRead = false;
    const index = new IndexManager(
      {
        ...base,
        readMarkdown: async () => {
          if (failRead) throw new Error("temporary read failure");
          return { path: "a.md", content: "alpha" };
        },
        isMarkdownAvailable: async () => true,
      },
      embeddings(),
      "http://embedding",
      "m",
      { sqliteClient: createTestSqliteClient({}) }
    );
    await index.build(signal);
    failRead = true;
    await expect(
      index.reconcileChanges([{ type: "upsert", path: "a.md" }], signal)
    ).rejects.toThrow("temporary read failure");
    expect((await index.getState())?.incomplete).toBe(true);
  });

  it("leaves a cancelled scoped read incomplete", async () => {
    const base = fixture({ "a.md": "alpha" });
    const abort = new AbortController();
    let cancelRead = false;
    const index = new IndexManager(
      {
        ...base,
        readMarkdown: async (path: string, requestSignal: AbortSignal) => {
          if (cancelRead) abort.abort();
          if (requestSignal.aborted) throw new StructuredError("cancelled", "cancelled", true);
          return { path, content: "alpha" };
        },
      },
      embeddings(),
      "http://embedding",
      "m",
      { sqliteClient: createTestSqliteClient({}) }
    );
    await index.build(signal);
    cancelRead = true;
    await expect(
      index.reconcileChanges([{ type: "upsert", path: "a.md" }], abort.signal)
    ).rejects.toMatchObject({
      code: "cancelled",
    });
    expect((await index.getState())?.incomplete).toBe(true);
  });

  it("cleans full and scoped lexical runs after cancellation with a fresh cleanup signal", async () => {
    const identity = {};
    const base = createTestSqliteClient(identity);
    const cleanupSignals: boolean[] = [];
    const runIds: string[] = [];
    let cancelNextApply = true;
    const client = new SqliteWorkerClient(undefined, async (method, payload, requestSignal) => {
      if (method === "beginLexicalRun") {
        const result = await base.call(method, payload, requestSignal);
        runIds.push(result.runId);
        return result;
      }
      if (method === "applyLexicalBatch" && cancelNextApply) {
        cancelNextApply = false;
        const result = await base.call(method, payload, new AbortController().signal);
        expect(result.changed).toBe(true);
        throw sqliteError("cancelled", "cancelled", true);
      }
      if (method === "abortLexicalRun") {
        cleanupSignals.push(Boolean(requestSignal?.aborted));
        return base.call(method, payload, requestSignal);
      }
      return base.call(method, payload, requestSignal);
    });
    const contents = { "a.md": "alpha" };
    const index = new IndexManager(fixture(contents), embeddings(), "http://embedding", "m", {
      sqliteClient: client,
    });
    const fullAbort = new AbortController();
    await expect(index.build(fullAbort.signal)).rejects.toMatchObject({
      error: { code: "cancelled" },
    });
    expect(cleanupSignals).toEqual([false]);
    await expect(base.call("finishLexicalRun", { runId: runIds[0] })).rejects.toMatchObject({
      error: { code: "invalid_request" },
    });
    await expect(base.call("getState", {})).resolves.toMatchObject({
      noteCount: 1,
      incomplete: true,
    });

    contents["a.md"] = "alpha changed";
    cancelNextApply = true;
    const scopedAbort = new AbortController();
    await expect(
      index.reconcileChanges([{ type: "upsert", path: "a.md" }], scopedAbort.signal)
    ).rejects.toMatchObject({ error: { code: "cancelled" } });
    expect(cleanupSignals).toEqual([false, false]);
    await expect(base.call("finishLexicalRun", { runId: runIds[1] })).rejects.toMatchObject({
      error: { code: "invalid_request" },
    });
    await expect(base.call("getState", {})).resolves.toMatchObject({ incomplete: true });
  });

  it("leaves a cancelled rebuild explicitly incomplete and searchable", async () => {
    const setup = manager({ "a.md": "alpha", "b.md": "beta" });
    const abort = new AbortController();
    const cancelling = new IndexManager(
      {
        ...fixture({ "a.md": "alpha", "b.md": "beta" }),
        readMarkdown: async (path: string, requestSignal: AbortSignal) => {
          if (path === "a.md") abort.abort();
          if (requestSignal.aborted) throw new StructuredError("cancelled", "cancelled", true);
          return { path, content: path === "a.md" ? "alpha" : "beta" };
        },
      },
      setup.model,
      "http://127.0.0.1:1234/v1",
      "embed",
      { sqliteClient: createTestSqliteClient({}) }
    );
    await expect(cancelling.build(abort.signal)).rejects.toMatchObject({ code: "cancelled" });
    await expect(cancelling.getState()).resolves.toMatchObject({ incomplete: true });
  });

  it("preserves the semantic-only related-note path", async () => {
    const setup = manager({ "a.md": "alpha", "b.md": "beta" });
    await setup.manager.build(signal);
    await setup.manager.prepareSemantic(signal);
    const embeddingCalls = setup.model.embed.mock.calls.length;
    expect(setup.manager.relatedState("a.md")).toMatchObject({
      semantic: { state: "ready", searchable: true },
      freshness: "locally-reconciled",
    });
    await setup.manager.findRelated("a.md", signal, 128);
    expect(setup.model.embed.mock.calls.length).toBe(embeddingCalls);
  });

  it("keeps fingerprint and chunking contracts deterministic", () => {
    expect({ size: CHUNK_SIZE, overlap: CHUNK_OVERLAP }).toEqual({ size: 384, overlap: 64 });
    expect(createIndexFingerprint(" HTTP://127.0.0.1:1234/v1/ ", "m", 2)).toEqual(
      createIndexFingerprint("http://127.0.0.1:1234/v1", "m", 2)
    );
    expect(chunkMarkdown("one\ntwo\nthree", 7, 2)).toEqual(chunkMarkdown("one\ntwo\nthree", 7, 2));
  });

  it("persists snapshot freshness through adoption and restart boundaries", async () => {
    const sourceIdentity = {};
    const source = manager({ "a.md": "alpha" }, sourceIdentity);
    await source.manager.build(signal);
    const { prepared } = await source.manager.publishPublication(
      "remote-publication",
      async () => undefined
    );

    const receiverIdentity = {};
    const receiver = manager({ "a.md": "alpha" }, receiverIdentity);
    await receiver.manager.load();
    await receiver.manager.adoptPublication(prepared.bytes, "remote-publication");
    expect((await receiver.manager.getState())?.snapshotLoaded).toBe(true);
    expect(receiver.manager.capabilities().freshness).toBe("snapshot-loaded");

    const adoptedRestart = manager({ "a.md": "alpha" }, receiverIdentity);
    await adoptedRestart.manager.load();
    expect((await adoptedRestart.manager.getState())?.snapshotLoaded).toBe(true);
    expect(adoptedRestart.manager.capabilities().freshness).toBe("snapshot-loaded");

    await expect(adoptedRestart.manager.synchronize(signal)).resolves.toEqual({
      changed: false,
      converged: true,
    });
    expect((await adoptedRestart.manager.getState())?.snapshotLoaded).toBe(false);
    expect(adoptedRestart.manager.capabilities().freshness).toBe("locally-reconciled");

    const afterNoOpRestart = manager({ "a.md": "alpha" }, receiverIdentity);
    await afterNoOpRestart.manager.load();
    expect((await afterNoOpRestart.manager.getState())?.snapshotLoaded).toBe(false);
    expect(afterNoOpRestart.manager.capabilities().freshness).toBe("locally-reconciled");

    const { prepared: localPrepared } = await afterNoOpRestart.manager.publishPublication(
      "local-publication",
      async () => undefined
    );
    expect((await afterNoOpRestart.manager.getState())?.snapshotLoaded).toBe(false);
    expect(localPrepared.state.snapshotLoaded).toBe(false);

    const reconciledRestart = manager({ "a.md": "alpha" }, receiverIdentity);
    await reconciledRestart.manager.load();
    expect((await reconciledRestart.manager.getState())?.snapshotLoaded).toBe(false);
    expect(reconciledRestart.manager.capabilities().freshness).toBe("locally-reconciled");
  });

  it("blocks local writes and adoption until publication installs and stamps the same ID", async () => {
    const setup = manager({ "a.md": "alpha" });
    await setup.manager.build(signal);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const installing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const publishing = setup.manager.publishPublication("locked-publication", async (prepared) => {
      entered();
      await gate;
      return prepared.bytes;
    });
    await installing;
    expect(setup.manager.isInMaintenance()).toBe(true);
    const updating = setup.manager.synchronize(signal);
    let updateFinished = false;
    void updating.then(() => {
      updateFinished = true;
    });
    await Promise.resolve();
    expect(updateFinished).toBe(false);
    await expect(setup.manager.adoptPublication(new ArrayBuffer(1))).rejects.toMatchObject({
      code: "busy",
    });
    release();
    const result = await publishing;
    await expect(updating).resolves.toMatchObject({ converged: true });
    expect(result.prepared.publicationId).toBe("locked-publication");
    expect((await setup.manager.getState())?.publicationId).toBe("locked-publication");
    expect(setup.manager.isInMaintenance()).toBe(false);
  });

  it("projects hostile diagnostics to safe metadata", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("getter escaped");
        },
        has() {
          throw new Error("has escaped");
        },
      }
    );
    expect(projectDiagnosticError(hostile)).toEqual({ name: "Error" });
  });

  it("reports progress with monotonic counters", async () => {
    const progress: IndexProgress[] = [];
    const setup = new IndexManager(
      fixture({ "a.md": "alpha" }),
      embeddings(),
      "http://127.0.0.1:1234/v1",
      "embed",
      { onProgress: (value) => progress.push(value), sqliteClient: createTestSqliteClient({}) }
    );
    await setup.build(signal);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((entry) => entry.completed >= 0)).toBe(true);
  });

  it("keeps full-build progress lexical-only after chunking", async () => {
    const model = embeddings();
    const target: { value?: IndexManager } = {};
    const status = new IndexStatusController({} as any, {
      index: async () => undefined,
      reindex: (requestSignal) => target.value!.build(requestSignal),
      cancel: () => undefined,
    });
    const observed: string[] = [];
    status.subscribe((value) => {
      if (value.progress) observed.push(`${value.progress.phase}:${value.progress.completed}`);
    });
    target.value = new IndexManager(
      fixture({ "a.md": "alpha" }),
      model,
      "http://127.0.0.1:1234/v1",
      "embed",
      {
        onProgress: (progress) => status.reportProgress(progress),
        sqliteClient: createTestSqliteClient({}),
      }
    );

    status.setReady();
    await status.run("reindex");

    const chunkIndex = observed.findIndex((entry) => entry.startsWith("chunk:"));
    expect(chunkIndex).toBeGreaterThanOrEqual(0);
    expect(observed.findIndex((entry) => entry.startsWith("embed:"))).toBe(-1);
    expect(model.embed).not.toHaveBeenCalled();
  });

  it("keeps incremental synchronization embedding-free", async () => {
    const contents = { "a.md": "alpha", "b.md": "beta" };
    const progress: IndexProgress[] = [];
    const model = {
      dimensions: 2,
      embed: vi.fn(
        async (
          texts: readonly string[],
          _signal: AbortSignal,
          onProgress?: (value: { completed: number; total: number; unit: "texts" }) => void
        ) => {
          onProgress?.({ completed: texts.length, total: texts.length, unit: "texts" });
          return texts.map(() => [1, 0]);
        }
      ),
    };
    const index = new IndexManager(fixture(contents), model, "http://127.0.0.1:1234/v1", "embed", {
      size: 64,
      overlap: 0,
      onProgress: (value) => progress.push(value),
      sqliteClient: createTestSqliteClient({}),
    });
    await index.build(signal);
    progress.length = 0;
    contents["a.md"] = "alpha ".repeat(12);
    contents["b.md"] = "beta ".repeat(12);

    await index.synchronize(signal);

    expect(
      progress.some((value) => value.operation === "incremental" && value.phase === "embed")
    ).toBe(false);
    expect(model.embed).not.toHaveBeenCalled();
  });

  it("preserves the usable index when full-build planning fails", async () => {
    const contents = { "a.md": "alpha" };
    const vault = fixture(contents);
    const setup = new IndexManager(vault, embeddings(), "http://127.0.0.1:1234/v1", "embed", {
      sqliteClient: createTestSqliteClient({}),
    });
    await setup.build(signal);
    const priorState = await setup.getState();
    vault.listMarkdownPaths = async () => {
      throw new Error("planning failed");
    };

    await expect(setup.build(signal)).rejects.toThrow("planning failed");
    await expect(setup.getState()).resolves.toEqual(priorState);
    await expect(setup.search("alpha", signal, 1)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "a.md" })])
    );
  });

  it("retains the public structured error contract", () => {
    expect(new StructuredError("busy", "busy", true)).toMatchObject({
      code: "busy",
      retryable: true,
    });
  });

  it("retries when an event arrives during final reconciliation", async () => {
    const contents = { "a.md": "alpha" };
    const setup = racedManager(contents);
    await setup.manager.build(signal);
    contents["a.md"] = "beta";
    setup.arm();
    await expect(setup.manager.synchronize(signal)).resolves.toEqual({
      changed: true,
      converged: true,
    });
    expect(setup.fired).toBe(1);
    await expect(setup.manager.getState()).resolves.toMatchObject({ incomplete: false });
  });

  it("reconciles real vault content discovered after an earlier pass changed the index", async () => {
    const contents: Record<string, string> = { "a.md": "alpha" };
    const identity = {};
    const base = createTestSqliteClient(identity);
    let armed = false;
    let raced = false;
    const client = new SqliteWorkerClient(undefined, async (method, payload, requestSignal) => {
      const result = await base.call(method, payload, requestSignal);
      if (armed && !raced && method === "finishLexicalRun") {
        raced = true;
        contents["b.md"] = "gamma appeared during synchronization";
        index.queueChange();
      }
      return result;
    });
    const index = new IndexManager(
      fixture(contents),
      embeddings(),
      "HTTP://127.0.0.1:1234/v1/",
      "embed",
      { size: 100, overlap: 10, sqliteClient: client }
    );
    await index.build(signal);

    contents["a.md"] = "beta changed before synchronization";
    armed = true;
    await expect(index.synchronize(signal)).resolves.toEqual({ changed: true, converged: true });

    expect(raced).toBe(true);
    await expect(index.search("beta", signal, 5)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "a.md" })])
    );
    await expect(index.search("gamma", signal, 5)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "b.md" })])
    );
  });

  it("stops incomplete when every finish RPC races a vault event", async () => {
    const contents = { "a.md": "alpha" };
    const setup = racedManager(contents, true);
    await setup.manager.build(signal);
    contents["a.md"] = "beta";
    setup.arm();
    await expect(setup.manager.synchronize(signal)).resolves.toEqual({
      changed: true,
      converged: false,
    });
    expect(setup.fired).toBe(8);
    // If the process stops here, the durable SQLite state is still safely incomplete.
    await expect(setup.manager.getState()).resolves.toMatchObject({ incomplete: true });
  });
});
