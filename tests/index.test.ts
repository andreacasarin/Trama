import { describe, expect, it, vi } from "vitest";
import { StructuredError, type IndexProgress } from "@/domain/contracts";
import { projectDiagnosticError, type TramaDiagnosticRecord } from "@/diagnostics/TramaDiagnostics";
import { CHUNK_OVERLAP, CHUNK_SIZE, chunkMarkdown } from "@/index/chunking";
import { IndexManager, createIndexFingerprint } from "@/index/IndexManager";
import { LenteSearch } from "@/index/LenteSearch";
import { SqliteWorkerClient } from "@/index/sqlite/client";
import { createTestSqliteClient } from "./sqlite-test-client";
import { IndexStatusController } from "@/ui/index/IndexStatus";

const signal = new AbortController().signal;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
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
    if (armed && method === "finishReconciliation" && (repeat || fired === 0)) {
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
    expect(methods).toContain("hashMarkdown");
    expect(methods).toContain("upsertMarkdown");
    expect(methods).not.toContain("upsertNote");
    methods.length = 0;
    contents["note.md"] = "beta\nsecond";
    await index.synchronize(signal);
    expect(methods).toContain("hashMarkdown");
    expect(methods).toContain("upsertMarkdown");
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
      semantic: { state: "empty", searchable: false },
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
    expect(vectors.at(-1)).toMatchObject({ completed: 2, total: 2, determinate: true });
    expect(vectors.every((value) => value.total === 2)).toBe(true);
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
      completed: 2,
      total: 2,
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

    const chunkIndex = observed.indexOf("chunk:0");
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
      size: 20,
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
