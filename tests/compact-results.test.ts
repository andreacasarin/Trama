import { describe, expect, it, vi } from "vitest";
import { similarityLabel } from "@/ui/noteResultRow";
import { LenteSearchModal } from "@/ui/lente/LenteSearchModal";

function element(): any {
  const node: any = {
    children: [],
    listeners: new Map(),
    addEventListener(name: string, handler: unknown) {
      this.listeners.set(name, handler);
    },
    textContent: "",
    setAttribute() {},
    isConnected: true,
    parentElement: null,
    classList: { add() {} },
    empty() {
      this.children = [];
    },
    createDiv(options: any = {}) {
      return this.add(options);
    },
    createEl(tag: string, options: any = {}) {
      const child = this.add(options);
      child.tagName = tag;
      return child;
    },
    createSpan(options: any = {}) {
      return this.add(options);
    },
    add(options: any) {
      const child = element();
      child.textContent = options.text ?? "";
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
  };
  return node;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("compact result presentation", () => {
  it("uses the existing qualitative levels only for finite scores", () => {
    expect(similarityLabel(0.8)).toBe("High");
    expect(similarityLabel(0)).toBe("Very low");
    expect(similarityLabel(-0.1)).toBe("Very low");
    expect(similarityLabel(0.85)).toBe("Very high");
    expect(similarityLabel(0.7)).toBe("High");
    expect(similarityLabel(0.5)).toBe("Medium");
    expect(similarityLabel(0.3)).toBe("Low");
    expect(similarityLabel(NaN, 1)).toBe("Similarity unavailable");
    expect(similarityLabel(Infinity, 1)).toBe("Similarity unavailable");
    expect(similarityLabel(undefined)).toBe("Similarity unavailable");
    expect(similarityLabel(null, 0)).toBe("Keyword match");
    expect(similarityLabel(undefined, -1)).toBe("Keyword match");
    expect(similarityLabel(undefined, Infinity)).toBe("Similarity unavailable");
  });
  it("quotes only genuine passages and preserves their literal text", async () => {
    const source = {
      searchCandidates: vi.fn(async () => ({
        status: {},
        hits: [
          {
            path: "a.md",
            lexicalScore: 0.1,
            evidence: { uid: "u", profile: "p", startOffset: 0, endOffset: 10 },
          },
          {
            path: "b.md",
            score: 0.9,
            evidence: { uid: "u", profile: "p", startOffset: 0, endOffset: 10 },
          },
        ],
      })),
      searchEvidence: vi.fn(async (hit: any) =>
        hit.path === "a.md"
          ? { kind: "passage", text: "# Heading\n\n[[Link]]" }
          : { kind: "changed" }
      ),
    };
    const modal = new LenteSearchModal(
      { vault: { getFileByPath: () => ({}) } } as any,
      source as any
    );
    modal.onOpen();
    modal.inputEl.value = "query";
    modal.getSuggestions("query");
    await tick();
    const results = modal.getSuggestions("query");
    const passage = element(),
      status = element();
    modal.renderSuggestion(results[0], passage);
    modal.renderSuggestion(results[1], status);
    await tick();
    expect(passage.children[0].children[1].textContent).toBe("Keyword match");
    expect(status.children[0].children[1].textContent).toBe("Similarity unavailable");
    expect(passage.children[1].children[0].tagName).toBe("blockquote");
    expect(passage.children[1].children[0].textContent).toBe("# Heading\n\n[[Link]]");
    expect(status.children[1].children).toHaveLength(0);
    expect(status.children[1].textContent).toContain("Note changed");
    modal.onClose();
  });
  it("uses semantic score, serializes evidence, shares rerenders, and cancels stale work", async () => {
    let release!: (value: any) => void;
    const evidence = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          release = resolve;
        })
    );
    const source = {
      searchCandidates: vi.fn(async () => ({
        status: {},
        hits: [
          {
            path: "a.md",
            score: 0.01,
            semanticScore: 0.8,
            evidence: { uid: "u", profile: "p", startOffset: 0, endOffset: 10 },
          },
          {
            path: "b.md",
            score: 1,
            semanticScore: 0,
            evidence: { uid: "u", profile: "p", startOffset: 0, endOffset: 10 },
          },
        ],
      })),
      searchEvidence: evidence,
    };
    const modal = new LenteSearchModal(
      { vault: { getFileByPath: () => ({}) } } as any,
      source as any
    );
    modal.onOpen();
    modal.inputEl.value = "query";
    expect(modal.getSuggestions("query")).toEqual([]);
    await tick();
    const suggestions = modal.getSuggestions("query");
    const first = element(),
      second = element(),
      repeated = element();
    modal.renderSuggestion(suggestions[0], first);
    modal.renderSuggestion(suggestions[1], second);
    modal.renderSuggestion(suggestions[0], repeated);
    await tick();
    expect(first.children[0].children[1].textContent).toBe("High");
    expect(second.children[0].children[1].textContent).toBe("Very low");
    expect(evidence).toHaveBeenCalledTimes(1);
    release({ kind: "passage", text: "literal passage" });
    await tick();
    expect(first.children[1].children[0].textContent).toBe("literal passage");
    expect(repeated.children[1].children[0].textContent).toBe("literal passage");
    expect(evidence).toHaveBeenCalledTimes(2);
    modal.inputEl.value = "";
    await modal.getSuggestions("");
    release({ kind: "passage", text: "old" });
    await tick();
    expect(second.children[1].textContent).toBe("Loading preview…");
    modal.onClose();
  });
});

