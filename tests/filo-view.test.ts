import { describe, expect, it, vi } from "vitest";
import { WorkspaceLeaf } from "obsidian";
import { FiloView } from "@/ui/filo/FiloView";
import { IndexStatusController } from "@/ui/index/IndexStatus";

describe("Filo semantic index display", () => {
  it.each(["lexical", "semantic", "publication", "adopt", "reset"])(
    "defers related lookups during %s and ignores the interrupted request's failure",
    async (phase) => {
      const status = new IndexStatusController({} as any, {
        update: async () => undefined,
        rebuild: async () => undefined,
        reset: async () => undefined,
        stop: () => undefined,
      });
      const capabilities = {
        availability: "available" as const,
        lexical: { state: "ready" as const, activity: "idle" as const, searchable: true },
        semantic: { state: "ready" as const, activity: "idle" as const, searchable: true },
        freshness: "locally-reconciled" as const,
      };
      status.setReady();
      status.setCapabilities(capabilities);
      const labels: string[] = [];
      const root = {
        empty: () => labels.splice(0),
        createEl: (_tag: string, options: { text?: string }) => {
          labels.push(options.text ?? "");
          return { addEventListener: () => undefined };
        },
        createDiv: (options: { text?: string }) => {
          labels.push(options.text ?? "");
          return root;
        },
      };
      let reject!: (error: Error) => void;
      let activeSignal!: AbortSignal;
      const find = vi.fn(async (_path: string, _signal: AbortSignal) => ({
        currentPath: "one.md",
        contentHash: "current",
        results: [],
      }));
      find.mockImplementationOnce((_path, signal) => {
        activeSignal = signal;
        return new Promise((_resolve, fail) => {
          reject = fail;
        });
      });
      const view = new FiloView(
        new WorkspaceLeaf(),
        status,
        { find },
        async () => undefined,
        () => undefined
      );
      (view as any).root = root;
      (view as any).app = { workspace: { getActiveFile: () => ({ path: "one.md" }) } };
      const unsubscribe = status.subscribe((current) => {
        (view as any).status = current;
        (view as any).refreshRelated();
      });
      expect(find).toHaveBeenCalledOnce();
      status.setMaintenance({
        lane: phase === "adopt" ? "adoption" : "update",
        phase,
        pending: false,
        suspended: false,
      });
      expect(activeSignal.aborted).toBe(true);
      status.setCapabilities(capabilities);
      expect(find).toHaveBeenCalledOnce();
      reject(new Error("interrupted lookup"));
      await Promise.resolve();
      await Promise.resolve();
      expect(labels).not.toContain("Related notes could not be loaded.");
      status.setMaintenance({ lane: "idle", pending: false, suspended: false }, capabilities);
      await vi.waitFor(() => expect(find).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(labels).toContain("No related notes found."));
      expect(labels).not.toContain("Related notes could not be loaded.");
      unsubscribe();
    }
  );

  it("asks for a local semantic profile before incompatible-vector updates", () => {
    const status = new IndexStatusController({} as any, {
      update: async () => undefined,
      rebuild: async () => undefined,
      reset: async () => undefined,
      stop: () => undefined,
    });
    status.setReady();
    status.setCapabilities({
      availability: "available",
      lexical: { state: "ready", activity: "idle", searchable: true },
      semantic: { state: "incompatible", activity: "idle", searchable: false },
      freshness: "locally-reconciled",
    });
    const labels: string[] = [];
    const root = {
      empty: () => labels.splice(0),
      createEl: (_tag: string, options: { text?: string }) => {
        labels.push(options.text ?? "");
        return { addEventListener: () => undefined };
      },
      createDiv: (options: { text?: string }) => labels.push(options.text ?? ""),
    };
    let configured = false;
    const find = vi.fn();
    const view = new FiloView(
      new WorkspaceLeaf(),
      status,
      { find },
      async () => undefined,
      () => undefined,
      () => configured
    );
    (view as any).root = root;
    (view as any).activePath = "one.md";
    (view as any).status = status.getStatus();
    (view as any).render();
    expect(labels).toContain(
      "No compatible semantic vectors are available locally. Select a local profile or connect its provider, then update the index."
    );
    expect(labels).not.toContain("Update index");
    expect(labels.some((label) => label.includes("incompatible"))).toBe(false);
    (view as any).app = { workspace: { getActiveFile: () => ({ path: "one.md" }) } };
    (view as any).refreshRelated();
    expect(find).not.toHaveBeenCalled();

    configured = true;
    (view as any).render();
    expect(labels).toContain(
      "Stored semantic vectors are incompatible. Update the index to refresh them."
    );
    expect(labels).toContain("Update index");
  });
  it("shows semantic progress and Stop even when a rebuild has cleared the vectors", async () => {
    const status = new IndexStatusController({} as any, {
      update: async () => undefined,
      rebuild: async () => undefined,
      reset: async () => undefined,
      stop: () => undefined,
    });
    status.setReady();
    status.setMaintenance({ lane: "update", phase: "semantic", pending: false, suspended: false });
    status.reportProgress({
      operation: "incremental",
      phase: "build-vector",
      completed: 64,
      total: 1000,
      unit: "chunks",
      determinate: true,
    });

    const rendered: { tag: string; text: string }[] = [];
    const root = {
      empty: () => rendered.splice(0),
      createEl: (tag: string, options: { text?: string }) => {
        rendered.push({ tag, text: options.text ?? "" });
        return { addEventListener: () => undefined };
      },
      createDiv: (options: { text?: string }) => {
        rendered.push({ tag: "div", text: options.text ?? "" });
      },
    };
    const view = new FiloView(
      new WorkspaceLeaf(),
      status,
      undefined,
      async () => undefined,
      () => undefined,
      () => false
    );
    (view as any).root = root;
    (view as any).activePath = "one.md";
    (view as any).status = status.getStatus();
    (view as any).render();

    expect(rendered).toContainEqual({
      tag: "p",
      text: "Updating semantic index — 64 of 1000 chunks",
    });
    expect(rendered).toContainEqual({ tag: "progress", text: "" });
    expect(rendered).toContainEqual({ tag: "button", text: "Stop" });
    expect(rendered.some((item) => item.text.includes("No compatible semantic vectors"))).toBe(
      false
    );
    expect(rendered.some((item) => item.text === "Update semantic index")).toBe(false);
  });

  it("offers Update after a semantic failure", async () => {
    const status = new IndexStatusController({} as any, {
      update: async () => undefined,
      rebuild: async () => undefined,
      reset: async () => undefined,
      stop: () => undefined,
    });
    status.setReady();
    status.setMaintenance({ lane: "update", phase: "semantic", pending: false, suspended: false });
    status.markStale(true);
    status.markError(new Error("provider unavailable"));

    const labels: string[] = [];
    const root = {
      empty: () => labels.splice(0),
      createEl: (_tag: string, options: { text?: string }) => {
        labels.push(options.text ?? "");
        return { addEventListener: () => undefined };
      },
      createDiv: (options: { text?: string }) => labels.push(options.text ?? ""),
    };
    const view = new FiloView(
      new WorkspaceLeaf(),
      status,
      undefined,
      async () => undefined,
      () => undefined
    );
    (view as any).root = root;
    (view as any).activePath = "one.md";
    (view as any).status = status.getStatus();
    (view as any).render();

    expect(labels).toContain("Update index");
    expect(labels).not.toContain("Update semantic index");
  });

  it("shows the unavailable prompt for nonsearchable partial coverage", () => {
    const status = new IndexStatusController({} as any, {
      update: async () => undefined,
      rebuild: async () => undefined,
      reset: async () => undefined,
      stop: () => undefined,
    });
    status.setReady();
    status.setCapabilities({
      availability: "available",
      lexical: { state: "ready", activity: "idle", searchable: true },
      semantic: { state: "partial", activity: "idle", searchable: false },
      freshness: "locally-reconciled",
    });

    const labels: string[] = [];
    const root = {
      empty: () => labels.splice(0),
      createEl: (_tag: string, options: { text?: string }) => {
        const label = options.text ?? "";
        labels.push(label);
        return {
          addEventListener: () => undefined,
        };
      },
      createDiv: (options: { text?: string }) => {
        labels.push(options.text ?? "");
        return root;
      },
    };
    const view = new FiloView(
      new WorkspaceLeaf(),
      status,
      undefined,
      async () => undefined,
      () => undefined
    );
    (view as any).root = root;
    (view as any).activePath = "one.md";
    (view as any).status = status.getStatus();
    (view as any).render();

    expect(labels).toContain(
      "Semantic index is incomplete. Update the index to discover related notes."
    );
    expect(labels).not.toContain("Finding related notes…");
  });

  it("keeps indexed related notes visible alongside stale-index actions", () => {
    const status = new IndexStatusController({} as any, {
      update: async () => undefined,
      rebuild: async () => undefined,
      reset: async () => undefined,
      stop: () => undefined,
    });
    status.setReady();
    status.markStale(true);

    const labels: string[] = [];
    const root = {
      empty: () => labels.splice(0),
      createEl: (_tag: string, options: { text?: string }) => {
        labels.push(options.text ?? "");
        return { addEventListener: () => undefined };
      },
      createDiv: (options: { text?: string }) => {
        labels.push(options.text ?? "");
        return root;
      },
    };
    const view = new FiloView(
      new WorkspaceLeaf(),
      status,
      undefined,
      async () => undefined,
      () => undefined
    );
    (view as any).root = root;
    (view as any).activePath = "one.md";
    (view as any).status = status.getStatus();
    (view as any).related = { results: [] };
    (view as any).render();

    expect(labels).toContain("No related notes found.");
    expect(labels).toContain("Index has changes; update required.");
    expect(labels).toContain("Update index");
    expect(labels).toContain("Rebuild index");
  });
});
