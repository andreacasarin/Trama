import {
  App,
  ButtonComponent,
  Component,
  FuzzySuggestModal,
  ItemView,
  Keymap,
  MarkdownRenderer,
  setIcon,
  setTooltip,
  WorkspaceLeaf,
} from "obsidian";
import { AssistantConversationTurn, ChatSession, ChatState } from "@/chat/ChatSession";
import { removeNoteReference, resolveNoteReferences } from "@/chat/NoteReferences";
import { resolveSkillCommands, skillBody, type SkillCommand } from "@/chat/TemplateReferences";
import { StructuredError } from "@/domain/errors";
import type { ProvenanceRecord } from "@/domain/vault";
import type { ReadonlyNote } from "@/domain/vault";
import { TRAMA_ICONS } from "@/ui/icons";
import type { IconName } from "obsidian";
import type { ConsoleDebug } from "@/plugin/ConsoleDebug";
import { VoceComposer, VoceInlineSuggest } from "@/ui/voce/VoceComposer";

export const VOCE_VIEW_TYPE = "trama-voce";
const COLLAPSIBLE_MESSAGE_LENGTH = 600;
const TRANSCRIPT_BOTTOM_THRESHOLD = 32;

interface RenderedTurn {
  readonly id: string;
  readonly row: HTMLDivElement;
  markdownComponent?: Component;
}

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
      return `${error.message} Shorten the request and try again.`;
    case "unavailable":
      return `${error.message} Check your configured chat provider, then try again.`;
    case "busy":
      return "Voce is already working on a message. Stop it or wait for it to finish.";
    case "invalid_request":
      return error.message;
    default:
      return `${error.message} Try again.`;
  }
}

function provenanceLabel(record: ProvenanceRecord): string {
  return record.path;
}

function errorCode(error: unknown): string {
  return error instanceof StructuredError ? error.code : "unavailable";
}

