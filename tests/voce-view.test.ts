import { describe, expect, it, vi } from "vitest";
import { WorkspaceLeaf } from "obsidian";
import type { AssistantConversationTurn, ChatSession, ConversationTurn } from "@/chat/ChatSession";
import { VoceView } from "@/ui/voce/VoceView";
import { VoceComposer, VoceInlineSuggest } from "@/ui/voce/VoceComposer";

/** The small Obsidian element surface used by transcript rendering. */
class ElementStub {
  children: ElementStub[] = [];
  classes = new Set<string>();
  attributes: Record<string, string> = {};
  textContent = "";
  open = false;
  isConnected = true;
  listeners = new Map<string, () => void>();
  classList = {
    toggle: (name: string, enabled: boolean) => {
      if (enabled) this.classes.add(name);
      else this.classes.delete(name);
    },
  };

  get firstElementChild(): ElementStub | undefined {
    return this.children[0];
  }

  createDiv(options?: any): ElementStub {
    return this.createEl("div", options);
  }

  createSpan(options?: any): ElementStub {
    return this.createEl("span", options);
  }

  createEl(_tag: string, options: any = {}): ElementStub {
    const child = new ElementStub();
    const classes = Array.isArray(options.cls) ? options.cls : (options.cls ?? "").split(" ");
    child.classes = new Set(classes);
    child.attributes = options.attr ?? {};
    child.textContent = options.text ?? "";
    this.children.push(child);
    return child;
  }

  empty(): void {
    this.children = [];
  }

  setText(text: string): void {
    this.empty();
    this.textContent = text;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, listener);
  }

  find(className: string): ElementStub | undefined {
    if (this.classes.has(className)) return this;
    for (const child of this.children) {
      const found = child.find(className);
      if (found) return found;
    }
  }
}

function response(id: string, status: AssistantConversationTurn["status"] = "complete") {
  return {
    id,
    role: "assistant",
    content: "Long response. ".repeat(100),
    status,
    sources: [],
    provenance: [],
  } as AssistantConversationTurn;
}

function setup() {
  const copy = vi.fn(async () => {});
  const session = {
    getState: vi.fn(() => ({ turns: [], running: false })),
    send: vi.fn(async (_input: unknown, _onAccepted?: () => void) => {}),
  };
  const view = new VoceView(
    new WorkspaceLeaf(),
    session as unknown as ChatSession,
    undefined,
    undefined,
    copy
  ) as any;
  view.transcript = new ElementStub();
  view.cancelEditButton = { hidden: true };
  view.input = { value: "", focus: vi.fn() };
  view.renderAttachments = vi.fn();
  view.renderFeedback = vi.fn();
  const render = (turns: ConversationTurn[]) => view.renderTranscriptTurns(turns);
  const row = (index: number) => view.transcript.children[index] as ElementStub;
  const collapsed = (index: number) =>
    row(index).find("trama-voce__message")!.classes.has("trama-voce__message--collapsed");
  return { view, session, render, row, collapsed, copy };
}

