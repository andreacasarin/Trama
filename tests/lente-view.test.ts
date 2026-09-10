import { describe, expect, it, vi } from "vitest";
import { WorkspaceLeaf } from "obsidian";
import { LenteView } from "@/ui/lente/LenteView";
import type { LenteBatch, LenteResult } from "@/index/LenteSearch";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function result(path: string, mtime: number, fusedScore = 1): LenteResult {
  return {
    path,
    startLine: 2,
    endLine: 3,
    excerpt: `excerpt ${path}`,
    generationId: "g1",
    chunkId: `${path}:0`,
    ordinal: 0,
    mtime,
    fusedScore,
  };
}

function batch(results: readonly LenteResult[], degraded = false): LenteBatch {
  return {
    generationId: "g1",
    mode: degraded ? "lexical" : "hybrid",
    degraded,
    displayLimit: 20,
    results,
    durationMs: 1,
  };
}

function byClass(node: any, className: string): any {
  if (node.classes?.has(className)) return node;
  for (const child of node.children ?? []) {
    const found = byClass(child, className);
    if (found) return found;
  }
  return undefined;
}

function byTag(node: any, tagName: string): any {
  if (node.tagName === tagName) return node;
  for (const child of node.children ?? []) {
    const found = byTag(child, tagName);
    if (found) return found;
  }
  return undefined;
}

function textOf(node: any): string {
  return [node.textContent, ...(node.children ?? []).map(textOf)].join(" ");
}

function byText(node: any, text: string): any {
  if (node.textContent === text) return node;
  for (const child of node.children ?? []) {
    const found = byText(child, text);
    if (found) return found;
  }
  return undefined;
}

function subject(search = vi.fn(async () => batch([]))) {
  const openLinkText = vi.fn().mockResolvedValue(undefined);
  const view = new LenteView(
    {
      app: { workspace: { openLinkText } },
    } as unknown as WorkspaceLeaf,
    { search }
  );
  return { view, search, openLinkText };
}

