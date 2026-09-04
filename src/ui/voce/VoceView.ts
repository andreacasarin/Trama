import {
  App,
  Component,
  FuzzySuggestModal,
  ItemView,
  Keymap,
  MarkdownRenderer,
  setIcon,
  setTooltip,
  WorkspaceLeaf,
} from "obsidian";
import { AssistantConversationTurn, CHAT_LIMITS, ChatSession, ChatState } from "@/chat/ChatSession";
import { removeNoteReference, resolveNoteReferences } from "@/chat/NoteReferences";
import { ProvenanceRecord } from "@/domain/contracts";

export const VOCE_VIEW_TYPE = "trama-voce";
const COLLAPSIBLE_MESSAGE_LENGTH = 600;

interface AssistantTurnAction {
  readonly icon: string;
  readonly label: string;
  run(): Promise<void>;
}

function errorMessage(error: ChatState["error"]): string {
  if (!error) return "";
  switch (error.code) {
    case "cancelled":
      return "Stopped before the answer finished. You can keep editing and send again.";
    case "limit_exceeded":
      return `${error.message} Attach fewer notes or shorten the request, then try again.`;
    case "unavailable":
      return `${error.message} Check LM Studio, then try again.`;
    case "busy":
      return "Voce is already working on a message. Stop it or wait for it to finish.";
    case "invalid_request":
      return error.message;
    default:
      return `${error.message} Try again.`;
  }
}

export function provenanceLabel(record: ProvenanceRecord): string {
  const hasRange = record.startLine !== undefined || record.endLine !== undefined;
  return hasRange
    ? `${record.path} (lines ${record.startLine ?? record.endLine}-${record.endLine ?? record.startLine})`
    : record.path;
}

class AttachmentPickerModal extends FuzzySuggestModal<string> {
  constructor(
    app: App,
    private readonly items: () => readonly string[],
    private readonly onChoosePath: (path: string) => void
  ) {
    super(app);
    this.setPlaceholder("Attach a visible note");
  }

  getItems(): string[] {
    return [...this.items()];
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string): void {
    this.onChoosePath(item);
    this.close();
  }
}

/** Native Obsidian view for Voce's clean user-visible conversation projection. */
export class VoceView extends ItemView {
  private unsubscribe: (() => void) | undefined;
  private root!: HTMLDivElement;
  private transcript!: HTMLDivElement;
  private feedback!: HTMLDivElement;
  private attachments!: HTMLDivElement;
  private input!: HTMLTextAreaElement;
  private actionButton!: HTMLButtonElement;
  private markdownComponent?: Component;
  private activeAttachmentPicker?: AttachmentPickerModal;
  private selectedAttachmentPaths: string[] = [];
  private readonly expandedTurnIds = new Set<string>();
  private localError?: string;
  private attachmentPickerGeneration = 0;
  private isViewOpen = false;

  constructor(
    leaf: WorkspaceLeaf,
    private session: ChatSession,
    private readonly noteCatalog: () => readonly string[] = () => [],
    private readonly noteSuggestions: () => readonly string[] = () => [],
    private readonly copyText: (content: string) => Promise<void> = (content) =>
      navigator.clipboard.writeText(content)
  ) {
    super(leaf);
  }

  /** Rebinds an open view after settings replace the session graph. */
  setSession(session: ChatSession): void {
    this.unsubscribe?.();
    this.session = session;
    this.expandedTurnIds.clear();
    this.unsubscribe = this.session.subscribe((state) => this.render(state));
  }

  getViewType(): string {
    return VOCE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Voce";
  }

