import { AbstractInputSuggest, prepareFuzzySearch } from "obsidian";
import type { App } from "obsidian";
import type { SkillCommand } from "@/chat/TemplateReferences";
import { skillCommandReference } from "@/chat/TemplateReferences";

interface InlineTrigger {
  readonly kind: "note" | "skill";
  readonly start: number;
  readonly caret: number;
  readonly query: string;
  readonly text: string;
  readonly generation: number;
}

type InlineSuggestion =
  | { readonly kind: "note"; readonly path: string }
  | { readonly kind: "skill"; readonly command: SkillCommand };

/** Plain-text contenteditable adapter; the DOM remains the only draft store. */
export class VoceComposer {
  constructor(readonly element: HTMLDivElement) {}

  get value(): string {
    return this.element.innerText.replace(/\r/g, "");
  }

  set value(value: string) {
    this.element.textContent = value;
    this.setSelectionRange(value.length, value.length);
  }

  get selectionStart(): number {
    return this.selection().start;
  }

  get selectionEnd(): number {
    return this.selection().end;
  }

  focus(): void {
    this.element.focus();
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    this.element.addEventListener(type, listener);
  }

  setSelectionRange(start: number, end: number): void {
    if (typeof document === "undefined") {
      (this.element as any).setSelectionRange?.(start, end);
      return;
    }
    const [startNode, startOffset] = this.pointAt(start);
    const [endNode, endOffset] = this.pointAt(end);
    const range = document.createRange();
    range.setStart(startNode, Math.min(startOffset, startNode.textContent?.length ?? 0));
    range.setEnd(endNode, Math.min(endOffset, endNode.textContent?.length ?? 0));
    const selection = this.element.ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  replaceRange(start: number, end: number, replacement: string): void {
    if (typeof document === "undefined") {
      const text = this.value;
      this.value = `${text.slice(0, start)}${replacement}${text.slice(end)}`;
      this.setSelectionRange(start + replacement.length, start + replacement.length);
      return;
    }
    const range = this.rangeAt(start, end);
    range.deleteContents();
    const inserted = document.createTextNode(replacement);
    range.insertNode(inserted);
    range.setStartAfter(inserted);
    range.collapse(true);
    const selection = this.element.ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  private selection(): { start: number; end: number } {
    const fallback = this.value.length;
    if (typeof document === "undefined") {
      const input = this.element as any;
      const start = input.selectionStart ?? fallback;
      const end = input.selectionEnd ?? fallback;
      return { start: Math.min(start, end), end: Math.max(start, end) };
    }
    const selection = this.element.ownerDocument.getSelection();
    if (!selection?.anchorNode || !this.element.contains(selection.anchorNode))
      return { start: fallback, end: fallback };
    const offset = (node: Node, position: number): number => {
      const range = document.createRange();
      range.selectNodeContents(this.element);
      range.setEnd(node, position);
      return range.toString().length;
    };
    const anchor = offset(selection.anchorNode, selection.anchorOffset);
    const focus = offset(selection.focusNode ?? selection.anchorNode, selection.focusOffset);
    return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
  }

  private rangeAt(start: number, end: number): Range {
    const range = document.createRange();
    const [startNode, startOffset] = this.pointAt(start);
    const [endNode, endOffset] = this.pointAt(end);
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  }

  private pointAt(target: number): [Node, number] {
    const walker = document.createTreeWalker(this.element, NodeFilter.SHOW_TEXT);
    let remaining = target;
    let node = walker.nextNode();
    while (node) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) return [node, remaining];
      remaining -= length;
      node = walker.nextNode();
    }
    return [this.element, this.element.childNodes.length];
  }
}

/** Obsidian owns the popup, keyboard navigation, and placement. */
export class VoceInlineSuggest extends AbstractInputSuggest<InlineSuggestion> {
  private generation = 0;
  private trigger?: InlineTrigger;
  private openState = false;

