import { IndexManager } from "../../src/index/IndexManager.ts";
import { createTalaNamespace } from "../../src/index/taladb/namespace.ts";

class Storage {
  root = ".trama/index";
  files = new Map();
  async read(path) {
    return this.files.get(path) ?? null;
  }
  async write(path, value) {
    this.files.set(path, value);
  }
  async remove(path) {
    this.files.delete(path);
  }
  async activate(path, value) {
    this.files.set(path, value);
  }
}

function vault(contents) {
  return {
    async listMarkdownPaths() {
      return [...contents.keys()];
    },
    async readMarkdown(path) {
      return { path, content: contents.get(path) };
    },
    async isMarkdownAvailable(path) {
      return contents.has(path);
    },
  };
}

function model(delay = 0) {
  const calls = { count: 0 };
  return {
    dimensions: 8,
    calls,
    async embed(texts, signal) {
      calls.count += texts.length;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (signal?.aborted) throw new Error("embedding cancelled");
      return texts.map((text) => {
        const vector = new Array(8).fill(0);
        vector[text.includes("alpha") ? 0 : 1] = 1;
        return vector;
      });
    },
  };
}

function makeManager(contents, storage, id, embedding = model()) {
  return {
    embedding,
    manager: new IndexManager(
      vault(contents),
      embedding,
      storage,
      "http://127.0.0.1:1234/v1",
      "native-lifecycle-v1",
      { namespace: createTalaNamespace(id), backend: "native" }
    ),
  };
}

async function waitUntil(predicate, timeout = 3_000) {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeout) throw new Error("timed out waiting for dirty state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function run() {
  const storage = new Storage();
  const firstContents = new Map([
    ["alpha.md", "alpha durable"],
    ["shared.md", "alpha shared"],
  ]);
  const first = makeManager(firstContents, storage, "native-lifecycle-a");
  await first.manager.build(new AbortController().signal);
  const dbName = first.manager["engine"].namespace.database;
  const safeDatabaseName = !/[\\/:]/.test(dbName) && dbName.length > 0;
  const firstSearch = await first.manager.search("alpha", new AbortController().signal, 10);

  const secondContents = new Map([["beta.md", "beta isolated"]]);
  const second = makeManager(secondContents, storage, "native-lifecycle-b");
  await second.manager.build(new AbortController().signal);
  const secondSearch = await second.manager.search("beta", new AbortController().signal, 10);
  const crossSearch = await second.manager.search("alpha", new AbortController().signal, 10);
  const namespaceIsolation =
    secondSearch.some((hit) => hit.path === "beta.md") &&
    !crossSearch.some((hit) => hit.path === "alpha.md");
  await second.manager.close();

  firstContents.set("alpha.md", "alpha modified");
  const pending = makeManager(firstContents, storage, "native-lifecycle-a", model(150));
  const loaded = await pending.manager.load();
  pending.manager.queueChange("alpha.md");
  const reconciliation = pending.manager.reconcileQueuedChanges(new AbortController().signal);
  await waitUntil(() => pending.manager.state()?.status === "dirty");
  const partialSearch = await pending.manager.search("alpha", new AbortController().signal, 10);
  const dirtyPartialSearch =
    partialSearch.some((hit) => hit.path === "alpha.md") ||
    pending.manager.relatedSnapshot("alpha.md") !== null;
  await reconciliation;
  const converged =
    pending.manager.state()?.status === "ready" &&
    (await pending.manager.search("modified", new AbortController().signal, 10)).some(
      (hit) => hit.path === "alpha.md"
    );
  await pending.manager.close();

  const restarted = makeManager(firstContents, storage, "native-lifecycle-a", model());
  const restartedLoaded = await restarted.manager.load();
  const persisted =
    restartedLoaded &&
    (await restarted.manager.search("modified", new AbortController().signal, 10)).some(
      (hit) => hit.path === "alpha.md"
    );
  await restarted.manager.close();
  return {
    safeDatabaseName,
    namespaceIsolation,
    firstSearch: firstSearch.some((hit) => hit.path === "alpha.md"),
    loaded,
    dirtyPartialSearch,
    converged,
    persisted,
    storage: pending.manager["engine"]?.storageInfo?.().storage ?? "unsupported",
  };
}

window.__taladbNativeLifecycle = { run };