  override onOpen(): Promise<void> {
    this.isViewOpen = true;
    this.contentEl.empty();
    this.root = this.contentEl.createDiv({ cls: "trama-voce" });
    this.root.createEl("h2", { text: "Voce", cls: "trama-voce__title" });
    this.transcript = this.root.createDiv({ cls: "trama-voce__transcript" });
    this.transcript.addEventListener("click", (event) => this.openInternalLink(event));
    this.feedback = this.root.createDiv({ cls: "trama-voce__feedback" });
    const composer = this.root.createDiv({ cls: "trama-voce__composer" });
    this.attachments = composer.createDiv({ cls: "trama-voce__context" });
    const composeRow = composer.createDiv({ cls: "trama-voce__compose-row" });
    this.input = composeRow.createEl("textarea", {
      cls: "trama-voce__input",
      attr: { rows: "3", "aria-label": "Message" },
    });
    this.input.addEventListener("input", () => {
      this.localError = undefined;
      this.syncAttachmentsFromInput();
      this.renderAttachments();
      this.renderFeedback(this.session.getState());
    });
    this.input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (!this.session.getState().running) void this.submit();
        return;
      }
      if (this.shouldOpenAttachmentPicker(event)) {
        event.preventDefault();
        this.openAttachmentPicker();
      }
    });
    this.actionButton = composeRow.createEl("button", {
      cls: "trama-icon-button trama-voce__action",
      attr: { type: "button" },
    });
    this.actionButton.addEventListener("click", () => {
      if (this.session.getState().running) {
        this.session.cancel();
        return;
      }
      void this.submit();
    });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.renderAttachments()));
    this.unsubscribe = this.session.subscribe((state) => this.render(state));
    return Promise.resolve();
  }

  override onClose(): Promise<void> {
    this.isViewOpen = false;
    this.attachmentPickerGeneration++;
    this.activeAttachmentPicker?.close();
    this.activeAttachmentPicker = undefined;
    if (this.markdownComponent) this.removeChild(this.markdownComponent);
    this.markdownComponent = undefined;
    this.session.cancel();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    return Promise.resolve();
  }

  private shouldOpenAttachmentPicker(event: KeyboardEvent): boolean {
    return event.key === "@" && !event.ctrlKey && !event.metaKey && !event.altKey;
  }

  private openAttachmentPicker(): void {
    this.localError = undefined;
    if (this.selectedAttachmentPaths.length >= CHAT_LIMITS.maxAttachments) {
      this.localError = `You can attach up to ${CHAT_LIMITS.maxAttachments} notes.`;
      this.renderFeedback(this.session.getState());
      return;
    }
    const available = this.availableAttachmentPaths();
    if (!available.length) {
      this.localError = "No additional visible Markdown notes are available to attach.";
      this.renderFeedback(this.session.getState());
      return;
    }
    const generation = ++this.attachmentPickerGeneration;
    const picker = new AttachmentPickerModal(
      this.app,
      () => this.availableAttachmentPaths(),
      (path) => {
        if (!this.isViewOpen || generation !== this.attachmentPickerGeneration) return;
        this.insertNoteReference(path);
        this.localError = undefined;
        this.renderFeedback(this.session.getState());
        this.input.focus();
      }
    );
    const closePicker = picker.close.bind(picker);
    picker.close = () => {
      closePicker();
      if (this.activeAttachmentPicker === picker) this.activeAttachmentPicker = undefined;
    };
    this.activeAttachmentPicker = picker;
    picker.open();
  }

  private availableAttachmentPaths(): readonly string[] {
    const selected = new Set(this.selectedAttachmentPaths);
    return this.noteCatalog().filter((path) => !selected.has(path));
  }

  private insertNoteReference(path: string): void {
    const start = this.input.selectionStart ?? this.input.value.length;
    const end = this.input.selectionEnd ?? start;
    const before = this.input.value.slice(0, start);
    const after = this.input.value.slice(end);
    const prefix = before && !/\s$/.test(before) ? " " : "";
    const suffix = after && !/^\s/.test(after) ? " " : "";
    const insertion = `${prefix}[[${path}]]${suffix}`;
    this.input.value = `${before}${insertion}${after}`;
    const caret = before.length + insertion.length;
    this.input.setSelectionRange(caret, caret);
    this.syncAttachmentsFromInput();
    this.renderAttachments();
  }

  private syncAttachmentsFromInput(): void {
    this.selectedAttachmentPaths = [
      ...resolveNoteReferences(this.input.value, this.noteCatalog()).paths,
    ];
  }

  private async submit(): Promise<void> {
    const content = this.input.value;
    const references = resolveNoteReferences(content, this.noteCatalog());
    if (references.issues.length) {
      const issue = references.issues[0];
      this.localError =
        issue.reason === "ambiguous"
          ? `The note link [[${issue.target}]] is ambiguous. Choose its full vault path.`
          : `The note link [[${issue.target}]] does not match a visible Markdown note.`;
      this.renderFeedback(this.session.getState());
      return;
    }
    const attachmentPaths = [...references.paths];
    const state = this.session.getState();
    if (state.running) return;
    this.localError = undefined;
    this.renderFeedback(state);
    const session = this.session;
    try {
      const pendingSend = session.send({ content, attachmentPaths });
      this.input.value = "";
      this.selectedAttachmentPaths = [];
      this.renderAttachments();
      await pendingSend;
    } catch (error) {
      if (this.session === session)
        this.localError = error instanceof Error ? error.message : "Message could not be sent.";
    }
    this.render(this.session.getState());
  }

  private render(state: ChatState): void {
    if (this.markdownComponent) this.removeChild(this.markdownComponent);
    this.markdownComponent = this.addChild(new Component());
    this.transcript.empty();
    for (const turn of state.turns) {
      const row = this.transcript.createDiv({
        cls: [
          "trama-voce__turn-row",
          turn.role === "user" ? "trama-voce__turn-row--user" : "trama-voce__turn-row--assistant",
        ],
      });
      const bubble = row.createDiv({
        cls: [
          "trama-voce__bubble",
          turn.role === "user" ? "trama-voce__bubble--user" : "trama-voce__bubble--assistant",
        ],
      });
      const isCollapsible =
        !(turn.role === "assistant" && turn.status === "working") &&
        turn.content.length > COLLAPSIBLE_MESSAGE_LENGTH;
      const isExpanded = this.expandedTurnIds.has(turn.id);
      const sourcePath = this.turnSourcePath(turn);
      const message = bubble.createDiv({
        cls: [
          "trama-voce__message",
          "markdown-rendered",
          isCollapsible && !isExpanded ? "trama-voce__message--collapsed" : "",
        ],
        attr: { "data-source-path": sourcePath },
      });
      if (turn.role === "assistant" && turn.status === "working") message.setText("Working...");
      else
        void MarkdownRenderer.render(
          this.app,
          turn.content,
          message,
          sourcePath,
          this.markdownComponent
        );
      if (isCollapsible) this.renderExpandAction(bubble, turn.id, isExpanded);
      if (turn.role === "assistant" && turn.provenance.length)
        this.renderSources(bubble, turn as AssistantConversationTurn);
      if (turn.role === "assistant" && turn.status === "complete")
        this.renderAssistantActions(bubble, turn as AssistantConversationTurn);
    }
    this.renderAttachments();
    this.renderFeedback(state);
    this.updateActionButton(state.running);
  }

  private turnSourcePath(turn: ChatState["turns"][number]): string {
    return turn.role === "user"
      ? (turn.attachments[0]?.path ?? "")
      : (turn.provenance[0]?.path ?? "");
  }

  private openInternalLink(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    const link = target?.closest?.("a.internal-link") as HTMLAnchorElement | null;
    const linkText = link?.getAttribute("data-href");
    if (!link || !linkText) return;
    event.preventDefault();
    event.stopPropagation();
    const sourcePath =
      link.closest<HTMLElement>(".trama-voce__message")?.getAttribute("data-source-path") ?? "";
    void this.app.workspace
      .openLinkText(linkText, sourcePath, Keymap.isModEvent(event))
      .catch((error) => {
        this.localError = error instanceof Error ? error.message : "Note could not be opened.";
        this.renderFeedback(this.session.getState());
      });
  }

  private renderSources(parent: HTMLDivElement, turn: AssistantConversationTurn): void {
    const sources = parent.createDiv({ cls: "trama-voce__sources" });
    sources.createDiv({ cls: "trama-voce__sources-label", text: "Sources" });
    for (const note of turn.provenance)
      this.renderInternalLink(sources, note.path, provenanceLabel(note), "trama-voce__chip");
  }

  private renderInternalLink(
    parent: HTMLDivElement,
    path: string,
    label: string,
    cls: string
  ): void {
    parent.createEl("a", {
      cls: `internal-link ${cls}`,
      text: label,
      attr: { href: path, "data-href": path },
    });
  }

  private renderAttachments(): void {
    this.attachments.empty();
    const selected = new Set(this.selectedAttachmentPaths);
    const suggestions = [
      ...new Set(this.noteSuggestions().filter((path) => this.noteCatalog().includes(path))),
    ];
    const paths = [
      ...suggestions,
      ...this.selectedAttachmentPaths.filter((path) => !suggestions.includes(path)),
    ];
    for (const path of paths) {
      const isSelected = selected.has(path);
      const button = this.attachments.createEl("button", {
        cls: [
          "trama-button",
          "trama-voce__context-tag",
          isSelected ? "trama-voce__context-tag--selected" : "",
        ],
        text: this.noteLabel(path),
        attr: {
          type: "button",
          "aria-label": `${isSelected ? "Remove" : "Include"} ${path}`,
          "aria-pressed": String(isSelected),
        },
      });
      setTooltip(button, `${isSelected ? "Remove" : "Include"} [[${path}]]`);
      button.addEventListener("click", () => {
        if (isSelected) {
          this.input.value = removeNoteReference(this.input.value, path, this.noteCatalog());
          this.syncAttachmentsFromInput();
          this.renderAttachments();
          this.localError = undefined;
        } else if (this.selectedAttachmentPaths.length >= CHAT_LIMITS.maxAttachments) {
          this.localError = `You can attach up to ${CHAT_LIMITS.maxAttachments} notes.`;
        } else {
          this.insertNoteReference(path);
          this.localError = undefined;
        }
        this.renderFeedback(this.session.getState());
        this.input.focus();
      });
    }
    const addButton = this.attachments.createEl("button", {
      cls: "trama-icon-button trama-voce__context-add",
      attr: { type: "button", "aria-label": "Choose note" },
    });
    setIcon(addButton, "plus");
    setTooltip(addButton, "Choose note");
    addButton.addEventListener("click", () => this.openAttachmentPicker());
  }

  private noteLabel(path: string): string {
    const basename = path.slice(path.lastIndexOf("/") + 1);
    return basename.toLowerCase().endsWith(".md") ? basename.slice(0, -3) : basename;
  }

  private assistantActions(turn: AssistantConversationTurn): readonly AssistantTurnAction[] {
    return [
      {
        icon: "copy",
        label: "Copy response",
        run: () => this.copyText(turn.content),
      },
    ];
  }

  private renderAssistantActions(parent: HTMLDivElement, turn: AssistantConversationTurn): void {
    const actions = parent.createDiv({ cls: "trama-voce__message-actions" });
    for (const action of this.assistantActions(turn)) {
      const button = actions.createEl("button", {
        cls: "trama-icon-button trama-voce__message-action",
        attr: { type: "button", "aria-label": action.label },
      });
      setIcon(button, action.icon);
      setTooltip(button, action.label);
      button.addEventListener("click", () => {
        void action.run().catch((error) => {
          this.localError =
            error instanceof Error ? error.message : "Response could not be copied.";
          this.renderFeedback(this.session.getState());
        });
      });
    }
  }

  private renderExpandAction(parent: HTMLDivElement, turnId: string, isExpanded: boolean): void {
    const button = parent.createEl("button", {
      cls: "trama-button trama-voce__expand",
      text: isExpanded ? "Show less" : "Show more",
      attr: {
        type: "button",
        "aria-expanded": String(isExpanded),
      },
    });
    button.addEventListener("click", () => {
      if (isExpanded) this.expandedTurnIds.delete(turnId);
      else this.expandedTurnIds.add(turnId);
      this.render(this.session.getState());
    });
  }

  private renderFeedback(state: ChatState): void {
    this.feedback.empty();
    const message = this.localError ?? (state.error ? errorMessage(state.error) : undefined);
    if (!message) return;
    this.feedback.createDiv({ cls: "trama-voce__error", text: message });
  }

  private updateActionButton(running: boolean): void {
    setIcon(this.actionButton, running ? "square" : "arrow-up");
    const label = running ? "Stop response" : "Send message";
    this.actionButton.setAttribute("aria-label", label);
    setTooltip(this.actionButton, label);
  }
}