describe("LenteView", () => {
  it("does not search on open, empty input, or typing", async () => {
    const { view, search } = subject();
    await view.onOpen();
    const input = byTag(view.contentEl, "input");
    const toolbar = byClass(view.contentEl, "trama-lente__toolbar");
    expect(search).not.toHaveBeenCalled();
    expect(toolbar.hidden).toBe(true);
    expect(byText(toolbar, "Relevant").disabled).toBe(true);
    expect(byText(toolbar, "Updated").disabled).toBe(false);
    input.dispatch("input", { target: input });
    input.dispatch("keydown", { key: "Enter", isComposing: false });
    expect(search).not.toHaveBeenCalled();
    input.value = "needle";
    input.dispatch("input", { target: input });
    expect(search).not.toHaveBeenCalled();
    expect(toolbar.hidden).toBe(true);
  });

  it("submits exactly once from Enter and the Search button", async () => {
    const search = vi.fn(async () => batch([result("One.md", 1)]));
    const { view } = subject(search);
    await view.onOpen();
    const input = byTag(view.contentEl, "input");
    input.value = "needle";
    input.dispatch("input", { target: input });
    input.dispatch("keydown", { key: "Enter", isComposing: false });
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    expect(search).toHaveBeenCalledWith("needle", expect.objectContaining({ sort: "relevant" }));
    const toolbar = byClass(view.contentEl, "trama-lente__toolbar");
    expect(toolbar.hidden).toBe(false);
    expect(toolbar.children[0].classes.has("trama-lente__count")).toBe(true);
    expect(toolbar.children[0].textContent).toBe("1 results");
    expect(byClass(view.contentEl, "trama-lente__status").textContent).toBe("");
    const announcement = byClass(view.contentEl, "trama-lente__announcement");
    expect(announcement.getAttribute("aria-live")).toBe("polite");
    expect(announcement.textContent).toBe("1 results");
    expect(toolbar.children[1].classes.has("trama-lente__sort")).toBe(true);
    const relevant = byText(toolbar, "Relevant");
    const updated = byText(toolbar, "Updated");
    expect(relevant.getAttribute("aria-pressed")).toBe("true");
    expect(relevant.disabled).toBe(true);
    expect(updated.getAttribute("aria-pressed")).toBe("false");
    expect(updated.disabled).toBe(false);
    expect(byText(toolbar, "Relevant").children[0].getAttribute("data-icon")).toBe("arrow-up-down");

    const button = byClass(view.contentEl, "trama-lente__submit");
    expect(button.getAttribute("aria-label")).toBe("Search");
    button.click();
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2));
  });

  it("keeps the results toolbar hidden while searching, on errors, and with no results", async () => {
    const first = deferred<LenteBatch>();
    const search = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockRejectedValueOnce(new Error("failed"));
    const { view } = subject(search);
    await view.onOpen();
    const input = byTag(view.contentEl, "input");
    const toolbar = byClass(view.contentEl, "trama-lente__toolbar");
    input.value = "needle";
    input.dispatch("input", { target: input });
    input.dispatch("keydown", { key: "Enter", isComposing: false });
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    expect(toolbar.hidden).toBe(true);
    expect(byClass(view.contentEl, "trama-lente__status").textContent).toBe("Searching…");
    first.resolve(batch([]));
    await vi.waitFor(() => expect(textOf(view.contentEl)).toContain("No matching notes"));
    expect(toolbar.hidden).toBe(true);
    expect(byClass(view.contentEl, "trama-lente__status").textContent).toBe(
      "No matching notes found."
    );
    expect(byClass(view.contentEl, "trama-lente__announcement").textContent).toBe(
      "No matching notes found."
    );
    input.value = "again";
    input.dispatch("input", { target: input });
    input.dispatch("keydown", { key: "Enter", isComposing: false });
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(textOf(view.contentEl)).toContain("Search failed"));
    expect(toolbar.hidden).toBe(true);
  });

  it("cancels and suppresses a previous in-flight submission", async () => {
    const first = deferred<LenteBatch>();
    const second = deferred<LenteBatch>();
    const search = vi
      .fn()
      .mockImplementationOnce((_query: string, options: { signal: AbortSignal }) => {
        options.signal.addEventListener("abort", () => undefined);
        return first.promise;
      })
      .mockImplementationOnce((_query: string, options: { signal: AbortSignal }) => second.promise);
    const { view } = subject(search);
    await view.onOpen();
    const input = byTag(view.contentEl, "input");
    input.value = "old";
    input.dispatch("input", { target: input });
    input.dispatch("keydown", { key: "Enter", isComposing: false });
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    const firstSignal = search.mock.calls[0][1].signal;
    input.value = "new";
    input.dispatch("input", { target: input });
    input.dispatch("keydown", { key: "Enter", isComposing: false });
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);
    first.resolve(batch([result("Old.md", 1)]));
    second.resolve(batch([result("New.md", 2)]));
    await vi.waitFor(() => expect(textOf(view.contentEl)).toContain("New"));
    expect(textOf(view.contentEl)).not.toContain("Old.md");
  });

  it("refreshes the submitted query without replacing an unsent draft", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce(batch([result("A.md", 1)]))
      .mockResolvedValueOnce(batch([result("A-refreshed.md", 2)]));
    const { view } = subject(search);
    await view.onOpen();
    const input = byTag(view.contentEl, "input");
    input.value = "A";
    input.dispatch("input", { target: input });
    input.dispatch("keydown", { key: "Enter", isComposing: false });
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(textOf(view.contentEl)).toContain("A.md"));
    input.value = "B";
    input.dispatch("input", { target: input });
    view.refreshSubmitted();
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    expect(search.mock.calls[1][0]).toBe("A");
    expect(input.value).toBe("B");
    await vi.waitFor(() => expect(textOf(view.contentEl)).toContain("A-refreshed"));
  });

  it("hides an already-rendered excluded row synchronously", async () => {
    const search = vi.fn(async () =>
      batch([result("Private/Secret.md", 1), result("Public.md", 2)])
    );
    const { view } = subject(search);
    await view.onOpen();
    const input = byTag(view.contentEl, "input");
    input.value = "needle";
    input.dispatch("input", { target: input });
    input.dispatch("keydown", { key: "Enter", isComposing: false });
    await vi.waitFor(() => expect(textOf(view.contentEl)).toContain("Secret"));

    (view as any).invalidateExcludedPaths(["Private"]);

    expect(textOf(view.contentEl)).not.toContain("Secret");
    expect(textOf(view.contentEl)).toContain("Public");
  });

  it("reorders cached results for Updated without searching again", async () => {
    const search = vi.fn(async () => batch([result("Old.md", 1), result("New.md", 2)]));
    const { view } = subject(search);
    await view.onOpen();
    const input = byTag(view.contentEl, "input");
    input.value = "needle";
    input.dispatch("input", { target: input });
    input.dispatch("keydown", { key: "Enter", isComposing: false });
    await vi.waitFor(() => expect(textOf(view.contentEl)).toContain("Old"));
    byText(view.contentEl, "Updated").click();
    expect(search).toHaveBeenCalledTimes(1);
    expect(byText(view.contentEl, "Relevant").getAttribute("aria-pressed")).toBe("false");
    expect(byText(view.contentEl, "Relevant").disabled).toBe(false);
    expect(byText(view.contentEl, "Updated").getAttribute("aria-pressed")).toBe("true");
    expect(byText(view.contentEl, "Updated").disabled).toBe(true);
    const rows = byClass(view.contentEl, "trama-lente__rows");
    expect(rows.children[0].children[0].textContent).toBe("New");
  });

  it("sorts the full canonical pool and restores relevant order deterministically", async () => {
    const canonical = Array.from({ length: 25 }, (_, index) =>
      result(`Note-${index}.md`, index === 24 ? 10_000 : 1, 1 - index / 100)
    );
    const search = vi.fn(async () => ({
      ...batch(canonical.slice(0, 20)),
      canonicalResults: canonical,
    }));
    const { view } = subject(search);
    await view.onOpen();
    const input = byTag(view.contentEl, "input");
    input.value = "needle";
    input.dispatch("input", { target: input });
    input.dispatch("keydown", { key: "Enter", isComposing: false });
    await vi.waitFor(() => expect(textOf(view.contentEl)).toContain("Note-0"));
    const rows = byClass(view.contentEl, "trama-lente__rows");
    expect(rows.children).toHaveLength(20);
    byText(view.contentEl, "Updated").click();
    expect(rows.children[0].children[0].textContent).toBe("Note-24");
    byText(view.contentEl, "Relevant").click();
    expect(rows.children[0].children[0].textContent).toBe("Note-0");
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("honors the batch display limit when initially rendering and resorting", async () => {
    const canonical = Array.from({ length: 25 }, (_, index) =>
      result(`Note-${index}.md`, index === 24 ? 10_000 : 1, 1 - index / 100)
    );
    const search = vi.fn(async () => ({
      ...batch(canonical.slice(0, 5)),
      displayLimit: 5,
      canonicalResults: canonical,
    }));
    const { view } = subject(search);
    await view.onOpen();
    const input = byTag(view.contentEl, "input");
    input.value = "needle";
    input.dispatch("input", { target: input });
    input.dispatch("keydown", { key: "Enter", isComposing: false });
    await vi.waitFor(() => expect(textOf(view.contentEl)).toContain("Note-0"));
    const rows = byClass(view.contentEl, "trama-lente__rows");
    expect(rows.children).toHaveLength(5);
    expect(byClass(view.contentEl, "trama-lente__announcement").textContent).toBe("5 results");
    byText(view.contentEl, "Updated").click();
    expect(rows.children).toHaveLength(5);
    expect(rows.children[0].children[0].textContent).toBe("Note-24");
  });

  it("shows degraded lexical-only state and supports navigation", async () => {
    const search = vi.fn(async () => batch([result("Folder/Note.md", 1)], true));
    const { view, openLinkText } = subject(search);
    await view.onOpen();
    const input = byTag(view.contentEl, "input");
    input.value = "needle";
    input.dispatch("input", { target: input });
    input.dispatch("keydown", { key: "Enter", isComposing: false });
    await vi.waitFor(() => expect(textOf(view.contentEl)).toContain("Lexical-only"));
    expect(byClass(view.contentEl, "trama-lente__status").textContent).toBe(
      "Lexical-only results (embeddings unavailable)."
    );
    expect(byClass(view.contentEl, "trama-lente__announcement").textContent).toBe("1 results");
    const link = byClass(view.contentEl, "trama-lente__link");
    link.dispatch("click", { ctrlKey: true });
    expect(openLinkText).toHaveBeenCalledWith("Folder/Note.md", "", true);
  });

  it("shows updating and index warnings in the visible status", async () => {
    const search = vi
      .fn()
      .mockRejectedValueOnce({ code: "busy" })
      .mockRejectedValueOnce({ code: "unavailable" });
    const { view } = subject(search);
    await view.onOpen();
    const input = byTag(view.contentEl, "input");
    input.value = "needle";
    input.dispatch("input", { target: input });
    input.dispatch("keydown", { key: "Enter", isComposing: false });
    await vi.waitFor(() =>
      expect(byClass(view.contentEl, "trama-lente__status").textContent).toBe("Updating index…")
    );
    input.dispatch("keydown", { key: "Enter", isComposing: false });
    await vi.waitFor(() =>
      expect(byClass(view.contentEl, "trama-lente__status").textContent).toBe(
        "Index unavailable. Reindex required."
      )
    );
  });

  it("keeps the last good rows while showing a fatal visible status", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce(batch([result("Good.md", 1)]))
      .mockRejectedValueOnce(new Error("failed"));
    const { view } = subject(search);
    await view.onOpen();
    const input = byTag(view.contentEl, "input");
    input.value = "first";
    input.dispatch("input", { target: input });
    input.dispatch("keydown", { key: "Enter", isComposing: false });
    await vi.waitFor(() => expect(textOf(view.contentEl)).toContain("Good"));
    input.value = "second";
    input.dispatch("input", { target: input });
    input.dispatch("keydown", { key: "Enter", isComposing: false });
    await vi.waitFor(() =>
      expect(byClass(view.contentEl, "trama-lente__status").textContent).toBe(
        "Search failed. Try again."
      )
    );
    expect(textOf(view.contentEl)).toContain("Good");
    expect(byClass(view.contentEl, "trama-lente__toolbar").hidden).toBe(true);
  });

  it("clears to idle on Escape and cleans up on close/replacement", async () => {
    const pending = deferred<LenteBatch>();
    const search = vi.fn(async () => pending.promise);
    const { view } = subject(search);
    await view.onOpen();
    const input = byTag(view.contentEl, "input");
    input.value = "needle";
    input.dispatch("input", { target: input });
    input.dispatch("keydown", { key: "Enter", isComposing: false });
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    const calls = search.mock.calls as unknown as Array<[string, { signal: AbortSignal }]>;
    const signal = calls[0][1].signal;
    input.dispatch("keydown", { key: "Escape" });
    expect(signal.aborted).toBe(true);
    expect(textOf(view.contentEl)).toContain("Submit a query");

    input.value = "again";
    input.dispatch("input", { target: input });
    input.dispatch("keydown", { key: "Enter", isComposing: false });
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    const secondSignal = calls[1][1].signal;
    view.setSearch({ search: vi.fn(async () => batch([])) });
    expect(secondSignal.aborted).toBe(true);
    await view.onClose();
  });
});
