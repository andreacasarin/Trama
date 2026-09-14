/** Minimal runtime surface for testing plugin composition outside Obsidian. */
export const Platform = { isDesktopApp: true };

export class TAbstractFile {
  path = "";
}

export class TFile extends TAbstractFile {
  name = "";
  stat = { size: 0 };
}

export class Vault {}
export class Workspace {}
export class MetadataCache {}

export class Plugin {
  addCommand(_command: unknown): void {}
  addSettingTab(_tab: unknown): void {}
  registerView(_type: string, _factory: unknown): void {}
  registerEvent(_event: unknown): void {}
}

export class Component {
  load(): void {}
  unload(): void {}
  addChild<T extends Component>(component: T): T {
    return component;
  }
  removeChild<T extends Component>(component: T): T {
    return component;
  }
  register(_callback: unknown): void {}
  registerEvent(_event: unknown): void {}
}

export class PluginSettingTab {
  readonly containerEl = {} as HTMLElement;
  constructor(
    public app: unknown,
    public plugin: unknown
  ) {}
}

export class WorkspaceLeaf {
  constructor(public app?: unknown) {}
}

export class ItemView extends Component {
  readonly contentEl = {} as HTMLElement;
  readonly app: unknown;
  constructor(public leaf: WorkspaceLeaf) {
    super();
    this.app = leaf.app;
  }
}

export class SuggestModal<T> {
  readonly contentEl = {} as HTMLElement;
  readonly inputEl = {} as HTMLInputElement;
  constructor(public app: unknown) {}
  open(): void {
    this.onOpen();
  }
  close(): void {
    this.onClose();
  }
  onOpen(): void {}
  onClose(): void {}
  setPlaceholder(_value: string): void {}
  setInstructions(_value: unknown): void {}
  getSuggestions(_query: string): T[] {
    return [];
  }
  renderSuggestion(_value: T, _el: HTMLElement): void {}
  selectSuggestion(_value: T, _event: MouseEvent | KeyboardEvent): void {}
}

export class FuzzySuggestModal<T> {
  constructor(public app: unknown) {}
  open(): void {}
  close(): void {}
  setPlaceholder(_value: string): void {}
  getItems(): T[] {
    return [];
  }
  getItemText(item: T): string {
    return String(item);
  }
  onChooseItem(_item: T, _event: MouseEvent | KeyboardEvent): void {}
}

export class MarkdownRenderer {
  static render(): Promise<void> {
    return Promise.resolve();
  }
}

export class Keymap {
  static isModEvent(event?: { metaKey?: boolean; ctrlKey?: boolean } | null): boolean {
    return Boolean(event?.metaKey || event?.ctrlKey);
  }
}

export function setIcon(_element: HTMLElement, _icon: string): void {}
export function setTooltip(_element: HTMLElement, _tooltip: string): void {}

export class Setting {
  constructor(_container: unknown) {}
}

export class Notice {
  constructor(public message: string) {}
}
