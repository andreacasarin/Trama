import { describe, expect, it } from "vitest";
import { TalaCheckpointStore } from "@/index/taladb/checkpoint";
import { createTalaNamespace } from "@/index/taladb/namespace";

describe("TalaCheckpointStore", () => {
  it("preserves the adapter receiver and uses only the Tala namespace", async () => {
    const files = new Map<string, string>();
    const adapter = {
      prefix: ".trama/index/taladb-v1/test/",
      async read(path: string) {
        if (!path.startsWith(this.prefix)) throw new Error("receiver lost");
        return files.get(path) ?? null;
      },
      async write(path: string, value: string) {
        if (!path.startsWith(this.prefix)) throw new Error("receiver lost");
        files.set(path, value);
      },
    };
    const store = new TalaCheckpointStore(adapter, createTalaNamespace("test"));
    const checkpoint = {
      version: 1 as const,
      namespace: createTalaNamespace("test").root,
      state: {
        status: "ready" as const,
        syncNeeded: false,
        operation: "idle" as const,
        revision: 1,
        fingerprint: "fp",
        dimensions: 2,
      },
      notes: [],
    };
    await store.export(checkpoint);
    expect((await store.import())?.state.revision).toBe(1);
    expect([...files.keys()]).toEqual([createTalaNamespace("test").checkpoint]);
  });
});