describe("Voce transcript", () => {
  it("shows a message's creation time beside its action without inventing missing dates", () => {
    const { render, row } = setup();
    const createdAt = new Date("2026-10-27T12:53:00Z").getTime();
    render([
      { id: "user", role: "user", content: "Prompt", attachments: [], createdAt },
      { ...response("answer"), createdAt },
    ]);
    for (let index = 0; index < 2; index++) {
      const actions = row(index).find("trama-voce__message-actions")!;
      const time = actions.find("trama-voce__message-time")!;
      expect(time.attributes.datetime).toBe("2026-10-27T12:53:00.000Z");
      expect(time.attributes.title).toBe(new Date(createdAt).toLocaleString());
      expect(time.textContent).toBe(
        new Date(createdAt).toLocaleString(undefined, {
          weekday: "long",
          hour: "numeric",
          minute: "2-digit",
        })
      );
      expect(actions.children[1].attributes["aria-label"]).toBe(
        index === 0 ? "Edit message" : "Copy response"
      );
    }
    render([response("undated")]);
    expect(row(0).find("trama-voce__message-time")).toBeUndefined();
  });

  it("starts sources collapsed, preserves note links, and remembers opening them across updates", () => {
    const { view, render, row } = setup();
    view.recordTranscriptScrollIntent = vi.fn();
    view.restoreTranscriptPosition = vi.fn();
    const turn = {
      ...response("answer", "working"),
      sources: [{ path: "Notes/Source.md", startLine: 3, endLine: 8 }],
    };
    render([turn]);
    const disclosure = row(0).find("trama-voce__source-disclosure")!;
    expect(disclosure.open).toBe(false);
    expect(disclosure.children[0].textContent).toBe("Sources (1)");
    const link = disclosure.find("trama-voce__chip")!;
    expect(link.attributes["data-href"]).toBe("Notes/Source.md");
    disclosure.open = true;
    disclosure.listeners.get("toggle")!();
    render([{ ...turn, status: "complete" }]);
    const updated = row(0).find("trama-voce__source-disclosure")!;
    expect(updated.open).toBe(true);
    updated.open = false;
    updated.listeners.get("toggle")!();
    render([{ ...turn, status: "complete", content: "Updated answer" }]);
    expect(row(0).find("trama-voce__source-disclosure")!.open).toBe(false);
  });

  it("omits the sources control when a response has no sources", () => {
    const { render, row } = setup();
    render([response("answer")]);
    expect(row(0).find("trama-voce__source-disclosure")).toBeUndefined();
  });

  it("expands the latest response and collapses older responses on initial render", () => {
    const { render, collapsed } = setup();
    render([response("first"), response("latest")]);
    expect(collapsed(0)).toBe(true);
    expect(collapsed(1)).toBe(false);
  });

  it("collapses the previous response when a new one starts, keeping streamed content expanded", () => {
    const { render, collapsed } = setup();
    render([response("first")]);
    expect(collapsed(0)).toBe(false);
    render([response("first"), response("latest", "working")]);
    expect(collapsed(0)).toBe(true);
    expect(collapsed(1)).toBe(false);
    render([response("first"), response("latest")]);
    expect(collapsed(1)).toBe(false);
  });

  it("keeps manual expansion choices when another response arrives", () => {
    const { render, row, collapsed } = setup();
    render([response("first"), response("second")]);
    row(0).find("trama-voce__expand")!.listeners.get("click")!();
    row(1).find("trama-voce__expand")!.listeners.get("click")!();
    render([response("first"), response("second"), response("latest")]);
    expect(collapsed(0)).toBe(false);
    expect(collapsed(1)).toBe(true);
    expect(collapsed(2)).toBe(false);
  });

  it("copies the full response from its action row", () => {
    const { render, row, copy } = setup();
    const turn = response("latest");
    render([turn]);
    const actions = row(0).find("trama-voce__message-actions")!;
    const button = actions.children[0];
    expect(button.attributes["aria-label"]).toBe("Copy response");
    expect(actions.children).toHaveLength(1);
    expect(button.children).toHaveLength(0);
    button.listeners.get("click")!();
    expect(copy).toHaveBeenCalledWith(turn.content);
  });

  it("offers Edit on user messages and restores the original prompt and attachments", () => {
    const { view, session, render, row, copy } = setup();
    const turn: ConversationTurn = {
      id: "user",
      role: "user",
      content: "Summarize [[Notes.md]] with /review",
      attachments: [{ path: "Notes.md" }],
      skill: { path: "Skills/review.md" },
    };
    render([turn, response("answer")]);
    const actions = row(0).find("trama-voce__message-actions")!;
    expect(actions.children).toHaveLength(1);
    const button = actions.children[0];
    expect(button.attributes["aria-label"]).toBe("Edit message");
    expect(button.children).toHaveLength(0);
    button.listeners.get("click")!();
    expect(view.editingTurnId).toBe(turn.id);
    expect(session.send).not.toHaveBeenCalled();
    expect(row(1).find("trama-voce__message")).toBeDefined();
    expect(view.input.value).toBe(turn.content);
    expect(view.selectedAttachmentPaths).toEqual(["Notes.md"]);
    expect(view.input.focus).toHaveBeenCalledOnce();
    expect(copy).not.toHaveBeenCalled();
  });

  it("keeps the draft intact if Edit is clicked during a response", () => {
    const { view, session, render, row } = setup();
    render([{ id: "user", role: "user", content: "Original", attachments: [] }]);
    view.input.value = "Unsent draft";
    session.getState.mockReturnValue({ turns: [], running: true });
    row(0).find("trama-voce__message-action")!.listeners.get("click")!();
    expect(view.input.value).toBe("Unsent draft");
    expect(view.localError).toContain("Stop the current response");
    expect(session.send).not.toHaveBeenCalled();
  });

  it("submits the edit target only when Send is used", async () => {
    const { view, session, render, row } = setup();
    render([
      { id: "user", role: "user", content: "Original", attachments: [] },
      response("answer"),
    ]);
    row(0).find("trama-voce__message-action")!.listeners.get("click")!();
    expect(session.send).not.toHaveBeenCalled();
    view.input.value = "Revised";
    view.render = vi.fn();
    session.send.mockImplementation(async (_input, onAccepted) => {
      session.getState.mockReturnValue({ turns: [], running: true });
      onAccepted?.();
    });
    view.isViewOpen = true;
    await view.submit();
    expect(session.send).toHaveBeenCalledWith(
      {
        content: "Revised",
        attachmentPaths: [],
        skill: undefined,
        editTurnId: "user",
      },
      expect.any(Function)
    );
    expect(view.editingTurnId).toBeUndefined();
    expect(view.input.value).toBe("");
  });

  it.each([false, true])(
    "keeps the draft until acceptance and preserves typing ahead: %s",
    async (typedAhead) => {
      const { view, session } = setup();
      view.isViewOpen = true;
      view.editingTurnId = "original";
      view.input.value = "Revised";
      view.selectedAttachmentPaths = ["note.md"];
      view.render = vi.fn();
      let finish!: () => void;
      let accept!: () => void;
      session.send.mockImplementation(async (_input, onAccepted) => {
        accept = onAccepted!;
        session.getState.mockReturnValue({ turns: [], running: true });
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      });
      const pending = view.submit();
      expect(view.input.value).toBe("Revised");
      expect(view.editingTurnId).toBe("original");
      expect(view.selectedAttachmentPaths).toEqual(["note.md"]);
      finish(); // Simulate failed attachment preflight: no acceptance.
      await pending;
      expect(view.input.value).toBe("Revised");
      expect(view.editingTurnId).toBe("original");
      if (typedAhead) view.input.value = "Next draft";
      accept();
      expect(view.input.value).toBe(typedAhead ? "Next draft" : "");
      expect(view.editingTurnId).toBeUndefined();
      expect(view.selectedAttachmentPaths).toEqual(typedAhead ? ["note.md"] : []);
    }
  );

  it("cancels an edit without sending or removing conversation rows", () => {
    const { view, session, render, row } = setup();
    render([
      { id: "user", role: "user", content: "Original", attachments: [] },
      response("answer"),
    ]);
    row(0).find("trama-voce__message-action")!.listeners.get("click")!();
    view.feedback = new ElementStub();
    view.updateActionButton = vi.fn();
    (VoceView.prototype as any).renderFeedback.call(view, session.getState());
    expect(view.cancelEditButton.hidden).toBe(false);
    expect(view.feedback.children).toHaveLength(0);
    view.cancelEdit();
    expect(view.editingTurnId).toBeUndefined();
    expect(view.input.value).toBe("");
    expect(view.transcript.children).toHaveLength(2);
    expect(session.send).not.toHaveBeenCalled();
    (VoceView.prototype as any).renderFeedback.call(view, session.getState());
    expect(view.cancelEditButton.hidden).toBe(true);
  });
});

