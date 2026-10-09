import { describe, expect, it, vi } from "vitest";
import { Document } from "@langchain/core/documents";
import { LenteView } from "@/ui/lente/LenteView";
import { FiloView } from "@/ui/filo/FiloView";
import { IndexStatusController } from "@/ui/index/IndexStatus";

class ElementStub {
  children: ElementStub[] = [];
  listeners = new Map<string, (event: any) => void>();
  value = "";
  textContent = "";
  className = "";
  constructor(readonly tag = "div") {}
  empty(): void {
    this.children = [];
    this.textContent = "";
  }
  createDiv(options?: { cls?: string }): ElementStub {
    return this.add(new ElementStub("div"), options);
  }
  createEl(tag: string, options?: { cls?: string; text?: string }): ElementStub {
    const child = this.add(new ElementStub(tag), options);
    child.textContent = options?.text ?? "";
    return child;
  }
  addEventListener(type: string, callback: (event: any) => void): void {
    this.listeners.set(type, callback);
  }
  dispatch(type: string, event: any): void {
    this.listeners.get(type)?.(event);
  }
  private add(child: ElementStub, options?: { cls?: string }): ElementStub {
    child.className = options?.cls ?? "";
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
        new Document({
          id: "notes/result.md",
          pageContent: "private excerpt",
          metadata: { path: "notes/result.md" },
        }),
      ],
      status: {
        mode: "lexical" as const,
        degraded: true,
        degradationReason: "semantic-unavailable" as const,
      },
    }));
    const app = { workspace: { openLinkText: vi.fn() } };
    const view = Object.assign(new LenteView({ app } as any, { invoke } as any), {
      contentEl: new ElementStub(),
    });
    await view.onOpen();
    const root = view.contentEl as unknown as ElementStub;
    const input = root.find("input")!;
    input.value = "search query";
    input.dispatch("keydown", { key: "Enter", isComposing: false, preventDefault: vi.fn() });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(root.allText()).toContain("Lexical results"));
    const links = root.findAll("a");
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe("result");
    expect(root.findAll("pre")).toHaveLength(0);
    links[0].dispatch("click", { preventDefault: vi.fn(), metaKey: false, ctrlKey: false });
    expect(app.workspace.openLinkText).toHaveBeenCalledWith("notes/result.md", "", false);
  });

  it("opens persisted related results before update and refreshes once when indexing completes", async () => {
    const app = {
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
          metadata: { path: "notes/related.md" },
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
    expect(related).toHaveBeenCalledWith("notes/source.md", expect.any(AbortSignal), 7);
    expect(root.findAll("a")[0].textContent).toBe("related");
    expect(root.allText()).not.toContain("private related passage");
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
});
