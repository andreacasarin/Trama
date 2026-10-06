import { describe, expect, it, vi } from "vitest";
import { WorkspaceLeaf } from "obsidian";
import { FiloView } from "@/ui/filo/FiloView";
import { IndexStatusController } from "@/ui/index/IndexStatus";
import type { RelatedNotesResult } from "@/index/RelatedNotes";

describe("Filo semantic index display", () => {
  it("awaits refreshed results before sharing and avoids another lookup after sharing", async () => {
    const f = retainedResultsFixture();
    (f.view as any).isViewOpen = true;
    try {
      await vi.waitFor(() => expect(f.labels).toContain("Previous result"));
      f.status.setMaintenance({
        lane: "update",
        phase: "semantic",
        pending: false,
        suspended: false,
      });
      f.key = "updated";
      f.status.setMaintenance({
        lane: "update",
        phase: "results",
        pending: false,
        suspended: false,
      });
      let finished = false;
      const refresh = f.view.refreshRelatedSuggestions().then(() => {
        finished = true;
      });
      await Promise.resolve();
      expect(finished).toBe(false);
      expect(f.find).toHaveBeenCalledTimes(2);
      f.resolve({
        currentPath: "one.md",
        contentHash: "updated",
        results: [{ path: "Updated result.md", score: 0.9 }],
      });
      await refresh;
      expect(f.labels).toContain("Updated result");
      f.status.setMaintenance({
        lane: "update",
        phase: "publication",
        pending: false,
        suspended: false,
      });
      expect(f.labels).toContain("Updated result");
      f.status.setMaintenance({ lane: "idle", pending: false, suspended: false });
      expect(f.find).toHaveBeenCalledTimes(2);
    } finally {
      f.unsubscribe();
      await f.view.onClose();
    }
  });

  it.each(["lexical", "semantic", "publication", "adopt"])(
    "keeps previous results above %s status until refreshed results arrive",
    async (phase) => {
      const fixture = retainedResultsFixture();
      const { status, labels, find, view, unsubscribe } = fixture;
      try {
        await vi.waitFor(() => expect(labels).toContain("Previous result"));
        status.markStale(true);
        expect(labels).toContain("Previous result");
        status.setMaintenance({
          lane: phase === "adopt" ? "adoption" : "update",
          phase,
          pending: false,
          suspended: false,
        });
        const message = status.getStatus().message!;
        expect(labels.indexOf("Previous result")).toBeLessThan(labels.indexOf(message));
        expect(find).toHaveBeenCalledOnce();
        fixture.key = "updated";
        status.setMaintenance({ lane: "idle", pending: false, suspended: false });
        expect(find).toHaveBeenCalledTimes(2);
        expect(labels).toContain("Previous result");
        expect(labels).toContain("Updating related notes…");
        fixture.resolve({
          currentPath: "one.md",
          contentHash: "updated",
          results: [{ path: "Updated result.md", score: 0.9 }],
        });
        await vi.waitFor(() => expect(labels).toContain("Updated result"));
        expect(labels).not.toContain("Previous result");
        expect(labels).not.toContain("Updating related notes…");
      } finally {
        unsubscribe();
        await view.onClose();
      }
    }
  );

  it("clears retained results on note changes and ignores the previous note's late refresh", async () => {
    const fixture = retainedResultsFixture();
    try {
      await vi.waitFor(() => expect(fixture.labels).toContain("Previous result"));
      fixture.key = "updated";
      fixture.status.setReady();
      const oldSignal = fixture.find.mock.calls[1][1];
      fixture.path = "two.md";
      fixture.status.setMaintenance({
        lane: "update",
        phase: "semantic",
        pending: false,
        suspended: false,
      });
      expect(oldSignal.aborted).toBe(true);
      expect(fixture.labels).not.toContain("Previous result");
      fixture.resolve({
        currentPath: "one.md",
        contentHash: "late",
        results: [{ path: "Late result.md", score: 1 }],
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(fixture.labels).not.toContain("Late result");
    } finally {
      fixture.unsubscribe();
      await fixture.view.onClose();
    }
  });

  it("keeps previous results and reports a failed refresh underneath", async () => {
    const fixture = retainedResultsFixture();
    try {
      await vi.waitFor(() => expect(fixture.labels).toContain("Previous result"));
      fixture.key = "updated";
      fixture.status.setReady();
      fixture.reject(new Error("read failed"));
      const message = "Related notes could not be refreshed. Showing previous results.";
      await vi.waitFor(() => expect(fixture.labels).toContain(message));
      expect(fixture.labels.indexOf("Previous result")).toBeLessThan(
        fixture.labels.indexOf(message)
      );
    } finally {
      fixture.unsubscribe();
      await fixture.view.onClose();
    }
  });

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

  it.each(["ready", "stale", "error", "cancelled", "empty"])(
    "keeps the model-change rebuild warning visible when %s",
    (kind) => {
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
        semantic: {
          state: "incompatible",
          activity: "idle",
          searchable: false,
          rebuildRequired: true,
        },
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
      const view = new FiloView(
        new WorkspaceLeaf(),
        status,
        { find: vi.fn() },
        async () => undefined,
        () => undefined
      );
      (view as any).root = root;
      (view as any).activePath = "one.md";
      (view as any).status = { ...status.getStatus(), kind, canReindex: true };
      (view as any).render();
      expect(labels).toContain(
        "Embedding model changed. Rebuild the semantic index. Lexical search remains available."
      );
      expect(labels).toContain("Rebuild embeddings");
      expect(labels).not.toContain("Update search indexes");
    }
  );

  it("asks for the vault embedding model before incompatible-vector updates", () => {
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
      "No compatible semantic vectors are available locally. Configure the vault’s embedding model, then update the index."
    );
    expect(labels).not.toContain("Update search indexes");
    expect(labels.some((label) => label.includes("incompatible"))).toBe(false);
    (view as any).app = { workspace: { getActiveFile: () => ({ path: "one.md" }) } };
    (view as any).refreshRelated();
    expect(find).not.toHaveBeenCalled();

    configured = true;
    (view as any).render();
    expect(labels).toContain(
      "Stored semantic vectors are incompatible. Update the index to refresh them."
    );
    expect(labels).toContain("Update search indexes");
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
      text: "Updating embeddings — 64 of 1000 chunks",
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

    expect(labels).toContain("Update search indexes");
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
    expect(labels).toContain("Update search indexes");
    expect(labels).toContain("Rebuild embeddings");
  });
});

function retainedResultsFixture() {
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
    semantic: { state: "ready", activity: "idle", searchable: true },
    freshness: "locally-reconciled",
  });
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
    createSpan: (options: { text?: string }) => labels.push(options.text ?? ""),
  };
  let resolve!: (result: RelatedNotesResult) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<RelatedNotesResult>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const find = vi.fn((_path: string, _signal: AbortSignal): Promise<RelatedNotesResult> => pending);
  find.mockResolvedValueOnce({
    currentPath: "one.md",
    contentHash: "initial",
    results: [{ path: "Previous result.md", score: 0.8 }],
  });
  const fixture = {
    status,
    labels,
    find,
    resolve,
    reject,
    key: "initial",
    path: "one.md",
    view: new FiloView(
      new WorkspaceLeaf(),
      status,
      { find, snapshotKey: (): string => fixture.key },
      async () => undefined,
      () => undefined
    ),
    unsubscribe: () => undefined as void,
  };
  (fixture.view as any).root = root;
  (fixture.view as any).app = { workspace: { getActiveFile: () => ({ path: fixture.path }) } };
  fixture.unsubscribe = status.subscribe((current) => {
    (fixture.view as any).status = current;
    (fixture.view as any).refreshRelated();
  });
  return fixture;
}
