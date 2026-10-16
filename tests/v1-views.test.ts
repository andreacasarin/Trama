import { describe, expect, it, vi } from "vitest";
import { Document } from "@langchain/core/documents";
import { LenteView } from "@/ui/lente/LenteView";
import { LenteSearchModal } from "@/ui/lente/LenteSearchModal";
import { FiloView } from "@/ui/filo/FiloView";
import { VoceView } from "@/ui/voce/VoceView";
import { IndexStatusController } from "@/ui/index/IndexStatus";
import { appendNoteResultRow } from "@/ui/noteResultRow";

class ElementStub {
  children: ElementStub[] = [];
  listeners = new Map<string, (event: any) => void>();
  attributes: Record<string, string> = {};
  value = "";
  textContent = "";
  className = "";
  hidden = false;
  parentElement?: ElementStub;
  readonly classList = {
    add: (...classes: string[]) => {
      this.className = [
        ...new Set([...this.className.split(" ").filter(Boolean), ...classes]),
      ].join(" ");
    },
    toggle: (className: string, force?: boolean) => {
      const classes = new Set(this.className.split(" ").filter(Boolean));
      const shouldAdd = force ?? !classes.has(className);
      if (shouldAdd) classes.add(className);
      else classes.delete(className);
      this.className = [...classes].join(" ");
      return shouldAdd;
    },
  };
  constructor(readonly tag = "div") {}
  empty(): void {
    this.children = [];
    this.textContent = "";
  }
  createDiv(options?: { cls?: string; text?: string; attr?: Record<string, string> }): ElementStub {
    const child = this.add(new ElementStub("div"), options);
    child.textContent = options?.text ?? "";
    for (const [name, value] of Object.entries(options?.attr ?? {}))
      child.setAttribute(name, value);
    return child;
  }
  createEl(
    tag: string,
    options?: { cls?: string; text?: string; attr?: Record<string, string> }
  ): ElementStub {
    const child = this.add(new ElementStub(tag), options);
    child.textContent = options?.text ?? "";
    for (const [name, value] of Object.entries(options?.attr ?? {}))
      child.setAttribute(name, value);
    return child;
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  addEventListener(type: string, callback: (event: any) => void): void {
    this.listeners.set(type, callback);
  }
  dispatch(type: string, event: any): void {
    this.listeners.get(type)?.(event);
  }
  private add(child: ElementStub, options?: { cls?: string }): ElementStub {
    child.className = options?.cls ?? "";
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  find(tag: string): ElementStub | undefined {
    return this.tag === tag ? this : this.children.map((child) => child.find(tag)).find(Boolean);
  }
  findAll(tag: string): ElementStub[] {
    return [
      ...(this.tag === tag ? [this] : []),
      ...this.children.flatMap((child) => child.findAll(tag)),
    ];
  }
  allText(): string {
    return [this.textContent, ...this.children.map((child) => child.allText())].join(" ");
  }
}

describe("V1 note views", () => {
  it("runs Lente through the native retrieval runnable and renders note links/status", async () => {
    const invoke = vi.fn(async () => ({
      documents: [
        new Document({ id: "", pageContent: "not a result", metadata: {} }),
        new Document({ id: "", pageContent: "not a result", metadata: {} }),
        new Document({ id: "", pageContent: "not a result", metadata: {} }),
        new Document({
          id: "notes/result.md",
          pageContent: "private excerpt",
          metadata: { path: "notes/result.md", score: 0.99, semanticScore: 0.7345 },
        }),
      ],
      status: {
        mode: "hybrid" as const,
        degraded: false,
      },
    }));
    const app = {
      workspace: { openLinkText: vi.fn(), trigger: vi.fn() },
      vault: { getFileByPath: () => ({ stat: { mtime: 1_750_000_000_000 } }) },
    };
    const leaf = { app, hoverPopover: null };
    const view = Object.assign(new LenteView(leaf as any, { invoke } as any), {
      contentEl: new ElementStub(),
    });
    await view.onOpen();
    const root = view.contentEl as unknown as ElementStub;
    const input = root.find("input")!;
    input.value = "search query";
    input.dispatch("keydown", { key: "Enter", isComposing: false, preventDefault: vi.fn() });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(root.allText()).toContain("1 result"));
    expect(root.allText()).toContain("1 result");
    const links = root.findAll("a");
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe("result");
    expect(links[0].className).toContain("tree-item-inner");
    expect(links[0].className).toContain("trama-note-result__title");
    const result = root
      .findAll("div")
      .find((element) => element.className === "tree-item search-result is-collapsed")!;
    const resultGroup = result.parentElement?.parentElement;
    expect(resultGroup?.className).toBe("trama-note-results");
    expect(resultGroup?.children.map((child) => child.className)).toEqual([
      "search-results-info",
      "search-result-container mod-global-search trama-lente__rows",
    ]);
    expect(resultGroup?.children[0].children[0].className).toBe("search-results-result-count");
    expect(result.children[0].className).toBe(
      "tree-item-self search-result-file-title is-clickable"
    );
    const toggle = result.children[0].children[0];
    expect(toggle.tag).toBe("button");
    expect(toggle.className).toContain("clickable-icon");
    expect(toggle.className).toContain("tree-item-icon");
    expect(toggle.attributes.type).toBe("button");
    expect(toggle.attributes["aria-expanded"]).toBe("false");
    expect(toggle.attributes["data-icon"]).toBe("right-triangle");
    expect(toggle.className).toContain("is-collapsed");
    expect(toggle.attributes["data-tooltip"]).toBe("Expand note details");
    expect(result.children[0].children[1]).toBe(links[0]);
    const metadata = result.children[1];
    expect(metadata.className).toBe("search-result-file-matches");
    expect(metadata.hidden).toBe(true);
    expect(metadata.children[0].className).toBe("search-result-file-match");
    expect(metadata.children[0].children[0].textContent).toBe("notes/result.md");
    expect(metadata.children[0].children[1].className).toBe(
      "setting-item-description trama-result-date"
    );
    expect(metadata.children[0].children.map((child) => child.textContent)).toEqual([
      "notes/result.md",
      expect.stringContaining("Edited"),
    ]);
    expect(root.allText()).not.toContain("Relevance:");
    expect(root.allText()).not.toContain("Similarity:");
    expect(result.className).toContain("search-result");
    expect(result.className).toContain("is-collapsed");
    const hoverEvent = { type: "mouseover" } as MouseEvent;
    links[0].dispatch("mouseover", hoverEvent);
    expect(app.workspace.trigger).toHaveBeenCalledWith("hover-link", {
      event: hoverEvent,
      source: "trama-results",
      hoverParent: leaf,
      targetEl: links[0],
      linktext: "notes/result.md",
    });
    toggle.dispatch("mouseover", hoverEvent);
    toggle.dispatch("click", {});
    expect(app.workspace.trigger).toHaveBeenCalledOnce();
    expect(metadata.hidden).toBe(false);
    expect(result.className).not.toContain("is-collapsed");
    expect(toggle.attributes["aria-expanded"]).toBe("true");
    expect(toggle.attributes["aria-label"]).toBe("Collapse note details");
    expect(toggle.attributes["data-icon"]).toBe("right-triangle");
    expect(toggle.className).not.toContain("is-collapsed");
    expect(toggle.attributes["data-tooltip"]).toBe("Collapse note details");
    toggle.dispatch("click", {});
    expect(metadata.hidden).toBe(true);
    expect(result.className).toContain("is-collapsed");
    expect(toggle.attributes["data-icon"]).toBe("right-triangle");
    expect(toggle.className).toContain("is-collapsed");
    expect(root.allText()).toContain("Edited");
    expect(
      root
        .findAll("div")
        .some((element) => element.attributes["aria-label"]?.startsWith("Last edited "))
    ).toBe(true);
    expect(root.findAll("pre")).toHaveLength(0);
    links[0].dispatch("click", { preventDefault: vi.fn(), metaKey: false, ctrlKey: false });
    expect(app.workspace.openLinkText).toHaveBeenCalledWith("notes/result.md", "", false);
  });

  it("omits missing and non-finite result scores", () => {
    const app = { workspace: { trigger: vi.fn() }, vault: { getFileByPath: () => null } };
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, "0.5"]) {
      const parent = new ElementStub();
      const row = appendNoteResultRow(
        parent as unknown as HTMLElement,
        app as any,
        "notes/result.md",
        {} as any,
        vi.fn(),
        value
      );
      const details = (row as unknown as ElementStub).children[1];
      expect(details.children[0].children.map((child) => child.textContent)).toEqual([
        "notes/result.md",
      ]);
    }
  });

