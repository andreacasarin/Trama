import { describe, expect, it, vi } from "vitest";
import { FuzzySuggestModal, WorkspaceLeaf } from "obsidian";
import { ChatSession, ChatState, SendTurnInput } from "@/chat/ChatSession";
import { VoceView, provenanceLabel } from "@/ui/voce/VoceView";

interface TestElement {
  readonly children: TestElement[];
  readonly classes: Set<string>;
  textContent: string;
  value: string;
  click(): void;
  dispatch(type: string, event?: Record<string, unknown>): { defaultPrevented: boolean };
  getAttribute(name: string): string | null;
}

interface TestModal {
  choose(item: string): void;
  getItems(): string[];
  close(): void;
}

interface SessionDouble {
  readonly session: ChatSession;
  readonly send: ReturnType<typeof vi.fn>;
  readonly cancel: ReturnType<typeof vi.fn>;
  push(state: ChatState): void;
}

function makeSession(initial: ChatState, sendImpl?: (input: SendTurnInput) => Promise<ChatState>) {
  let state = initial;
  const listeners = new Set<(next: ChatState) => void>();
  const send = vi.fn(
    sendImpl ??
      (async () => {
        return state;
      })
  );
  const cancel = vi.fn();
  const session = {
    subscribe(listener: (next: ChatState) => void) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    getState() {
      return state;
    },
    send,
    cancel,
  } as unknown as ChatSession;
  return {
    session,
    send,
    cancel,
    push(next: ChatState) {
      state = next;
      for (const listener of listeners) listener(state);
    },
  } satisfies SessionDouble;
}

function walk(root: TestElement, predicate: (node: TestElement) => boolean): TestElement[] {
  const matches: TestElement[] = [];
  if (predicate(root)) matches.push(root);
  for (const child of root.children) matches.push(...walk(child, predicate));
  return matches;
}

function textOf(node: TestElement): string {
  return [node.textContent, ...node.children.map(textOf)].join(" ").replace(/\s+/g, " ").trim();
}

function byClass(root: TestElement, cls: string): TestElement[] {
  return walk(root, (node) => node.classes.has(cls));
}

