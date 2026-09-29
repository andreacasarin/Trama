import { describe, expect, it } from "vitest";
import { WorkspaceLeaf } from "obsidian";
import { FiloView } from "@/ui/filo/FiloView";
import { IndexStatusController } from "@/ui/index/IndexStatus";

describe("Filo semantic index display", () => {
  it("shows semantic progress and Cancel instead of the idle Update prompt", async () => {
    const status = new IndexStatusController({} as any, {
      update: async () => undefined,
      rebuild: async () => undefined,
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
      () => undefined
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
    expect(rendered.some((item) => item.text === "Update semantic index")).toBe(false);
  });

  it("offers Update after a semantic failure", async () => {
    const status = new IndexStatusController({} as any, {
      update: async () => undefined,
      rebuild: async () => undefined,
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
