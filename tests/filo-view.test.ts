import { describe, expect, it, vi } from "vitest";
import { WorkspaceLeaf } from "obsidian";
import { FiloView } from "@/ui/filo/FiloView";

function subject(
  status: any,
  results: readonly (
    | string
    | {
        path: string;
        score: number;
        similarity?: number;
        excerpt?: string;
        startLine?: number;
        endLine?: number;
      }
  )[] = [],
  runIndex: (kind: "index" | "reindex") => Promise<void> = async () => {},
  findOverride?: any
) {
  const listeners = new Set<(value: any) => void>();
  const related = {
    find:
      findOverride ??
      vi.fn(async (path: string) => ({
        generationId: "g1",
        currentPath: path,
        contentHash: "g1:" + path,
        results: results.map((result) =>
          typeof result === "string" ? { path: result, score: 1 } : result
        ),
      })),
    subscribe: (listener: (value: any) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const source = {
    getStatus: () => status,
    subscribe: (listener: (value: any) => void) => {
      listeners.add(listener);
      listener(status);
      return () => listeners.delete(listener);
    },
  };
  const openLinkText = vi.fn().mockResolvedValue(undefined);
  const view = new FiloView(
    {
      app: {
        workspace: {
          getActiveFile: () => ({ path: "Current.md" }),
          on: () => ({ unsubscribe: vi.fn() }),
          openLinkText,
        },
      },
    } as unknown as WorkspaceLeaf,
    source,
    related,
    runIndex
  );
  return { view, related, openLinkText };
}

function textOf(node: any): string {
  return [node.textContent, ...(node.children ?? []).map(textOf)].join(" ");
}

function byClass(node: any, className: string): any {
  if (node.classes?.has(className)) return node;
  for (const child of node.children ?? []) {
    const match = byClass(child, className);
    if (match) return match;
  }
  return undefined;
}

const ready = {
  kind: "ready",
  hasLastGood: true,
  canIndex: false,
  canReindex: true,
  canCancel: false,
  revision: 1,
};

describe("FiloView", () => {
  it("uses the shared native Filo icon", () => {
    const { view } = subject(ready);
    expect(view.getIcon()).toBe("route");
  });

  it("renders ordered unique related rows and excludes the active note", async () => {
    const { view } = subject(ready, ["Current.md", "Folder/One.md", "Folder/One.md", "Two.md"]);
    await view.onOpen();
    const text = textOf(view.contentEl as any);
    expect(text).toContain("One");
    expect(text).toContain("Two");
    expect(text).not.toContain("Current.md");
  });

  it("uses native modifier-aware link navigation", async () => {
    const { view, openLinkText } = subject(ready, ["One.md"]);
    await view.onOpen();
    const link = byClass(view.contentEl, "trama-filo__link");
    expect(link.classes.has("internal-link")).toBe(true);
    expect(link.tagName).toBe("a");
    link.dispatch("click", { ctrlKey: true });
    expect(openLinkText).toHaveBeenCalledWith("One.md", "Current.md", true);
  });

  it("expands the winning passage without performing another lookup", async () => {
    const { view, related } = subject(ready, [
      {
        path: "Folder/One.md",
        score: 0.02,
        similarity: 0.8,
        excerpt: "The most relevant passage.",
        startLine: 12,
        endLine: 14,
      },
    ]);
    await view.onOpen();
    const caret = byClass(view.contentEl, "trama-filo__caret");
    expect(caret.getAttribute("aria-expanded")).toBe("false");

    caret.click();

    expect(textOf(view.contentEl as any)).toContain("The most relevant passage.");
    expect(textOf(view.contentEl as any)).toContain("lines 12–14");
    expect(byClass(view.contentEl, "trama-filo__caret").getAttribute("data-icon")).toBe(
      "chevron-down"
    );
    expect(related.find).toHaveBeenCalledTimes(1);
  });

  it("labels cosine similarity using the class thresholds", async () => {
    const { view } = subject(ready, [
      { path: "High.md", score: 0.03, similarity: FiloView.HIGH_SIMILARITY_THRESHOLD },
      { path: "Medium.md", score: 0.02, similarity: FiloView.MEDIUM_SIMILARITY_THRESHOLD },
      { path: "Low.md", score: 0.01, similarity: FiloView.MEDIUM_SIMILARITY_THRESHOLD - 0.01 },
    ]);

    await view.onOpen();

    const text = textOf(view.contentEl as any);
    expect(text).toContain("High");
    expect(text).toContain("Medium");
    expect(text).toContain("Low");
  });

  it("keeps seven results and extends to twenty only above the similarity cutoff", async () => {
    const results = [
      ...Array.from({ length: 7 }, (_, index) => ({
        path: `Base ${index}.md`,
        score: 1 - index / 100,
        similarity: 0.1,
      })),
      { path: "Below.md", score: 0.8, similarity: 0.29 },
      { path: "At cutoff.md", score: 0.7, similarity: FiloView.EXTENDED_SIMILARITY_THRESHOLD },
      ...Array.from({ length: 20 }, (_, index) => ({
        path: `Extra ${index}.md`,
        score: 0.6 - index / 100,
        similarity: 0.4,
      })),
    ];
    const { view, related } = subject(ready, results);

    await view.onOpen();

    expect(related.find).toHaveBeenCalledWith("Current.md", expect.any(AbortSignal), 20);
    const text = textOf(view.contentEl as any);
    expect(text).not.toContain("Below");
    expect(text).toContain("At cutoff");
    const rows = (view.contentEl as any).children[0].children[1];
    expect(rows.children).toHaveLength(20);
  });

  it("shows the index action when no usable generation exists", async () => {
    const { view } = subject({
      ...ready,
      kind: "index-required",
      hasLastGood: false,
      canIndex: true,
    });
    await view.onOpen();
    expect(textOf(view.contentEl as any)).toContain("Build index");
  });

  it("uses incremental indexing for stale state while keeping forced reindex available", async () => {
    const runIndex = vi.fn(async () => {});
    const { view } = subject(
      {
        ...ready,
        kind: "stale",
        message: "Index has changes; update required.",
        canIndex: true,
        canReindex: true,
      },
      [],
      runIndex
    );

    await view.onOpen();

    expect(textOf(view.contentEl as any)).toContain("Index has changes; update required.");
    const buttons = (view.contentEl as any).children[0].children.filter(
      (child: any) => child.tagName === "button"
    );
    expect(buttons.map((button: any) => button.textContent)).toEqual([
      "Update index",
      "Rebuild index",
    ]);
    buttons[0].click();
    expect(runIndex).toHaveBeenCalledWith("index");
    buttons[1].click();
    expect(runIndex).toHaveBeenCalledWith("reindex");
  });

  it("renders structured progress while an incremental update is running", async () => {
    const { view } = subject({
      ...ready,
      kind: "updating",
      message: "embed: 2/4 texts",
      progress: {
        operation: "incremental",
        phase: "embed",
        completed: 2,
        total: 4,
        unit: "texts",
        determinate: true,
        estimated: true,
      },
      etaSeconds: 8,
    });

    await view.onOpen();

    const text = textOf(view.contentEl as any);
    expect(text).not.toContain("Updating index…");
    expect(text).toContain("Creating embeddings — 2 of about 4 texts · about 8 sec remaining");
    const progress = (view.contentEl as any).children[0].children.find(
      (child: any) => child.tagName === "progress"
    );
    expect(progress?.getAttribute("value")).toBe("2");
    expect(progress?.getAttribute("max")).toBe("4");
  });

  it("shows completed counts for indeterminate progress", async () => {
    const { view } = subject({
      ...ready,
      kind: "updating",
      message: "embed: 37 texts",
      progress: {
        operation: "incremental",
        phase: "embed",
        completed: 37,
        unit: "texts",
        determinate: false,
      },
    });

    await view.onOpen();

    expect(textOf(view.contentEl as any)).toContain("Creating embeddings — 37 texts");
    const progress = (view.contentEl as any).children[0].children.find(
      (child: any) => child.tagName === "progress"
    );
    expect(progress?.getAttribute("value")).toBeNull();
  });

  it("leaves the loading state when related-note lookup fails", async () => {
    const { view, related } = subject(ready);
    related.find.mockRejectedValueOnce(new Error("private backend detail"));

    await view.onOpen();
    await vi.waitFor(() =>
      expect(textOf(view.contentEl as any)).toContain("Related notes could not be loaded.")
    );

    const text = textOf(view.contentEl as any);
    expect(text).not.toContain("Finding related notes…");
    expect(text).not.toContain("private backend detail");
  });

  it("retries a transient same-note lookup only after a later refresh", async () => {
    const { view, related } = subject(ready, ["One.md"]);
    related.find.mockRejectedValueOnce(new Error("temporary"));

    await view.onOpen();
    await vi.waitFor(() => expect(related.find).toHaveBeenCalledTimes(1));
    expect(textOf(view.contentEl as any)).toContain("Related notes could not be loaded.");
    expect(related.find).toHaveBeenCalledTimes(1);

    (view as any).refreshRelated();
    await vi.waitFor(() => expect(related.find).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(textOf(view.contentEl as any)).toContain("One"));
  });

  it.each([
    ["error", false, true, false, "Build index", "index"],
    ["error", true, false, true, "Rebuild index", "reindex"],
    ["cancelled", false, true, false, "Build index", "index"],
    ["cancelled", true, false, true, "Rebuild index", "reindex"],
  ])(
    "renders the correct recovery action for %s with last-good=%s",
    async (kind, hasLastGood, canIndex, canReindex, label, action) => {
      const runIndex = vi.fn(async () => {});
      const { view } = subject(
        {
          ...ready,
          kind,
          hasLastGood,
          canIndex,
          canReindex,
          message: "operation failed",
        },
        [],
        runIndex
      );
      await view.onOpen();
      expect(textOf(view.contentEl as any)).toContain(label);
      const button = (view.contentEl as any).children[0].children.find((child: any) =>
        textOf(child).includes(label)
      );
      button.click();
      expect(runIndex).toHaveBeenCalledWith(action);
    }
  );
});
