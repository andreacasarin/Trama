import { ItemView, WorkspaceLeaf } from "obsidian";
import { ChatSession, ChatState } from "@/chat/ChatSession";
import { ProvenanceRecord } from "@/domain/contracts";

export const CHAT_VIEW_TYPE = "local-vault-assistant-chat";

export function provenanceLabel(record: ProvenanceRecord): string {
  const hasRange = record.startLine !== undefined || record.endLine !== undefined;
  return hasRange
    ? `${record.path} (lines ${record.startLine ?? record.endLine}-${record.endLine ?? record.startLine})`
    : record.path;
}

/** Native Obsidian view for the session's transient conversation and tool activity. */
export class ChatView extends ItemView {
  private unsubscribe: (() => void) | undefined;
  private input!: HTMLTextAreaElement;
  private transcript!: HTMLElement;
  private stopButton!: HTMLButtonElement;

  constructor(
    leaf: WorkspaceLeaf,
    private session: ChatSession
  ) {
    super(leaf);
  }
  /** Rebinds an open view after settings replace the session graph. */
  setSession(session: ChatSession): void {
    this.unsubscribe?.();
    this.session = session;
    this.unsubscribe = this.session.subscribe((state) => this.render(state));
  }
  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Local Vault Assistant";
  }

  override onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Local Vault Assistant" });
    this.transcript = this.contentEl.createDiv({ cls: "local-vault-assistant-chat-transcript" });
    const form = this.contentEl.createDiv({ cls: "local-vault-assistant-chat-controls" });
    this.input = form.createEl("textarea", { attr: { rows: "3", ariaLabel: "Message" } });
    const send = form.createEl("button", { text: "Send" });
    this.stopButton = form.createEl("button", { text: "Stop" });
    send.addEventListener("click", () => {
      void this.session
        .send(this.input.value)
        .then(() => {
          this.input.value = "";
        })
        .catch(() => undefined);
    });
    this.stopButton.addEventListener("click", () => this.session.cancel());
    this.unsubscribe = this.session.subscribe((state) => this.render(state));
    return Promise.resolve();
  }

  override onClose(): Promise<void> {
    this.session.cancel();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    return Promise.resolve();
  }

  private render(state: ChatState): void {
    this.transcript.empty();
    for (const message of state.messages) {
      this.transcript.createDiv({ text: `${message.role}: ${message.content}` });
      if (message.role === "assistant" && message.provenance?.length) {
        this.transcript.createDiv({ text: "Sources:" });
        const seen = new Set<string>();
        for (const note of message.provenance) {
          const key = `${note.path}\n${note.startLine ?? ""}\n${note.endLine ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          this.transcript.createDiv({ text: provenanceLabel(note) });
        }
      }
    }
    for (const activity of state.activities) {
      this.transcript.createDiv({ text: `tool ${activity.call.name}: ${activity.status}` });
    }
    if (state.error)
      this.transcript.createDiv({ text: `${state.error.code}: ${state.error.message}` });
    this.stopButton.disabled = !state.running;
  }
}
