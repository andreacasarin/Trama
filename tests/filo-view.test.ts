import { describe, expect, it, vi } from "vitest";
import { WorkspaceLeaf } from "obsidian";
import { FiloView } from "@/ui/filo/FiloView";
import { IndexStatusController } from "@/ui/index/IndexStatus";

describe("Filo semantic index display", () => {
  it("shows semantic progress and Cancel instead of the idle Update prompt", async () => {
    const status = new IndexStatusController({} as any, {
      index: async () => undefined,
      reindex: async () => undefined,
      prepare: () => new Promise<void>(() => undefined),
      cancel: () => undefined,
    });
    status.setReady();
    void status.prepare();
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
    const view = new FiloView(new WorkspaceLeaf(), status, undefined);
    (view as any).root = root;
    (view as any).activePath = "one.md";
    (view as any).status = status.getStatus();
    (view as any).render();

    expect(rendered).toContainEqual({
      tag: "p",
      text: "Updating semantic index — 64 of 1000 chunks",
    });
    expect(rendered).toContainEqual({ tag: "progress", text: "" });
    expect(rendered).toContainEqual({ tag: "button", text: "Cancel" });
    expect(rendered.some((item) => item.text === "Update semantic index")).toBe(false);
  });

  it("keeps Stop indexing accessible when the square icon replaces button text", () => {
    const status = new IndexStatusController({} as any, {
      index: async () => undefined,
      reindex: async () => undefined,
      cancel: () => undefined,
    });
    status.setReady();
    const lease = status.acquireExternalLease("semantic");
    const attrs: Record<string, string> = {};
    const root = {
      empty: () => undefined,
      createEl: (_tag: string, options: { text?: string; attr?: Record<string, string> }) => {
        Object.assign(attrs, options.attr);
        return {
          addEventListener: () => undefined,
          setAttribute: (name: string, value: string) => (attrs[name] = value),
        };
      },
      createDiv: () => root,
    };
    const view = new FiloView(new WorkspaceLeaf(), status, undefined);
    (view as any).root = root;
    (view as any).activePath = "one.md";
    (view as any).status = status.getStatus();
    (view as any).render();

    expect(attrs["aria-label"]).toBe("Stop indexing");
    lease!.release();
  });

  it("offers semantic update and rebuild after a semantic failure", async () => {
    const status = new IndexStatusController({} as any, {
      index: async () => undefined,
      reindex: async () => undefined,
      prepare: async () => {
        throw new Error("provider unavailable");
      },
      cancel: () => undefined,
    });
    status.setReady();
    await status.prepare();

    const labels: string[] = [];
    const root = {
      empty: () => labels.splice(0),
      createEl: (_tag: string, options: { text?: string }) => {
        labels.push(options.text ?? "");
        return { addEventListener: () => undefined };
      },
      createDiv: (options: { text?: string }) => labels.push(options.text ?? ""),
    };
    const view = new FiloView(new WorkspaceLeaf(), status, undefined);
    (view as any).root = root;
    (view as any).activePath = "one.md";
    (view as any).status = status.getStatus();
    (view as any).render();

    expect(labels).toContain("Update semantic index");
    expect(labels).toContain("Rebuild semantic index");
    expect(labels).not.toContain("Rebuild lexical index");
  });

  it("renders a friendly failure message instead of raw index details", () => {
    const labels: string[] = [];
    const root = {
      empty: () => labels.splice(0),
      createEl: (_tag: string, options: { text?: string }) => {
        labels.push(options.text ?? "");
        return { addEventListener: () => undefined };
      },
      createDiv: (options: { text?: string }) => labels.push(options.text ?? ""),
    };
    const view = new FiloView(new WorkspaceLeaf(), { getStatus: () => ({}) } as any, undefined);
    (view as any).root = root;
    (view as any).activePath = "one.md";
    (view as any).status = {
      kind: "error",
      channel: "lexical",
      hasLastGood: false,
      message: "no such column: f while opening one.md",
      canIndex: true,
      canReindex: false,
      canPrepare: false,
      canCancel: false,
    };
    (view as any).render();
    expect(labels).toContain("Unable to build the lexical index.");
    expect(labels.join(" ")).not.toContain("no such column");
    expect(labels.join(" ")).not.toContain("one.md");
  });

  it("offers separate incremental and full semantic actions for partial coverage", async () => {
    const update = vi.fn(async () => undefined);
    const rebuild = vi.fn(async () => undefined);
    const status = new IndexStatusController({} as any, {
      index: async () => undefined,
      reindex: async () => undefined,
      prepare: update,
      rebuildSemantic: rebuild,
      cancel: () => undefined,
    });
    status.setReady();
    status.setCapabilities({
      availability: "available",
      lexical: { state: "ready", activity: "idle", searchable: true },
      semantic: { state: "partial", activity: "idle", searchable: true },
      freshness: "locally-reconciled",
    });

    const labels: string[] = [];
    const clicks = new Map<string, () => void>();
    const root = {
      empty: () => labels.splice(0),
      createEl: (_tag: string, options: { text?: string }) => {
        const label = options.text ?? "";
        labels.push(label);
        return {
          addEventListener: (_event: string, click: () => void) => clicks.set(label, click),
        };
      },
      createDiv: (options: { text?: string }) => {
        labels.push(options.text ?? "");
        return root;
      },
    };
    const view = new FiloView(new WorkspaceLeaf(), status, undefined);
    (view as any).root = root;
    (view as any).activePath = "one.md";
    (view as any).status = status.getStatus();
    (view as any).related = { results: [] };
    (view as any).render();

    expect(labels).toContain("Update semantic index");
    expect(labels).toContain("Rebuild semantic index");
    clicks.get("Update semantic index")?.();
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(status.getStatus().kind).toBe("ready"));
    clicks.get("Rebuild semantic index")?.();
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalledOnce());
  });

  it("keeps indexed related notes visible alongside stale-index actions", () => {
    const status = new IndexStatusController({} as any, {
      index: async () => undefined,
      reindex: async () => undefined,
      cancel: () => undefined,
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
    const view = new FiloView(new WorkspaceLeaf(), status, undefined);
    (view as any).root = root;
    (view as any).activePath = "one.md";
    (view as any).status = status.getStatus();
    (view as any).related = { results: [] };
    (view as any).render();

    expect(labels).toContain("No related notes found.");
    expect(labels).toContain("Lexical index has changes; update required.");
    expect(labels).toContain("Update lexical index");
    expect(labels).toContain("Rebuild lexical index");
  });
});