class AttachmentPickerModal extends FuzzySuggestModal<string> {
  constructor(
    app: App,
    private readonly items: readonly string[],
    private readonly onChoosePath: (path: string) => void,
    placeholder = "Attach a visible note"
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  getItems(): string[] {
    return [...this.items];
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
  private input!: VoceComposer;
  private inlineSuggest?: VoceInlineSuggest;
  private actionButton!: HTMLButtonElement;
  private readonly renderedTurns: RenderedTurn[] = [];
  private renderedTailSignature?: string;
  private transcriptActivity?: HTMLDivElement;
  private activeAttachmentPicker?: AttachmentPickerModal;
  private selectedAttachmentPaths: string[] = [];
  private readonly expandedTurnIds = new Set<string>();
  private localError?: string;
  private skillResolutionGeneration = 0;
  private skillResolutionAbort?: AbortController;
  private preparingSkill = false;
  private attachmentPickerGeneration = 0;
  private isViewOpen = false;
  private suggestionGeneration = 0;
  private suggestionController?: AbortController;
  private relatedSuggestions: readonly string[] = [];
  private relatedSourcePath?: string;
  private followTranscript = true;
  private desiredTranscriptOffset = 0;
  private lastAppliedTranscriptTop = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private session: ChatSession,
    private readonly noteCatalog: () => readonly string[] = () => [],
    private readonly noteSuggestions: () => readonly string[] = () => [],
    private readonly copyText: (content: string) => Promise<void> = (content) =>
      navigator.clipboard.writeText(content),
    private readonly relatedNoteSuggestions: (
      signal: AbortSignal
    ) => Promise<readonly string[]> = async () => [],
    private readonly consoleDebug?: ConsoleDebug,
    private readonly skillCatalog: () => readonly SkillCommand[] = () => [],
    private readonly readSkill?: (path: string, signal: AbortSignal) => Promise<ReadonlyNote>
  ) {
    super(leaf);
  }

  /** Rebinds an open view after settings replace the session graph. */
  setSession(session: ChatSession): void {
    this.followTranscript = true;
    this.desiredTranscriptOffset = 0;
    if (this.transcript) this.lastAppliedTranscriptTop = this.transcript.scrollTop;
    this.clearTranscriptTurns();
    this.abortSkillResolution();
    this.inlineSuggest?.invalidate();
    this.activeAttachmentPicker?.close();
    this.activeAttachmentPicker = undefined;
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

  getIcon(): IconName {
    return TRAMA_ICONS.voce;
  }

  override onOpen(): Promise<void> {
    this.isViewOpen = true;
    this.followTranscript = true;
    this.desiredTranscriptOffset = 0;
    this.contentEl.empty();
    this.root = this.contentEl.createDiv({ cls: "trama-voce" });
    const header = this.root.createDiv({ cls: "trama-voce__header" });
    header.createEl("h1", { text: "Voce", cls: "trama-voce__title" });
    header
      .createEl("button", {
        cls: "clickable-icon trama-voce__new-chat",
        text: "New chat",
        attr: { type: "button", "aria-label": "New chat" },
      })
      .addEventListener("click", () => this.startNewChat());
    this.transcript = this.root.createDiv({ cls: "trama-voce__transcript" });
    this.lastAppliedTranscriptTop = this.transcript.scrollTop;
    this.transcript.addEventListener("click", (event) => this.openInternalLink(event));
    this.transcript.addEventListener("scroll", () => this.recordTranscriptScrollIntent());
    this.feedback = this.root.createDiv({ cls: "trama-voce__feedback" });
    const composer = this.root.createDiv({ cls: "trama-voce__composer" });
    this.attachments = composer.createDiv({ cls: "trama-voce__context" });
    const composeRow = composer.createDiv({ cls: "trama-voce__compose-row" });
    const input = composeRow.createDiv({ cls: "trama-voce__input" }) as unknown as HTMLDivElement;
    input.contentEditable = "plaintext-only";
    input.setAttribute("role", "textbox");
    input.setAttribute("aria-multiline", "true");
    input.setAttribute("aria-label", "Message");
    input.setAttribute("data-placeholder", "Write a message");
    this.input = new VoceComposer(input);
    this.inlineSuggest = new VoceInlineSuggest(
      this.app,
      this.input,
      () => this.noteCatalog(),
      () => this.skillCatalog(),
      (suggestion) => {
        this.abortSkillResolution();
        this.localError = undefined;
        const catalog = this.noteCatalog();
        if (suggestion.kind === "note") {
          this.syncAttachmentsFromInput(catalog);
          this.renderAttachments(catalog);
        } else if (!suggestion.command.alias || suggestion.command.issue) {
          const command = suggestion.command;
          this.localError =
            command.issue === "duplicate_alias"
              ? `Skill command /${command.alias} is duplicated by ${command.conflictingPaths?.join(", ")}. Give each skill a unique trama-voce-command.`
              : `Skill ${command.path} needs trama-voce-skill: true and a unique lowercase trama-voce-command.`;
        }
        this.renderFeedback(this.session.getState());
      }
    );
    this.input.addEventListener("input", () => {
      this.onComposerInput();
    });
    this.input.addEventListener("paste", (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain");
      if (text === undefined) return;
      event.preventDefault();
      this.input.replaceRange(this.input.selectionStart, this.input.selectionEnd, text);
      this.onComposerInput();
    });
    this.input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.input.replaceRange(this.input.selectionStart, this.input.selectionEnd, "\n");
        this.onComposerInput();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        if (event.defaultPrevented || this.inlineSuggest?.hasOpenSuggestions) return;
        event.preventDefault();
        if (!this.session.getState().running) void this.submit();
        return;
      }
      if (this.shouldOpenAttachmentPicker(event)) {
        event.preventDefault();
        this.openAttachmentPicker();
        return;
      }
    });
    this.actionButton = new ButtonComponent(composeRow).buttonEl;
    this.actionButton.classList.add("clickable-icon", "trama-voce__action");
    this.actionButton.type = "button";
    this.actionButton.addEventListener("click", () => {
      if (this.session.getState().running) {
        this.session.cancel();
        return;
      }
      if (this.preparingSkill) {
        this.abortSkillResolution();
        this.localError = "Skill preparation stopped. Your draft is unchanged.";
        this.renderFeedback(this.session.getState());
        return;
      }
      void this.submit();
    });
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        void this.refreshSuggestions();
        this.renderAttachments();
      })
    );
    void this.refreshSuggestions();
    this.unsubscribe = this.session.subscribe((state) => this.render(state));
    return Promise.resolve();
  }

  override onClose(): Promise<void> {
    this.isViewOpen = false;
    this.abortSkillResolution();
    this.inlineSuggest?.invalidate();
    this.suggestionGeneration++;
    this.suggestionController?.abort();
    this.suggestionController = undefined;
    this.relatedSuggestions = [];
    this.relatedSourcePath = undefined;
    this.attachmentPickerGeneration++;
    this.activeAttachmentPicker?.close();
    this.activeAttachmentPicker = undefined;
    this.clearTranscriptTurns();
    this.session.reset();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    return Promise.resolve();
  }

  private shouldOpenAttachmentPicker(event: KeyboardEvent): boolean {
    return event.key === "@" && !event.ctrlKey && !event.metaKey && !event.altKey;
  }

  private startNewChat(): void {
    this.followTranscript = true;
    this.desiredTranscriptOffset = 0;
    this.lastAppliedTranscriptTop = this.transcript.scrollTop;
    this.clearTranscriptTurns();
    this.abortSkillResolution();
    this.inlineSuggest?.invalidate();
    this.attachmentPickerGeneration++;
    this.activeAttachmentPicker?.close();
    this.activeAttachmentPicker = undefined;
    this.suggestionGeneration++;
    this.suggestionController?.abort();
    this.suggestionController = undefined;
    this.relatedSuggestions = [];
    this.relatedSourcePath = undefined;
    this.input.value = "";
    this.selectedAttachmentPaths = [];
    this.localError = undefined;
    this.expandedTurnIds.clear();
    this.session.reset();
    this.renderAttachments();
    this.input.focus();
  }

  private onComposerInput(): void {
    this.abortSkillResolution();
    this.localError = undefined;
    const catalog = this.noteCatalog();
    this.syncAttachmentsFromInput(catalog);
    this.renderAttachments(catalog);
    this.renderFeedback(this.session.getState());
  }

  private openAttachmentPicker(): void {
    this.localError = undefined;
    const catalog = this.noteCatalog();
    const available = this.availableAttachmentPaths(catalog);
    if (!available.length) {
      this.localError = "No additional visible Markdown notes are available to attach.";
      this.renderFeedback(this.session.getState());
      return;
    }
    const generation = ++this.attachmentPickerGeneration;
    const picker = new AttachmentPickerModal(this.app, available, (path) => {
      if (!this.isViewOpen || generation !== this.attachmentPickerGeneration) return;
      this.insertNoteReference(path, catalog);
      this.localError = undefined;
      this.renderFeedback(this.session.getState());
      this.input.focus();
    });
    const closePicker = picker.close.bind(picker);
    picker.close = () => {
      closePicker();
      if (this.activeAttachmentPicker === picker) this.activeAttachmentPicker = undefined;
    };
    this.activeAttachmentPicker = picker;
    picker.open();
  }

  private availableAttachmentPaths(catalog: readonly string[]): readonly string[] {
    const selected = new Set(this.selectedAttachmentPaths);
    return catalog.filter((path) => !selected.has(path));
  }

  private insertNoteReference(path: string, catalog: readonly string[] = this.noteCatalog()): void {
    this.abortSkillResolution();
    const start = this.input.selectionStart ?? this.input.value.length;
    const end = this.input.selectionEnd ?? start;
    const before = this.input.value.slice(0, start);
    const after = this.input.value.slice(end);
    const prefix = before && !/\s$/.test(before) ? " " : "";
    const suffix = after && !/^\s/.test(after) ? " " : "";
    const insertion = `${prefix}[[${path}]]${suffix}`;
    this.input.replaceRange(start, end, insertion);
    const caret = before.length + insertion.length;
    this.input.setSelectionRange(caret, caret);
    this.syncAttachmentsFromInput(catalog);
    this.renderAttachments(catalog);
  }

  private syncAttachmentsFromInput(catalog: readonly string[] = this.noteCatalog()): void {
    this.selectedAttachmentPaths = [...resolveNoteReferences(this.input.value, catalog).paths];
  }

  private async submit(): Promise<void> {
    if (this.preparingSkill || this.session.getState().running) return;
    const content = this.input.value;
    const skillCatalog = this.skillCatalog();
    const skillRefs = resolveSkillCommands(content, skillCatalog);
    if (skillRefs.issues.length) {
      const issue = skillRefs.issues[0];
      this.localError =
        issue.reason === "duplicate"
          ? `Skill command /${issue.alias} is duplicated by ${issue.paths.join(", ")}. Give each skill a unique trama-voce-command.`
          : `Skill command /${issue.alias} is unavailable. Choose a current skill command.`;
      this.renderFeedback(this.session.getState());
      return;
    }
    if (skillRefs.commands.length > 1) {
      this.localError = "Use one Voce skill command per message.";
      this.renderFeedback(this.session.getState());
      return;
    }
    const noteCatalog = this.noteCatalog();
    const references = resolveNoteReferences(content, noteCatalog);
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
    this.localError = undefined;
    this.renderFeedback(state);
    const session = this.session;
    let skillRead: AbortController | undefined;
    const skillGeneration = ++this.skillResolutionGeneration;
    try {
      let skill: { path: string; content: string } | undefined;
      const command = skillRefs.commands[0];
      if (command) {
        if (!this.readSkill) throw new Error("Voce skill reading is unavailable.");
        this.preparingSkill = true;
        this.render(session.getState());
        skillRead = new AbortController();
        this.skillResolutionAbort = skillRead;
        const note = await this.readSkill(command.path, skillRead.signal);
        if (
          skillRead.signal.aborted ||
          skillGeneration !== this.skillResolutionGeneration ||
          this.skillResolutionAbort !== skillRead ||
          !this.isViewOpen ||
          this.session !== session ||
          this.input.value !== content
        )
          return;
        if (note.truncated)
          throw new Error(`Skill ${note.path} is truncated. Shorten it before use.`);
        if (note.path !== command.path)
          throw new Error(`Skill read returned ${note.path}, not selected source ${command.path}.`);
        const skillContent = skillBody(note.content, command);
        if (!skillContent)
          throw new Error(`Skill ${note.path} is empty. Add instructions and try again.`);
        skill = { path: note.path, content: skillContent };
        this.preparingSkill = false;
      }
      this.followTranscript = true;
      this.lastAppliedTranscriptTop = this.transcript.scrollTop;
      const pendingSend = session.send({ content, attachmentPaths, skill });
      if (session.getState().running) {
        this.input.value = "";
        this.selectedAttachmentPaths = [];
        this.renderAttachments();
      }
      await pendingSend;
    } catch (error) {
      this.consoleDebug?.error("Chat turn setup failed", undefined, {
        errorCode: errorCode(error),
      });
      if (
        !skillRead?.signal.aborted &&
        skillGeneration === this.skillResolutionGeneration &&
        this.session === session &&
        this.input.value === content &&
        this.isViewOpen
      )
        this.localError = error instanceof Error ? error.message : "Message could not be sent.";
    } finally {
      if (skillGeneration === this.skillResolutionGeneration) this.preparingSkill = false;
      if (this.skillResolutionAbort === skillRead) this.skillResolutionAbort = undefined;
    }
    this.render(this.session.getState());
  }

  private abortSkillResolution(): void {
    const wasPreparing = this.preparingSkill;
    this.skillResolutionGeneration++;
    this.skillResolutionAbort?.abort();
    this.skillResolutionAbort = undefined;
    this.preparingSkill = false;
    if (wasPreparing && this.isViewOpen) this.render(this.session.getState());
  }

  private render(state: ChatState): void {
    this.recordTranscriptScrollIntent();
    this.renderTranscriptTurns(state.turns);
    const workingAssistant = state.turns.find(
      (turn) => turn.role === "assistant" && turn.status === "working"
    );
    this.renderTranscriptActivity(this.preparingSkill || (state.running && !workingAssistant));
    this.renderAttachments();
    this.renderFeedback(state);
    this.restoreTranscriptPosition();
  }

  private renderTranscriptTurns(turns: ChatState["turns"]): void {
    const previousLength = this.renderedTurns.length;
    const prefixMatches =
      previousLength <= turns.length &&
      this.renderedTurns.every((rendered, index) => rendered.id === turns[index].id);
    const rebuild = !prefixMatches;
    if (rebuild) this.clearTranscriptTurns();
    const firstNewTurn = rebuild ? 0 : previousLength;
    if (!rebuild && previousLength) {
      const previousTail = this.renderedTurns[previousLength - 1];
      const currentTail = turns[previousLength - 1];
      if (this.renderedTailSignature !== this.turnSignature(currentTail))
        this.updateRenderedTurn(previousTail, currentTail);
    }
    for (let index = firstNewTurn; index < turns.length; index++)
      this.appendRenderedTurn(turns[index]);
  }

  private appendRenderedTurn(turn: ChatState["turns"][number]): void {
    const rendered: RenderedTurn = {
      id: turn.id,
      row: this.transcript.createDiv({
        cls: [
          "trama-voce__turn-row",
          turn.role === "user" ? "trama-voce__turn-row--user" : "trama-voce__turn-row--assistant",
        ],
      }),
    };
    this.renderedTurns.push(rendered);
    this.updateRenderedTurn(rendered, turn);
  }

  private updateRenderedTurn(rendered: RenderedTurn, turn: ChatState["turns"][number]): void {
    if (rendered.markdownComponent) this.removeChild(rendered.markdownComponent);
    const component = this.addChild(new Component());
    rendered.markdownComponent = component;
    this.renderedTailSignature = this.turnSignature(turn);
    rendered.row.empty();
    const bubble = rendered.row.createDiv({
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
    void MarkdownRenderer.render(this.app, turn.content, message, sourcePath, component).then(
      () => {
        if (
          !this.isViewOpen ||
          rendered.markdownComponent !== component ||
          !this.renderedTurns.includes(rendered)
        )
          return;
        this.recordTranscriptScrollIntent();
        this.restoreTranscriptPosition();
      }
    );
    if (turn.role === "assistant" && turn.status === "working" && !turn.content)
      this.renderActivity(bubble);
    if (isCollapsible) this.renderExpandAction(bubble, turn.id, isExpanded, message);
    if (turn.role === "assistant" && turn.sources.length)
      this.renderSources(bubble, turn as AssistantConversationTurn);
    if (turn.role === "user" && turn.skill) {
      const sources = bubble.createDiv({ cls: "trama-voce__sources" });
      sources.createDiv({
        cls: "setting-item-description trama-voce__sources-label",
        text: "Skill",
      });
      this.renderInternalLink(
        sources,
        turn.skill.path,
        turn.skill.path,
        "trama-voce__chip",
        turn.skill.path
      );
    }
    if (turn.role === "assistant" && turn.status === "complete")
      this.renderAssistantActions(bubble, turn as AssistantConversationTurn);
  }

  private turnSignature(turn: ChatState["turns"][number]): string {
    return turn.role === "assistant"
      ? JSON.stringify([turn.id, turn.role, turn.content, turn.status, turn.sources])
      : JSON.stringify([turn.id, turn.role, turn.content, turn.attachments, turn.skill?.path]);
  }

  private clearTranscriptTurns(): void {
    for (const rendered of this.renderedTurns)
      if (rendered.markdownComponent) this.removeChild(rendered.markdownComponent);
    this.renderedTurns.length = 0;
    this.renderedTailSignature = undefined;
    this.transcriptActivity?.remove();
    this.transcriptActivity = undefined;
    if (this.transcript) this.transcript.empty();
  }

  private renderTranscriptActivity(visible: boolean): void {
    this.transcriptActivity?.remove();
    this.transcriptActivity = undefined;
    if (!visible) return;
    this.transcriptActivity = this.transcript.createDiv({ cls: "trama-voce__activity" });
    this.renderActivity(this.transcriptActivity);
  }

  private restoreTranscriptPosition(): void {
    this.transcript.scrollTop = this.followTranscript
      ? this.transcript.scrollHeight
      : this.desiredTranscriptOffset;
    this.lastAppliedTranscriptTop = this.transcript.scrollTop;
  }

  private recordTranscriptScrollIntent(): void {
    const scrollTop = this.transcript.scrollTop;
    const previousTop = this.lastAppliedTranscriptTop;
    if (scrollTop === previousTop) return;
    const maximum = Math.max(0, this.transcript.scrollHeight - this.transcript.clientHeight);
    this.lastAppliedTranscriptTop = scrollTop;
    if (previousTop > maximum && scrollTop === maximum) return;
    this.followTranscript = maximum - scrollTop <= TRANSCRIPT_BOTTOM_THRESHOLD;
    this.desiredTranscriptOffset = scrollTop;
  }

  private renderActivity(parent: HTMLDivElement): void {
    const activity = parent.createDiv({
      cls: "trama-voce__activity",
      attr: { role: "status", "aria-label": "Preparing response", "aria-live": "polite" },
    });
    for (let index = 0; index < 3; index++)
      activity.createEl("span", { cls: "trama-voce__activity-dot" });
  }

  private turnSourcePath(turn: ChatState["turns"][number]): string {
    return turn.role === "user"
      ? (turn.skill?.path ?? turn.attachments[0]?.path ?? "")
      : (turn.sources[0]?.path ?? "");
  }

  private openInternalLink(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    const link = target?.closest?.("a.internal-link") as HTMLAnchorElement | null;
    const linkText = link?.getAttribute("data-href");
    if (!link || !linkText) return;
    event.preventDefault();
    event.stopPropagation();
    const sourcePath =
      link.closest<HTMLElement>(".trama-voce__message")?.getAttribute("data-source-path") ??
      link.getAttribute("data-source-path") ??
      "";
    void this.app.workspace
      .openLinkText(linkText, sourcePath, Keymap.isModEvent(event))
      .catch((error) => {
        this.consoleDebug?.error("Voce note link failed", undefined, {
          errorCode: errorCode(error),
        });
        this.localError = error instanceof Error ? error.message : "Note could not be opened.";
        this.renderFeedback(this.session.getState());
      });
  }

  private renderSources(parent: HTMLDivElement, turn: AssistantConversationTurn): void {
    const sources = parent.createDiv({ cls: "trama-voce__sources" });
    sources.createDiv({
      cls: "setting-item-description trama-voce__sources-label",
      text: "Sources",
    });
    for (const note of turn.sources)
      this.renderInternalLink(sources, note.path, provenanceLabel(note), "trama-voce__chip");
  }

  private renderInternalLink(
    parent: HTMLDivElement,
    path: string,
    label: string,
    cls: string,
    sourcePath?: string
  ): void {
    parent.createEl("a", {
      cls: `internal-link ${cls}`,
      text: label,
      attr: {
        href: path,
        "data-href": path,
        ...(sourcePath ? { "data-source-path": sourcePath } : {}),
      },
    });
  }

  private renderAttachments(catalog: readonly string[] = this.noteCatalog()): void {
    this.attachments.empty();
    const selected = new Set(this.selectedAttachmentPaths);
    const activePath = (this.app as any)?.workspace?.getActiveFile?.()?.path as string | undefined;
    const activeSuggestions = this.noteSuggestions().filter(
      (path) => path === activePath && catalog.includes(path)
    );
    const relatedSuggestions =
      this.relatedSourcePath === activePath
        ? this.relatedSuggestions.filter((path) => catalog.includes(path))
        : [];
    const suggestions = [...new Set([...activeSuggestions, ...relatedSuggestions])];
    const paths = [
      ...suggestions,
      ...this.selectedAttachmentPaths.filter((path) => !suggestions.includes(path)),
    ];
    for (const path of paths) {
      const isSelected = selected.has(path);
      const button = this.attachments.createEl("button", {
        cls: ["clickable-icon", "trama-voce__context-tag", isSelected ? "is-active" : ""],
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
          this.abortSkillResolution();
          const currentCatalog = this.noteCatalog();
          this.input.value = removeNoteReference(this.input.value, path, currentCatalog);
          this.syncAttachmentsFromInput(currentCatalog);
          this.renderAttachments(currentCatalog);
          this.localError = undefined;
        } else {
          this.insertNoteReference(path);
          this.localError = undefined;
        }
        this.renderFeedback(this.session.getState());
        this.input.focus();
      });
    }
    const addButton = this.attachments.createEl("button", {
      cls: "clickable-icon trama-voce__context-add",
      attr: { type: "button", "aria-label": "Choose note" },
    });
    setIcon(addButton, "plus");
    setTooltip(addButton, "Choose note");
    addButton.addEventListener("click", () => this.openAttachmentPicker());
  }

  async refreshSuggestions(): Promise<void> {
    const generation = ++this.suggestionGeneration;
    this.suggestionController?.abort();
    this.suggestionController = undefined;
    this.relatedSuggestions = [];
    this.relatedSourcePath = undefined;
    if (!this.isViewOpen) return;
    this.renderAttachments();
    const sourcePath = (this.app as any)?.workspace?.getActiveFile?.()?.path as string | undefined;
    const controller = new AbortController();
    this.suggestionController = controller;
    try {
      const paths = await this.relatedNoteSuggestions(controller.signal);
      if (
        generation !== this.suggestionGeneration ||
        controller.signal.aborted ||
        !this.isViewOpen ||
        (this.app as any)?.workspace?.getActiveFile?.()?.path !== sourcePath
      )
        return;
      this.relatedSuggestions = [...paths];
      this.relatedSourcePath = sourcePath;
      this.renderAttachments();
    } catch {
      if (generation === this.suggestionGeneration && !controller.signal.aborted) {
        this.relatedSuggestions = [];
        this.renderAttachments();
      }
    } finally {
      if (this.suggestionController === controller) this.suggestionController = undefined;
    }
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
        cls: "clickable-icon trama-voce__message-action",
        attr: { type: "button", "aria-label": action.label },
      });
      setIcon(button, action.icon);
      setTooltip(button, action.label);
      button.addEventListener("click", () => {
        void action.run().catch((error) => {
          this.consoleDebug?.error("Voce response action failed", undefined, {
            errorCode: errorCode(error),
          });
          this.localError =
            error instanceof Error ? error.message : "Response could not be copied.";
          this.renderFeedback(this.session.getState());
        });
      });
    }
  }

  private renderExpandAction(
    parent: HTMLDivElement,
    turnId: string,
    isExpanded: boolean,
    message: HTMLDivElement
  ): void {
    const button = parent.createEl("button", {
      cls: "clickable-icon trama-voce__expand",
      text: isExpanded ? "Show less" : "Show more",
      attr: {
        type: "button",
        "aria-expanded": String(isExpanded),
      },
    });
    let expanded = isExpanded;
    button.addEventListener("click", () => {
      expanded = !expanded;
      if (expanded) this.expandedTurnIds.add(turnId);
      else this.expandedTurnIds.delete(turnId);
      message.classList.toggle("trama-voce__message--collapsed", !expanded);
      button.textContent = expanded ? "Show less" : "Show more";
      button.setAttribute("aria-expanded", String(expanded));
      this.recordTranscriptScrollIntent();
      this.restoreTranscriptPosition();
    });
  }

  private renderFeedback(state: ChatState): void {
    this.feedback.empty();
    const message = this.localError ?? (state.error ? errorMessage(state.error) : undefined);
    if (message) {
      this.feedback.createDiv({ cls: "mod-warning trama-voce__error", text: message });
    }
    this.updateActionButton(state.running || this.preparingSkill);
  }

  private updateActionButton(running: boolean): void {
    setIcon(this.actionButton, running ? "square" : "arrow-up");
    const label = running ? "Stop response" : "Send message";
    this.actionButton.setAttribute("aria-label", label);
    setTooltip(this.actionButton, label);
  }
}