  constructor(
    app: App,
    private readonly composer: VoceComposer,
    private readonly notes: () => readonly string[],
    private readonly skills: () => readonly SkillCommand[],
    private readonly onChoose: (suggestion: InlineSuggestion) => void
  ) {
    super(app, composer.element);
  }

  get hasOpenSuggestions(): boolean {
    return this.openState;
  }

  invalidate(): void {
    this.generation++;
    this.trigger = undefined;
    this.close();
  }

  override close(): void {
    this.openState = false;
    this.trigger = undefined;
    super.close();
  }

  protected getSuggestions(_query: string): InlineSuggestion[] {
    const trigger = this.findTrigger();
    if (!trigger) {
      this.openState = false;
      this.trigger = undefined;
      return [];
    }
    this.trigger = { ...trigger, generation: this.generation };
    const search = trigger.query ? prepareFuzzySearch(trigger.query) : undefined;
    const matches = <T>(items: readonly T[], label: (item: T) => string): T[] =>
      items
        .map((item) => ({ item, result: search?.(label(item)) }))
        .filter((match) => !search || Boolean(match.result))
        .sort((left, right) => (right.result?.score ?? 0) - (left.result?.score ?? 0))
        .map(({ item }) => item);
    const suggestions =
      trigger.kind === "note"
        ? matches(this.notes(), (path) => path).map((path) => ({ kind: "note" as const, path }))
        : matches(
            this.skills(),
            (command) => `${command.alias ?? ""} ${command.path} ${command.description ?? ""}`
          ).map((command) => ({ kind: "skill" as const, command }));
    this.openState = suggestions.length > 0;
    return suggestions;
  }

  renderSuggestion(suggestion: InlineSuggestion, element: HTMLElement): void {
    element.setText(
      suggestion.kind === "note" ? suggestion.path : `/${suggestion.command.alias ?? "?"}`
    );
    if (suggestion.kind === "skill" && suggestion.command.description)
      element.createDiv({
        cls: "setting-item-description trama-voce__skill-description",
        text: suggestion.command.description,
      });
  }

  override selectSuggestion(suggestion: InlineSuggestion, event: MouseEvent | KeyboardEvent): void {
    const trigger = this.trigger;
    if (
      !trigger ||
      trigger.generation !== this.generation ||
      trigger.text !== this.composer.value
    ) {
      this.close();
      return;
    }
    if (suggestion.kind === "skill" && (!suggestion.command.alias || suggestion.command.issue)) {
      this.close();
      this.onChoose(suggestion);
      event.preventDefault();
      return;
    }
    const replacement =
      suggestion.kind === "note"
        ? `${suggestion.path}${trigger.text.slice(trigger.caret).startsWith("]]") ? "" : "]]"}`
        : skillCommandReference(suggestion.command);
    const start = suggestion.kind === "note" ? trigger.start + 2 : trigger.start;
    this.composer.replaceRange(start, trigger.caret, replacement);
    this.close();
    this.onChoose(suggestion);
    event.preventDefault();
  }

  private findTrigger(): Omit<InlineTrigger, "generation"> | undefined {
    const text = this.composer.value;
    const caret = this.composer.selectionStart;
    const end = this.composer.selectionEnd;
    if (caret !== end) return undefined;
    const before = text.slice(0, caret);
    const noteStart = before.lastIndexOf("[[");
    if (noteStart >= 0 && text.indexOf("]]", noteStart + 2) < 0) {
      return {
        kind: "note",
        start: noteStart,
        caret,
        query: before.slice(noteStart + 2),
        text,
      };
    }
    const slash = before.match(/(?:^|\s)\/([a-z0-9-]*)$/i);
    if (slash && !/^[a-z0-9-]/i.test(text.slice(caret))) {
      const start = caret - slash[0].length + (slash[0][0] === "/" ? 0 : 1);
      return { kind: "skill", start, caret, query: slash[1], text };
    }
    return undefined;
  }
}