  it("labels similarity at the qualitative score boundaries", () => {
    const app = { workspace: { trigger: vi.fn() }, vault: { getFileByPath: () => null } };
    const cases = [
      [0.85, "Very high"],
      [0.7, "High"],
      [0.5, "Medium"],
      [0.3, "Low"],
      [0.2999, "Very low"],
    ] as const;
    for (const [value, label] of cases) {
      const row = appendNoteResultRow(
        new ElementStub() as unknown as HTMLElement,
        app as any,
        "notes/result.md",
        {} as any,
        vi.fn(),
        value
      ) as unknown as ElementStub;
      expect(row.children[1].children[0].children[1].textContent).toBe(`Similarity: ${label}`);
    }
  });

  it("omits ratings for lexical-only Lente results", async () => {
    const invoke = vi.fn(async () => ({
      documents: [
        new Document({
          id: "notes/lexical.md",
          pageContent: "lexical result",
          metadata: { path: "notes/lexical.md", score: 0.99 },
        }),
      ],
      status: {
        mode: "lexical" as const,
        degraded: true,
        degradationReason: "semantic-unavailable" as const,
      },
    }));
    const app = {
      workspace: { openLinkText: vi.fn(), trigger: vi.fn() },
      vault: { getFileByPath: () => ({ stat: { mtime: 1_750_000_000_000 } }) },
    };
    const view = Object.assign(new LenteView({ app } as any, { invoke } as any), {
      contentEl: new ElementStub(),
    });
    await view.onOpen();
    const root = view.contentEl as unknown as ElementStub;
    const input = root.find("input")!;
    input.value = "needle";
    input.dispatch("keydown", { key: "Enter", isComposing: false, preventDefault: vi.fn() });
    await vi.waitFor(() => expect(root.findAll("a")).toHaveLength(1));
    root
      .findAll("div")
      .find((element) => element.className === "tree-item search-result is-collapsed")!
      .children[0].children[0].dispatch("click", {});
    expect(root.allText()).toContain("notes/lexical.md");
    expect(root.allText()).toContain("Edited");
    expect(root.allText()).not.toContain("Relevance:");
    expect(root.allText()).not.toContain("Similarity:");
    view.onClose();
  });