it("loads literal Lente passages on expansion and discards an aborted response", async () => {
  const { LenteView } = await import("@/ui/lente/LenteView");
  const rowModule = await import("@/ui/noteResultRow");
  let disclosure!: (expanded: boolean, metadata: HTMLElement) => void;
  const row = vi.spyOn(rowModule, "appendNoteResultRow").mockImplementation((...args) => {
    expect(args[5]).toBe(0.8);
    disclosure = args[6]!;
    return {} as HTMLDivElement;
  });
  const releases: Array<(value: any) => void> = [];
  const source = {
    searchEvidence: vi.fn(
      (_hit: unknown, _signal: AbortSignal) =>
        new Promise<any>((resolve) => {
          releases.push(resolve);
        })
    ),
  };
  const app = { vault: { getFileByPath: () => ({}) }, workspace: {} };
  const view: any = new LenteView({ app } as any, source as any);
  view.status = element();
  view.rows = element();
  view.resultsCount = element();
  view.output = {
    hits: [
      {
        path: "a.md",
        score: 0.01,
        semanticScore: 0.8,
        evidence: { uid: "u", profile: "p", startOffset: 0, endOffset: 10 },
      },
    ],
    status: {},
  };
  view.submitted = "query";
  const metadata = element();
  try {
    view.render();
    expect(source.searchEvidence).not.toHaveBeenCalled();
    disclosure(true, metadata);
    expect(source.searchEvidence).toHaveBeenCalledOnce();
    const signal = source.searchEvidence.mock.calls[0][1] as AbortSignal;
    const oldSlot = metadata.children[0];
    disclosure(false, metadata);
    expect(signal.aborted).toBe(true);
    disclosure(true, metadata);
    releases[0]({ kind: "passage", text: "old" });
    await tick();
    expect(oldSlot.textContent).toBe("Loading preview…");
    expect(source.searchEvidence).toHaveBeenCalledTimes(2);
    releases[1]({ kind: "passage", text: "# Literal [[link]]" });
    await tick();
    const quote = metadata.children[0].children[1];
    expect(quote.tagName).toBe("blockquote");
    expect(quote.textContent).toBe("# Literal [[link]]");
    expect(quote.children).toHaveLength(0);
    expect(quote.listeners.size).toBe(0);
  } finally {
    row.mockRestore();
  }
});

it("offers lazy disclosure for keyword results and Filo rows", async () => {
  const { LenteView } = await import("@/ui/lente/LenteView");
  const { FiloView } = await import("@/ui/filo/FiloView");
  const { IndexStatusController } = await import("@/ui/index/IndexStatus");
  const rowModule = await import("@/ui/noteResultRow");
  const row = vi.spyOn(rowModule, "appendNoteResultRow").mockReturnValue({} as HTMLDivElement);
  const openLinkText = vi.fn();
  const app = { vault: { getFileByPath: () => ({}) }, workspace: { openLinkText } };
  const lente: any = new LenteView({ app } as any, {} as any);
  lente.status = element();
  lente.rows = element();
  lente.resultsCount = element();
  lente.output = { hits: [{ path: "a.md", lexicalScore: 1 }], status: {} };
  const context = vi.fn(async () => ({ kind: "preview" as const, text: "literal [[body]]" }));
  const filo: any = new FiloView({ app } as any, new IndexStatusController(), {
    related: vi.fn(),
    searchEvidence: context,
  });
  filo.contentEl = element();
  filo.activePath = "source.md";
  filo.available = true;
  filo.hits = [{ path: "b.md", score: 0.8 }];
  try {
    lente.render();
    filo.render();
    expect(row.mock.calls.map((args) => typeof args[6])).toEqual(["function", "function"]);
    expect(context).not.toHaveBeenCalled();
    const metadata = element();
    row.mock.calls[1][6]!(true, metadata);
    await tick();
    expect(context).toHaveBeenCalledOnce();
    expect(metadata.children[0].children[0].textContent).toBe("Preview");
    expect(metadata.children[0].children[1].textContent).toBe("literal [[body]]");
    row.mock.calls[0][4]({ ctrlKey: true } as MouseEvent);
    row.mock.calls[1][4]({ ctrlKey: true } as MouseEvent);
    expect(openLinkText).toHaveBeenNthCalledWith(1, "a.md", "", true);
    expect(openLinkText).toHaveBeenNthCalledWith(2, "b.md", "source.md", true);
  } finally {
    row.mockRestore();
  }
});

