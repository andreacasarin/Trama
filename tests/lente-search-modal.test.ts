import { beforeEach, describe, expect, it, vi } from "vitest";
import { SuggestModal } from "obsidian";
import { LenteSearchModal } from "@/ui/lente/LenteSearchModal";
import type { LenteBatch, LenteResult } from "@/index/LenteSearch";
import { resetTestWindow, TestElement } from "./obsidian";

const result = (path: string, excerpt = "matching passage"): LenteResult => ({
  path,
  startLine: 2,
  endLine: 3,
  excerpt,
  generationId: "g1",
  chunkId: `${path}:0`,
  ordinal: 0,
  mtime: 1,
  fusedScore: 1,
});

const batch = (results: readonly LenteResult[], degraded = false): LenteBatch => ({
  generationId: "g1",
  mode: degraded ? "lexical" : "hybrid",
  degraded,
  displayLimit: 20,
  results,
  canonicalResults: results,
  durationMs: 0,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createModal(search = vi.fn(async () => batch([])), automaticSearchDelayMs = 0) {
  const openLinkText = vi.fn();
  const modal = new LenteSearchModal(
    { workspace: { openLinkText } } as never,
    { search },
    automaticSearchDelayMs
  );
  return { modal, openLinkText, search };
}

function inputOf(modal: LenteSearchModal): TestElement {
  return modal.inputEl as unknown as TestElement;
}

function dispatchKey(modal: LenteSearchModal, event: Record<string, unknown>) {
  const payload = {
    type: "keydown",
    ...event,
  };
  return inputOf(modal).dispatchEvent(payload);
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("LenteSearchModal", () => {
  beforeEach(() => {
    (SuggestModal as unknown as { lastOpened?: unknown }).lastOpened = undefined;
    resetTestWindow();
  });

  it("keeps same-window listeners after stopPropagation but not stopImmediatePropagation", () => {
    const input = new TestElement("input");
    const window = input.ownerDocument.defaultView;
    const afterStop = vi.fn();
    window.addEventListener("keydown", (event) => event.stopPropagation(), true);
    window.addEventListener("keydown", afterStop, true);

    input.dispatchEvent({ type: "keydown", key: "Escape" });
    expect(afterStop).toHaveBeenCalledTimes(1);

    resetTestWindow();
    const afterImmediateStop = vi.fn();
    window.addEventListener("keydown", (event) => event.stopImmediatePropagation(), true);
    window.addEventListener("keydown", afterImmediateStop, true);

    input.dispatchEvent({ type: "keydown", key: "Escape" });
    expect(afterImmediateStop).not.toHaveBeenCalled();
  });

  it("opens natively and autofocuses without searching while typing", () => {
    const { modal, search } = createModal();
    const focus = vi.spyOn(modal.inputEl, "focus");

    modal.open();
    modal.inputEl.value = "draft";
    inputOf(modal).dispatch("input");

    expect((SuggestModal as unknown as { lastOpened?: unknown }).lastOpened).toBe(modal);
    expect(focus).toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(modal.getState()).toMatchObject({ kind: "idle" });
  });

  it("keeps one modal capture listener across reopen beside native capture", async () => {
    const search = vi.fn(async () => batch([]));
    const { modal } = createModal(search);
    const windowListeners = () =>
      (
        (modal.inputEl as unknown as TestElement).ownerDocument.defaultView.listeners.get(
          "keydown"
        ) ?? []
      ).filter(({ capture }) => capture);

    expect(windowListeners()).toHaveLength(1);
    modal.open();
    expect(windowListeners()).toHaveLength(2);
    modal.inputEl.value = "first";
    inputOf(modal).dispatch("input");
    dispatchKey(modal, { key: "Enter" });
    await settle();
    modal.close();
    expect(windowListeners()).toHaveLength(1);

    modal.open();
    expect(windowListeners()).toHaveLength(2);
    modal.inputEl.value = "second";
    inputOf(modal).dispatch("input");
    dispatchKey(modal, { key: "Enter" });
    await settle();

    expect(search).toHaveBeenCalledTimes(2);
  });

  it("submits after the earlier native Enter capture consumes idle and changed drafts", async () => {
    const trace: string[] = [];
    const search = vi.fn(async (query: string) => {
      trace.push(`modal-submit:${query}`);
      return batch([]);
    });
    const { modal } = createModal(search);
    modal.open();

    modal.inputEl.value = "idle";
    inputOf(modal).dispatch("input");
    expect(dispatchKey(modal, { key: "Enter", trace })).toBe(false);
    await settle();

    modal.inputEl.value = "changed";
    inputOf(modal).dispatch("input");
    expect(dispatchKey(modal, { key: "Enter", trace })).toBe(false);

    expect(trace).toEqual([
      "native-consume",
      "modal-submit:idle",
      "native-consume",
      "modal-submit:changed",
    ]);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("submits once on Enter with a trimmed query, relevant sorting, and an AbortSignal", async () => {
    const pending = deferred<LenteBatch>();
    const search = vi.fn(() => pending.promise);
    const { modal } = createModal(search);
    modal.open();
    modal.inputEl.value = "  needle  ";
    inputOf(modal).dispatch("input");
    expect(dispatchKey(modal, { key: "Enter" })).toBe(false);

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith(
      "needle",
      expect.objectContaining({ sort: "relevant", signal: expect.any(AbortSignal) })
    );
    expect(modal.getState()).toMatchObject({ kind: "loading", query: "needle" });
    pending.resolve(batch([]));
    await settle();
    expect(modal.getState()).toMatchObject({ kind: "empty", query: "needle" });
  });

  it("debounces positive-delay input and lets Enter submit immediately without a duplicate", async () => {
    vi.useFakeTimers();
    try {
      const search = vi.fn(async () => batch([]));
      const { modal } = createModal(search, 200);
      modal.open();
      modal.inputEl.value = "first";
      inputOf(modal).dispatch("input");
      await vi.advanceTimersByTimeAsync(199);
      expect(search).not.toHaveBeenCalled();

      modal.inputEl.value = "second";
      inputOf(modal).dispatch("input");
      await vi.advanceTimersByTimeAsync(199);
      expect(search).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(search).toHaveBeenCalledTimes(1);
      expect(search).toHaveBeenCalledWith("second", expect.anything());

      modal.inputEl.value = "third";
      inputOf(modal).dispatch("input");
      dispatchKey(modal, { key: "Enter" });
      expect(search).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(200);
      expect(search).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not resubmit or abort when native Enter follows an automatic loading submit", async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred<LenteBatch>();
      let originalSignal!: AbortSignal;
      const search = vi.fn((_query: string, options: { signal: AbortSignal }) => {
        originalSignal = options.signal;
        return pending.promise;
      });
      const { modal } = createModal(search, 200);
      modal.open();
      modal.inputEl.value = "needle";
      inputOf(modal).dispatch("input");
      await vi.advanceTimersByTimeAsync(200);

      expect(search).toHaveBeenCalledTimes(1);
      expect(originalSignal.aborted).toBe(false);
      expect(modal.getState()).toMatchObject({ kind: "loading", query: "needle" });

      dispatchKey(modal, { key: "Enter" });

      expect(search).toHaveBeenCalledTimes(1);
      expect(originalSignal.aborted).toBe(false);
      pending.resolve(batch([]));
      await vi.runAllTimersAsync();
      await settle();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not schedule while composing and schedules once composition ends", async () => {
    vi.useFakeTimers();
    try {
      const search = vi.fn(async () => batch([]));
      const { modal } = createModal(search, 100);
      modal.open();
      inputOf(modal).dispatch("compositionstart");
      modal.inputEl.value = "composing";
      inputOf(modal).dispatch("input");
      await vi.advanceTimersByTimeAsync(1000);
      expect(search).not.toHaveBeenCalled();
      inputOf(modal).dispatch("compositionend");
      await vi.advanceTimersByTimeAsync(99);
      expect(search).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(search).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing for empty or composing Enter without consuming the event", () => {
    const { modal, openLinkText, search } = createModal();
    modal.open();
    dispatchKey(modal, { key: "Enter" });
    modal.inputEl.value = "needle";
    inputOf(modal).dispatch("input");
    const preventDefault = vi.fn();
    const composingDispatch = dispatchKey(modal, {
      key: "Enter",
      isComposing: true,
      preventDefault,
    });
    expect(composingDispatch).toBe(true);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(openLinkText).not.toHaveBeenCalled();
  });

  it("renders accepted results and opens the selected rendered result", async () => {
    const first = result("Folder/First.md");
    const second = result("Second.md", "second passage");
    const { modal, openLinkText } = createModal(vi.fn(async () => batch([first, second])));
    modal.open();
    modal.inputEl.value = "needle";
    inputOf(modal).dispatch("input");
    dispatchKey(modal, { key: "Enter" });
    await settle();

    const renderedRows = modal.resultContainerEl.children as unknown as TestElement[];
    expect(renderedRows).toHaveLength(2);
    expect(renderedRows[0].classes.has("suggestion-item")).toBe(true);
    expect(renderedRows[0].classes.has("trama-lente-search-modal__result")).toBe(true);
    expect(renderedRows[0].children[0].classes.has("suggestion-content")).toBe(true);
    expect(renderedRows[0].children[0].classes.has("trama-lente-search-modal__content")).toBe(true);
    const suggestions = modal.getSuggestions("needle");
    const rendered = new TestElement("div");
    modal.renderSuggestion(suggestions[0], rendered as never);
    expect(rendered.children[0].classes.has("suggestion-content")).toBe(true);
    expect(rendered.children[0].children[0].classes.has("suggestion-title")).toBe(true);
    expect(rendered.children[0].children[0].classes.has("trama-lente-search-modal__title")).toBe(
      true
    );
    expect(rendered.children[0].children[1].classes.has("suggestion-note")).toBe(true);
    expect(rendered.children[0].children[1].classes.has("trama-lente-search-modal__path")).toBe(
      true
    );
    expect(rendered.children[0].children[2].classes.has("suggestion-note")).toBe(true);
    expect(rendered.children[0].children[2].classes.has("trama-lente-search-modal__excerpt")).toBe(
      true
    );
    expect(rendered.children[0].children.map((child) => child.textContent)).toEqual([
      "First",
      "Folder/First.md · lines 2-3",
      "matching passage",
    ]);
    expect(
      rendered.children[0].children.every(
        (child) => child.classes.has("suggestion-note") || child.classes.has("suggestion-title")
      )
    ).toBe(true);

    dispatchKey(modal, { key: "ArrowDown" });
    expect(renderedRows[1].classes.has("is-selected")).toBe(true);
    dispatchKey(modal, { key: "Enter" });
    expect(openLinkText).toHaveBeenCalledWith("Second.md", "", false);
    expect((modal as unknown as { opened: boolean }).opened).toBe(false);
  });

  it("resubmits changed drafts and suppresses stale success, error, and close results", async () => {
    const first = deferred<LenteBatch>();
    const second = deferred<LenteBatch>();
    const search = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { modal } = createModal(search);
    modal.open();
    modal.inputEl.value = "first";
    inputOf(modal).dispatch("input");
    dispatchKey(modal, { key: "Enter" });
    modal.inputEl.value = "second";
    inputOf(modal).dispatch("input");
    dispatchKey(modal, { key: "Enter" });
    first.resolve(batch([result("stale.md")]));
    await settle();
    expect(modal.getSuggestions("second")).toEqual([]);
    second.resolve(batch([result("fresh.md")]));
    await settle();
    expect(modal.getSuggestions("second").map((item) => item.path)).toEqual(["fresh.md"]);

    const third = deferred<LenteBatch>();
    search.mockReturnValueOnce(third.promise);
    modal.inputEl.value = "third";
    inputOf(modal).dispatch("input");
    dispatchKey(modal, { key: "Enter" });
    modal.close();
    const callsAfterClose = search.mock.calls.length;
    modal.inputEl.value = "late";
    dispatchKey(modal, { key: "Enter" });
    expect(search).toHaveBeenCalledTimes(callsAfterClose);
    third.resolve(batch([result("late.md")]));
    await settle();
    expect(modal.getSuggestions("third")).toEqual([]);
  });

  it("resubmits the unchanged query after closing and reopening, ignoring the old completion", async () => {
    const first = deferred<LenteBatch>();
    const second = deferred<LenteBatch>();
    const search = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { modal } = createModal(search);
    modal.open();
    modal.inputEl.value = "same";
    inputOf(modal).dispatch("input");
    dispatchKey(modal, { key: "Enter" });
    modal.close();

    modal.open();
    expect(modal.getState()).toMatchObject({ kind: "idle", query: "same" });
    dispatchKey(modal, { key: "Enter" });
    expect(search).toHaveBeenCalledTimes(2);

    first.resolve(batch([result("stale.md")]));
    await settle();
    expect(modal.getSuggestions("same")).toEqual([]);
    second.resolve(batch([result("fresh.md")]));
    await settle();
    expect(modal.getSuggestions("same").map((item) => item.path)).toEqual(["fresh.md"]);
  });

  it("maps empty, degraded, busy, unavailable, and generic error states", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce(batch([], true))
      .mockRejectedValueOnce({ code: "busy" })
      .mockRejectedValueOnce({ code: "unavailable" })
      .mockRejectedValueOnce(new Error("nope"));
    const { modal } = createModal(search);
    modal.open();
    for (const query of ["empty", "busy", "unavailable", "error"]) {
      modal.inputEl.value = query;
      inputOf(modal).dispatch("input");
      dispatchKey(modal, { key: "Enter" });
      await settle();
      expect(modal.emptyStateText).toContain(
        query === "empty"
          ? "lexical-only"
          : query === "busy"
            ? "Updating index"
            : query === "unavailable"
              ? "Index unavailable"
              : "Search failed"
      );
    }
  });
});