  it("clears stale Lente hits while a refresh races an older pending search", async () => {
    let resolveOld!: (result: any) => void;
    let resolveFresh!: (result: any) => void;
    const invoke = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFresh = resolve)));
    const app = {
      workspace: { openLinkText: vi.fn() },
      vault: { getFileByPath: () => null },
    };
    const view = Object.assign(new LenteView({ app } as any, { invoke } as any), {
      contentEl: new ElementStub(),
    });
    await view.onOpen();
    const root = view.contentEl as unknown as ElementStub;
    const input = root.find("input")!;
    input.value = "needle";
    input.dispatch("keydown", { key: "Enter", isComposing: false, preventDefault: vi.fn() });
    expect(invoke).toHaveBeenCalledTimes(1);
    view.refreshSubmitted();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(root.findAll("a")).toHaveLength(0);
    resolveOld({
      documents: [
        new Document({ id: "stale.md", pageContent: "stale", metadata: { path: "stale.md" } }),
      ],
      status: { mode: "lexical", degraded: false },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(root.findAll("a")).toHaveLength(0);
    resolveFresh({ documents: [], status: { mode: "lexical", degraded: false } });
    await vi.waitFor(() => expect(root.allText()).toContain("No matching notes found."));
    view.onClose();
  });

  it("removes old Voce suggestions immediately while a new active-note lookup is pending", async () => {
    let activePath = "notes/old.md";
    let activeLeafChange!: () => void;
    let resolveNew!: (paths: readonly string[]) => void;
    let lookupCount = 0;
    const app = {
      workspace: {
        getActiveFile: () => ({ path: activePath }),
        on: (_event: string, callback: () => void) => {
          activeLeafChange = callback;
          return { unsubscribe: vi.fn() };
        },
      },
    };
    const state = { turns: [], running: false };
    const session = {
      subscribe: (callback: (value: typeof state) => void) => {
        callback(state);
        return vi.fn();
      },
      getState: () => state,
      reset: vi.fn(),
    };
    const catalog = () => [
      "notes/old.md",
      "notes/old-related.md",
      "notes/new.md",
      "notes/new-related.md",
    ];
    const view = Object.assign(
      new VoceView(
        { app } as any,
        session as any,
        catalog,
        () => [activePath],
        undefined,
        async () => {
          lookupCount++;
          if (lookupCount === 1) return ["notes/old-related.md"];
          return new Promise((resolve) => (resolveNew = resolve));
        }
      ),
      { contentEl: new ElementStub() }
    );
    await view.onOpen();
    const root = view.contentEl as unknown as ElementStub;
    await vi.waitFor(() =>
      expect(
        root
          .findAll("button")
          .some((button) => button.attributes["aria-label"] === "Include notes/old-related.md")
      ).toBe(true)
    );
    activePath = "notes/new.md";
    activeLeafChange();
    expect(
      root
        .findAll("button")
        .some((button) => button.attributes["aria-label"] === "Include notes/old.md")
    ).toBe(false);
    expect(
      root
        .findAll("button")
        .some((button) => button.attributes["aria-label"] === "Include notes/old-related.md")
    ).toBe(false);
    expect(
      root
        .findAll("button")
        .some((button) => button.attributes["aria-label"] === "Include notes/new.md")
    ).toBe(true);
    resolveNew(["notes/new-related.md"]);
    await vi.waitFor(() =>
      expect(
        root
          .findAll("button")
          .some((button) => button.attributes["aria-label"] === "Include notes/new-related.md")
      ).toBe(true)
    );
    await view.onClose();
  });

  it("opens persisted related results before update and refreshes once when indexing completes", async () => {
    const app = {
      vault: { getFileByPath: () => ({ stat: { mtime: 1_750_000_000_000 } }) },
      workspace: {
        getActiveFile: () => ({ path: "notes/source.md" }),
        on: () => ({ unsubscribe: vi.fn() }),
        openLinkText: vi.fn(),
      },
    };
    const related = vi.fn(async () => ({
      documents: [
        new Document({
          id: "notes/related.md",
          pageContent: "private related passage",
          metadata: { path: "notes/related.md", score: -0.12356 },
        }),
      ],
      available: true,
    }));
    const status = new IndexStatusController();
    status.setStatus({
      kind: "index-required",
      canIndex: true,
      canReindex: true,
      canCancel: false,
    });
    const view = Object.assign(new FiloView({ app } as any, status, { related } as any), {
      contentEl: new ElementStub(),
    });
    const root = view.contentEl as unknown as ElementStub;
    await view.onOpen();
    await vi.waitFor(() => expect(related).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(root.findAll("a")).toHaveLength(1));
    expect(related).toHaveBeenCalledWith("notes/source.md", expect.any(AbortSignal), 20);
    expect(root.findAll("a")[0].textContent).toBe("related");
    expect(root.allText()).toContain("1 related note");
    expect(root.findAll("a")[0].className).toContain("trama-note-result__title");
    const group = root
      .findAll("div")
      .find((element) => element.className === "trama-note-results")!;
    expect(group.children.map((child) => child.className)).toEqual([
      "search-results-info",
      "search-result-container mod-global-search trama-filo__rows",
    ]);
    expect(group.children[0].children[0].className).toBe("search-results-result-count");
    expect(root.allText()).toContain("Edited");
    expect(root.allText()).not.toContain("private related passage");
    const result = root
      .findAll("div")
      .find((element) => element.className === "tree-item search-result is-collapsed")!;
    result.children[0].children[0].dispatch("click", {});
    expect(root.allText()).toContain("Similarity: Very low");
    status.setStatus({ kind: "building", canIndex: false, canReindex: false, canCancel: true });
    status.setStatus({ kind: "ready", canIndex: true, canReindex: true, canCancel: false });
    await vi.waitFor(() => expect(related).toHaveBeenCalledTimes(2));
    view.onClose();

    const reloaded = Object.assign(new FiloView({ app } as any, status, { related } as any), {
      contentEl: new ElementStub(),
    });
    await reloaded.onOpen();
    await vi.waitFor(() => expect(related).toHaveBeenCalledTimes(3));
    reloaded.onClose();
  });

  it("renders live edit dates for modal suggestions and skips missing files", () => {
    const app = {
      vault: {
        getFileByPath: (path: string) =>
          path === "notes/existing.md" ? { stat: { mtime: 1_750_000_000_000 } } : null,
      },
    };
    const modal = new LenteSearchModal(app as any, { invoke: vi.fn() } as any);
    const existing = new ElementStub();
    modal.renderSuggestion(
      { path: "notes/existing.md", title: "existing" },
      existing as unknown as HTMLElement
    );
    expect(existing.allText()).toContain("Edited");
    expect(
      existing
        .findAll("div")
        .some((element) => element.attributes["aria-label"]?.startsWith("Last edited "))
    ).toBe(true);

    const missing = new ElementStub();
    modal.renderSuggestion(
      { path: "notes/missing.md", title: "missing" },
      missing as unknown as HTMLElement
    );
    expect(missing.allText()).not.toContain("Edited");
  });

  it("refreshes Lente modal suggestions for each query and ignores stale or closed requests", async () => {
    let resolveA!: (value: any) => void;
    let resolveB!: (value: any) => void;
    let resolveC!: (value: any) => void;
    const invoke = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveA = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveB = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveC = resolve)));
    const app = { workspace: { openLinkText: vi.fn() } };
    const modal = new LenteSearchModal(app as any, { invoke } as any);
    modal.onOpen();
    expect((modal as any).instructions).toBeUndefined();

    modal.inputEl.value = "A";
    const requestA = modal.getSuggestions("A");
    modal.inputEl.value = "B";
    const requestB = modal.getSuggestions("B");
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0][1].signal.aborted).toBe(true);

    resolveB({
      documents: [
        new Document({ id: "notes/B.md", pageContent: "", metadata: { path: "notes/B.md" } }),
      ],
      status: { mode: "hybrid", degraded: false },
    });
    await expect(requestB).resolves.toEqual([{ path: "notes/B.md", title: "B" }]);
    resolveA({
      documents: [
        new Document({ id: "notes/A.md", pageContent: "", metadata: { path: "notes/A.md" } }),
      ],
      status: { mode: "hybrid", degraded: false },
    });
    await expect(requestA).resolves.toEqual([]);

    modal.inputEl.value = "  ";
    await expect(modal.getSuggestions("  ")).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(2);

    modal.inputEl.value = "C";
    const requestC = modal.getSuggestions("C");
    modal.onClose();
    resolveC({
      documents: [
        new Document({ id: "notes/C.md", pageContent: "", metadata: { path: "notes/C.md" } }),
      ],
      status: { mode: "hybrid", degraded: false },
    });
    await expect(requestC).resolves.toEqual([]);
    expect(app.workspace.openLinkText).not.toHaveBeenCalled();
  });

  it("shows native empty-state text when Lente modal search fails and keeps Enter selection behavior", async () => {
    const app = { workspace: { openLinkText: vi.fn() } };
    const modal = new LenteSearchModal(
      app as any,
      {
        invoke: vi.fn().mockRejectedValue(new Error("offline")),
      } as any
    );
    modal.onOpen();
    modal.inputEl.value = "query";
    await expect(modal.getSuggestions("query")).resolves.toEqual([]);
    expect(modal.emptyStateText).toBe("Search failed.");
    modal.onChooseSuggestion({ path: "notes/result.md", title: "result" }, {
      ctrlKey: true,
    } as KeyboardEvent);
    expect(app.workspace.openLinkText).toHaveBeenCalledWith("notes/result.md", "", true);
    modal.onClose();
  });
});