it("refreshes the native picker once per current query and ignores stale or closed completions", async () => {
  const pending: Array<{
    query: string;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }> = [];
  const searchCandidates = vi.fn(
    (input: { query: string }) =>
      new Promise<any>((resolve, reject) => pending.push({ query: input.query, resolve, reject }))
  );
  const modal = new LenteSearchModal(
    { vault: { getFileByPath: () => ({}) } } as any,
    { searchCandidates, searchEvidence: vi.fn() } as any
  );
  const dispatch = vi.spyOn(modal.inputEl, "dispatchEvent");
  modal.onOpen();
  modal.inputEl.value = "old";
  modal.getSuggestions("old");
  modal.inputEl.value = "new";
  modal.getSuggestions("new");
  pending[1].resolve({ status: {}, hits: [{ path: "new.md", score: 1 }] });
  await tick();
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(modal.getSuggestions("new")).toHaveLength(1);
  expect(modal.getSuggestions("new")).toHaveLength(1);
  expect(searchCandidates).toHaveBeenCalledTimes(2);
  pending[0].resolve({ status: {}, hits: [] });
  await tick();
  expect(dispatch).toHaveBeenCalledTimes(1);
  modal.inputEl.value = "empty";
  modal.getSuggestions("empty");
  pending[2].resolve({ status: {}, hits: [] });
  await tick();
  expect(modal.emptyStateText).toBe("No matching notes found.");
  expect(dispatch).toHaveBeenCalledTimes(2);
  modal.getSuggestions("empty");
  expect(searchCandidates).toHaveBeenCalledTimes(3);
  modal.inputEl.value = "failed";
  modal.getSuggestions("failed");
  pending[3].reject(new Error("failed"));
  await tick();
  expect(modal.emptyStateText).toBe("Search failed.");
  expect(dispatch).toHaveBeenCalledTimes(3);
  modal.getSuggestions("failed");
  expect(searchCandidates).toHaveBeenCalledTimes(4);
  modal.inputEl.value = "cleared";
  modal.getSuggestions("cleared");
  modal.inputEl.value = "";
  modal.getSuggestions("");
  pending[4].resolve({ status: {}, hits: [] });
  await tick();
  expect(dispatch).toHaveBeenCalledTimes(3);
  modal.inputEl.value = "closed";
  modal.getSuggestions("closed");
  modal.onClose();
  pending[5].resolve({ status: {}, hits: [] });
  await tick();
  expect(dispatch).toHaveBeenCalledTimes(3);
});

it("uses native modal title hover and disposes previews on query change and close", async () => {
  const trigger = vi.fn();
  const app = { workspace: { trigger }, vault: { getFileByPath: () => ({}) } };
  const source = {
    searchCandidates: vi.fn(async () => ({
      status: {},
      hits: [{ path: "folder/note.md", score: 1 }],
    })),
    searchEvidence: vi.fn(async () => ({ kind: "unavailable" })),
  };
  const modal = new LenteSearchModal(app as any, source as any);
  modal.onOpen();
  modal.inputEl.value = "one";
  modal.getSuggestions("one");
  await tick();
  const row = element();
  modal.renderSuggestion(modal.getSuggestions("one")[0], row);
  const title = row.children[0].children[0];
  const event = {};
  title.listeners.get("mouseover")(event);
  expect(trigger).toHaveBeenCalledWith("hover-link", {
    event,
    source: "trama-results",
    hoverParent: modal,
    targetEl: title,
    linktext: "folder/note.md",
  });
  const unload = vi.fn();
  modal.hoverPopover = { unload } as any;
  modal.inputEl.value = "two";
  modal.getSuggestions("two");
  expect(unload).toHaveBeenCalledOnce();
  expect(modal.hoverPopover).toBeNull();
  modal.hoverPopover = { unload } as any;
  modal.onClose();
  expect(unload).toHaveBeenCalledTimes(2);
  expect(modal.hoverPopover).toBeNull();
});

it("ignores Filo completions from an earlier visit to the same source", async () => {
  const { FiloView } = await import("@/ui/filo/FiloView");
  const { IndexStatusController } = await import("@/ui/index/IndexStatus");
  const pending: Array<(result: any) => void> = [];
  const source = {
    related: vi.fn(() => new Promise<any>((resolve) => pending.push(resolve))),
    searchEvidence: vi.fn(),
  };
  const view: any = new FiloView(
    { app: { workspace: {} } } as any,
    new IndexStatusController(),
    source
  );
  view.render = vi.fn();
  view.refreshActiveNote("a.md");
  view.refreshActiveNote("b.md");
  view.refreshActiveNote("a.md");
  pending[2]({ hits: [{ path: "new.md", score: 1 }], available: true });
  await tick();
  pending[0]({ hits: [{ path: "old.md", score: 1 }], available: true });
  await tick();
  expect(view.hits[0].path).toBe("new.md");
  await view.onClose();
  pending[1]({ hits: [{ path: "late.md", score: 1 }], available: true });
  await tick();
  expect(view.hits[0].path).toBe("new.md");
});