describe("Voce skill descriptions", () => {
  const command = {
    path: "Skills/Review.md",
    alias: "review",
    description: "Ground an answer in your notes",
  };

  function suggestions() {
    const composer = {
      value: "/ground",
      selectionStart: 7,
      selectionEnd: 7,
      element: {},
    } as VoceComposer;
    return new VoceInlineSuggest(
      undefined as never,
      composer,
      () => [],
      () => [command],
      vi.fn()
    );
  }

  it("shows the command and description without the skill path", () => {
    const element = new ElementStub();
    suggestions().renderSuggestion({ kind: "skill", command }, element as unknown as HTMLElement);
    expect(element.textContent).toBe("/review");
    expect(element.find("trama-voce__skill-description")!.textContent).toBe(command.description);
  });

  it("can find a skill by its description", () => {
    expect((suggestions() as any).getSuggestions("")).toEqual([{ kind: "skill", command }]);
  });

  it("does not add an empty description to skills without one or to note suggestions", () => {
    const element = new ElementStub();
    const suggest = suggestions();
    suggest.renderSuggestion(
      { kind: "skill", command: { path: command.path, alias: command.alias } },
      element as unknown as HTMLElement
    );
    expect(element.textContent).toBe("/review");
    expect(element.children).toHaveLength(0);
    suggest.renderSuggestion({ kind: "note", path: "Notes.md" }, element as unknown as HTMLElement);
    expect(element.textContent).toBe("Notes.md");
    expect(element.children).toHaveLength(0);
  });
});