function byAttribute(root: TestElement, name: string, value?: string): TestElement[] {
  return walk(root, (node) => {
    const attribute = node.getAttribute(name);
    return attribute !== null && (value === undefined || attribute === value);
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function triggerAt(input: TestElement) {
  return input.dispatch("keydown", { key: "@", ctrlKey: false, metaKey: false, altKey: false });
}

function fakeLeaf(openLinkText = vi.fn().mockResolvedValue(undefined)): WorkspaceLeaf {
  return {
    app: { workspace: { on: () => ({}), openLinkText } },
  } as unknown as WorkspaceLeaf;
}

function lastOpenedModal(): TestModal {
  return (FuzzySuggestModal as unknown as { lastOpened?: TestModal }).lastOpened!;
}

describe("VoceView module", () => {
  describe("provenanceLabel()", () => {
    it("formats source ranges only when a line range is present", () => {
      expect(provenanceLabel({ path: "Notes/Alpha.md" })).toBe("Notes/Alpha.md");
      expect(provenanceLabel({ path: "Notes/Alpha.md", startLine: 3, endLine: 6 })).toBe(
        "Notes/Alpha.md (lines 3-6)"
      );
    });
  });

  describe("VoceView", () => {
    describe("onOpen()", () => {
      it("renders typed turns as bubbles, hides in-flight assistant payloads, and wires the stop button accessibly", async () => {
        const subject = makeSession({
          turns: [
            {
              id: "turn-1",
              role: "user",
              content: "Where is this mentioned?",
              attachments: [{ path: "Projects/Plan.md", truncated: true }],
            },
            {
              id: "turn-2",
              role: "assistant",
              content: `tool payload that should stay hidden ${"x".repeat(601)}`,
              provenance: [{ path: "Projects/Plan.md", startLine: 4, endLine: 8 }],
              status: "working",
            },
          ],
          running: true,
        });
        const view = new VoceView(fakeLeaf(), subject.session, () => []);

        await view.onOpen();

        const root = view.contentEl as unknown as TestElement;
        expect(textOf(root)).toContain("Where is this mentioned?");
        expect(byClass(root, "trama-voce__chip--attachment")).toHaveLength(0);
        expect(textOf(root)).toContain("Working...");
        expect(textOf(root)).toContain("Sources");
        expect(textOf(root)).toContain("Projects/Plan.md (lines 4-8)");
        expect(textOf(root)).not.toContain("tool payload that should stay hidden");
        expect(walk(root, (node) => node.textContent === "Show more")).toHaveLength(0);
        expect(byClass(root, "trama-voce__turn-row--user")).toHaveLength(1);
        expect(byClass(root, "trama-voce__turn-row--assistant")).toHaveLength(1);
        const button = byClass(root, "trama-voce__action")[0];
        expect(button.getAttribute("data-icon")).toBe("square");
        expect(button.getAttribute("aria-label")).toBe("Stop response");
        expect(button.getAttribute("title")).toBe("Stop response");

        button.click();

        expect(subject.cancel).toHaveBeenCalledTimes(1);
      });

      it("sends structured input, clears the submitted composer immediately, and preserves later typing", async () => {
        let resolveSend!: (value: ChatState) => void;
        const pendingSend = new Promise<ChatState>((resolve) => {
          resolveSend = resolve;
        });
        const subject = makeSession({ turns: [], running: false }, async () => pendingSend);
        const view = new VoceView(fakeLeaf(), subject.session, () => ["Alpha.md"]);

        await view.onOpen();

        const root = view.contentEl as unknown as TestElement;
        const input = byClass(root, "trama-voce__input")[0];
        const button = byClass(root, "trama-voce__action")[0];
        triggerAt(input);
        lastOpenedModal().choose("Alpha.md");
        input.value = "hello [[Alpha.md]]";

        button.click();
        await flush();

        expect(subject.send).toHaveBeenCalledWith({
          content: "hello [[Alpha.md]]",
          attachmentPaths: ["Alpha.md"],
        });
        expect(input.value).toBe("");
        expect(byAttribute(root, "aria-pressed", "true")).toHaveLength(0);

        input.value = "edited while waiting";
        resolveSend({ turns: [], running: false });
        await flush();

        expect(input.value).toBe("edited while waiting");
        expect(byAttribute(root, "aria-pressed", "true")).toHaveLength(0);
      });

      it("keeps the stop action active during attachment preflight and invokes cancel", async () => {
        const subject = makeSession({ turns: [], running: false });
        const view = new VoceView(fakeLeaf(), subject.session, () => []);

        await view.onOpen();

        subject.push({ turns: [], running: true });

        const root = view.contentEl as unknown as TestElement;
        const button = byClass(root, "trama-voce__action")[0];
        expect(button.getAttribute("data-icon")).toBe("square");
        expect(button.getAttribute("aria-label")).toBe("Stop response");

        button.click();

        expect(subject.cancel).toHaveBeenCalledTimes(1);
      });

      it("keeps the submitted composer cleared when a resolved send finishes with an error state", async () => {
        const subject = makeSession({ turns: [], running: false }, async () => ({
          turns: [],
          running: false,
          error: { code: "cancelled", message: "stopped" },
        }));
        const view = new VoceView(fakeLeaf(), subject.session, () => ["Alpha.md"]);

        await view.onOpen();

        const root = view.contentEl as unknown as TestElement;
        const input = byClass(root, "trama-voce__input")[0];
        const button = byClass(root, "trama-voce__action")[0];
        triggerAt(input);
        lastOpenedModal().choose("Alpha.md");
        input.value = "hello [[Alpha.md]]";

        button.click();
        await flush();

        expect(input.value).toBe("");
        expect(byAttribute(root, "aria-pressed", "true")).toHaveLength(0);
      });

      it("keeps the submitted composer cleared and shows an actionable session failure", async () => {
        const subject = makeSession({ turns: [], running: false }, async () => {
          subject.push({
            turns: [],
            running: false,
            error: { code: "limit_exceeded", message: "Attached notes exceed the limit." },
          });
          return { turns: [], running: false };
        });
        const view = new VoceView(fakeLeaf(), subject.session, () => ["Alpha.md"]);

        await view.onOpen();

        const root = view.contentEl as unknown as TestElement;
        const input = byClass(root, "trama-voce__input")[0];
        const button = byClass(root, "trama-voce__action")[0];
        triggerAt(input);
        lastOpenedModal().choose("Alpha.md");
        input.value = "hello [[Alpha.md]]";

        button.click();
        await flush();

        expect(input.value).toBe("");
        expect(byAttribute(root, "aria-pressed", "true")).toHaveLength(0);
        expect(textOf(root)).toContain(
          "Attach fewer notes or shorten the request, then try again."
        );
      });

      it("opens a native picker from @, excludes selected notes, and lets chips be removed", async () => {
        const subject = makeSession({ turns: [], running: false });
        const view = new VoceView(fakeLeaf(), subject.session, () => [
          "Alpha.md",
          "Beta.md",
          "Gamma.md",
        ]);

        await view.onOpen();

        const root = view.contentEl as unknown as TestElement;
        const input = byClass(root, "trama-voce__input")[0];
        const firstEvent = triggerAt(input);
        const firstModal = lastOpenedModal();

        expect(firstEvent.defaultPrevented).toBe(true);
        expect(firstModal.getItems()).toEqual(["Alpha.md", "Beta.md", "Gamma.md"]);

        firstModal.choose("Alpha.md");
        expect(input.value).toBe("[[Alpha.md]]");
        expect(byAttribute(root, "aria-label", "Remove Alpha.md")).toHaveLength(1);

        triggerAt(input);
        const secondModal = lastOpenedModal();
        expect(secondModal.getItems()).toEqual(["Beta.md", "Gamma.md"]);
        secondModal.choose("Beta.md");
        expect(input.value).toBe("[[Alpha.md]] [[Beta.md]]");
        expect(byAttribute(root, "aria-label", "Remove Beta.md")).toHaveLength(1);

        byAttribute(root, "aria-label", "Remove Alpha.md")[0].click();
        expect(input.value).toBe("[[Beta.md]]");
        expect(byAttribute(root, "aria-label", "Remove Alpha.md")).toHaveLength(0);
        expect(byAttribute(root, "aria-label", "Remove Beta.md")).toHaveLength(1);
      });

      it("accepts a picker selection after the native modal closes and inserts a visible wikilink", async () => {
        const subject = makeSession({ turns: [], running: false });
        const view = new VoceView(fakeLeaf(), subject.session, () => ["Daily/Today.md"]);

        await view.onOpen();

        const root = view.contentEl as unknown as TestElement;
        const input = byClass(root, "trama-voce__input")[0];
        triggerAt(input);
        const modal = lastOpenedModal();
        modal.close();
        modal.choose("Daily/Today.md");

        expect(input.value).toBe("[[Daily/Today.md]]");
        expect(byAttribute(root, "aria-label", "Remove Daily/Today.md")).toHaveLength(1);
      });

      it("copies each completed assistant response through the reusable action row", async () => {
        const copyText = vi.fn().mockResolvedValue(undefined);
        const subject = makeSession({
          turns: [
            {
              id: "turn-2",
              role: "assistant",
              content: "First answer",
              provenance: [],
              status: "complete",
            },
            {
              id: "turn-4",
              role: "assistant",
              content: "Second answer",
              provenance: [],
              status: "complete",
            },
          ],
          running: false,
        });
        const view = new VoceView(
          fakeLeaf(),
          subject.session,
          () => [],
          () => [],
          copyText
        );

        await view.onOpen();

        const root = view.contentEl as unknown as TestElement;
        const copyButtons = byAttribute(root, "aria-label", "Copy response");
        expect(copyButtons).toHaveLength(2);
        expect(copyButtons[0].getAttribute("data-icon")).toBe("copy");
        copyButtons[0].click();
        copyButtons[1].click();
        await flush();

        expect(copyText).toHaveBeenNthCalledWith(1, "First answer");
        expect(copyText).toHaveBeenNthCalledWith(2, "Second answer");
      });

      it("parses manually typed wikilinks into deterministic attachments", async () => {
        const subject = makeSession({ turns: [], running: false });
        const view = new VoceView(fakeLeaf(), subject.session, () => ["Daily/Today.md"]);

        await view.onOpen();

        const root = view.contentEl as unknown as TestElement;
        const input = byClass(root, "trama-voce__input")[0];
        input.value = "Summarize [[Today]].";
        input.dispatch("input");
        byClass(root, "trama-voce__action")[0].click();
        await flush();

        expect(subject.send).toHaveBeenCalledWith({
          content: "Summarize [[Today]].",
          attachmentPaths: ["Daily/Today.md"],
        });
      });

      it("blocks unresolved wikilinks instead of silently sending without their context", async () => {
        const subject = makeSession({ turns: [], running: false });
        const view = new VoceView(fakeLeaf(), subject.session, () => ["Daily/Today.md"]);

        await view.onOpen();

        const root = view.contentEl as unknown as TestElement;
        const input = byClass(root, "trama-voce__input")[0];
        input.value = "Summarize [[Missing]].";
        byClass(root, "trama-voce__action")[0].click();
        await flush();

        expect(subject.send).not.toHaveBeenCalled();
        expect(textOf(root)).toContain(
          "The note link [[Missing]] does not match a visible Markdown note."
        );
      });

      it("uses Obsidian Markdown rendering for clickable prompt and response links", async () => {
        const openLinkText = vi.fn().mockResolvedValue(undefined);
        const subject = makeSession({
          turns: [
            {
              id: "turn-1",
              role: "user",
              content: "Read [[Daily/Today.md]].",
              attachments: [{ path: "Daily/Today.md" }],
            },
            {
              id: "turn-2",
              role: "assistant",
              content: "Continue with [[Weekly/Plan.md]].",
              provenance: [{ path: "Daily/Today.md" }],
              status: "complete",
            },
          ],
          running: false,
        });
        const view = new VoceView(fakeLeaf(openLinkText), subject.session);

        await view.onOpen();

        const root = view.contentEl as unknown as TestElement;
        const messages = byClass(root, "trama-voce__message");
        expect(byClass(messages[0], "internal-link")[0].getAttribute("data-href")).toBe(
          "Daily/Today.md"
        );
        expect(byClass(messages[1], "internal-link")[0].getAttribute("data-href")).toBe(
          "Weekly/Plan.md"
        );
        expect(messages[0].getAttribute("data-source-path")).toBe("Daily/Today.md");
        expect(messages[1].getAttribute("data-source-path")).toBe("Daily/Today.md");
        const source = byClass(byClass(root, "trama-voce__sources")[0], "internal-link")[0];
        expect(source.getAttribute("data-href")).toBe("Daily/Today.md");

        const transcript = byClass(root, "trama-voce__transcript")[0];
        transcript.dispatch("click", {
          target: byClass(messages[1], "internal-link")[0],
          metaKey: true,
        });
        transcript.dispatch("click", { target: source });
        await flush();

        expect(openLinkText).toHaveBeenNthCalledWith(1, "Weekly/Plan.md", "Daily/Today.md", true);
        expect(openLinkText).toHaveBeenNthCalledWith(2, "Daily/Today.md", "", false);
      });

      it("collapses long messages until the reader expands them", async () => {
        const subject = makeSession({
          turns: [
            {
              id: "turn-1",
              role: "assistant",
              content: "A".repeat(601),
              provenance: [],
              status: "complete",
            },
          ],
          running: false,
        });
        const view = new VoceView(fakeLeaf(), subject.session);

        await view.onOpen();

        const root = view.contentEl as unknown as TestElement;
        expect(byClass(root, "trama-voce__message--collapsed")).toHaveLength(1);
        const showMore = walk(root, (node) => node.textContent === "Show more")[0];
        expect(showMore.getAttribute("aria-expanded")).toBe("false");

        showMore.click();

        expect(byClass(root, "trama-voce__message--collapsed")).toHaveLength(0);
        const showLess = walk(root, (node) => node.textContent === "Show less")[0];
        expect(showLess.getAttribute("aria-expanded")).toBe("true");
      });

      it("sends with Enter while Shift+Enter inserts a newline", async () => {
        const subject = makeSession({ turns: [], running: false });
        const view = new VoceView(fakeLeaf(), subject.session);

        await view.onOpen();

        const root = view.contentEl as unknown as TestElement;
        const input = byClass(root, "trama-voce__input")[0];
        input.value = "Send from keyboard";
        const event = input.dispatch("keydown", {
          key: "Enter",
          shiftKey: false,
          isComposing: false,
        });
        await flush();

        expect(event.defaultPrevented).toBe(true);
        expect(subject.send).toHaveBeenCalledWith({
          content: "Send from keyboard",
          attachmentPaths: [],
        });

        input.value = "Keep writing";
        const shiftEvent = input.dispatch("keydown", {
          key: "Enter",
          shiftKey: true,
          isComposing: false,
        });
        await flush();

        expect(shiftEvent.defaultPrevented).toBe(false);
        expect(subject.send).toHaveBeenCalledTimes(1);
      });

      it("shows compact note suggestions above the textarea and toggles the active note", async () => {
        const subject = makeSession({ turns: [], running: false });
        const view = new VoceView(
          fakeLeaf(),
          subject.session,
          () => ["Daily/Today.md"],
          () => ["Daily/Today.md"]
        );

        await view.onOpen();

        const root = view.contentEl as unknown as TestElement;
        const suggestion = byAttribute(root, "aria-label", "Include Daily/Today.md")[0];
        expect(suggestion.textContent).toBe("Today");
        expect(suggestion.getAttribute("aria-pressed")).toBe("false");
        expect(byAttribute(root, "aria-label", "Choose note")[0].getAttribute("data-icon")).toBe(
          "plus"
        );
        suggestion.click();

        const input = byClass(root, "trama-voce__input")[0];
        expect(input.value).toBe("[[Daily/Today.md]]");
        const selected = byAttribute(root, "aria-label", "Remove Daily/Today.md")[0];
        expect(selected.getAttribute("aria-pressed")).toBe("true");
        selected.click();
        expect(input.value).toBe("");

        byAttribute(root, "aria-label", "Choose note")[0].click();
        expect(lastOpenedModal().getItems()).toEqual(["Daily/Today.md"]);
      });

      it("shows a max-note error instead of opening another picker once eight notes are selected", async () => {
        const notes = Array.from({ length: 9 }, (_, index) => `Note-${index + 1}.md`);
        const subject = makeSession({ turns: [], running: false });
        const view = new VoceView(fakeLeaf(), subject.session, () => notes);

        await view.onOpen();

        const root = view.contentEl as unknown as TestElement;
        const input = byClass(root, "trama-voce__input")[0];
        for (const note of notes.slice(0, 8)) {
          triggerAt(input);
          lastOpenedModal().choose(note);
        }

        const lastModal = lastOpenedModal();
        triggerAt(input);

        expect(lastOpenedModal()).toBe(lastModal);
        expect(textOf(root)).toContain("You can attach up to 8 notes.");
      });
    });

    describe("onClose()", () => {
      it("closes the active picker and ignores late selection from that stale modal", async () => {
        const subject = makeSession({ turns: [], running: false });
        const view = new VoceView(fakeLeaf(), subject.session, () => ["Alpha.md"]);

        await view.onOpen();

        const root = view.contentEl as unknown as TestElement;
        const input = byClass(root, "trama-voce__input")[0];
        triggerAt(input);
        const modal = lastOpenedModal();

        await view.onClose();
        modal.choose("Alpha.md");

        expect(textOf(root)).not.toContain("@Alpha.md");
      });
    });
  });
});
