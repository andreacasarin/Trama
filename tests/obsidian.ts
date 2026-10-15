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
  registerHoverLinkSource(_id: string, _info: unknown): void {}
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
  readonly containerEl = new SettingsElement() as unknown as HTMLElement;
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
  readonly inputEl = { value: "", focus: () => {} } as unknown as HTMLInputElement;
  emptyStateText = "";
  instructions?: unknown;
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
  setInstructions(value: unknown): void {
    this.instructions = value;
  }
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
  static instances: Setting[] = [];
  name = "";
  controls: TestControl[] = [];
  constructor(_container: unknown) {
    Setting.instances.push(this);
  }
  setName(value: string): this {
    this.name = value;
    return this;
  }
  setDesc(_value: string): this {
    return this;
  }
  setHeading(): this {
    return this;
  }
  addText(callback: (control: TestControl) => unknown): this {
    const control = new TestControl();
    this.controls.push(control);
    callback(control);
    return this;
  }
  addDropdown(callback: (control: TestControl) => unknown): this {
    const control = new TestControl();
    this.controls.push(control);
    callback(control);
    return this;
  }
  addButton(callback: (control: TestControl) => unknown): this {
    const control = new TestControl();
    this.controls.push(control);
    callback(control);
    return this;
  }
  addExtraButton(callback: (control: TestControl) => unknown): this {
    const control = new TestControl();
    this.controls.push(control);
    callback(control);
    return this;
  }
}

class TestControl {
  value = "";
  disabled = false;
  options = new Map<string, string>();
  readonly selectEl = { replaceChildren: () => this.options.clear() };
  changeCallback?: (value: string) => unknown;
  clickCallback?: () => unknown;
  inputEl = {
    listeners: new Map<string, Array<(event: any) => unknown>>(),
    addEventListener: (type: string, callback: (event: any) => unknown) => {
      const listeners = this.inputEl.listeners.get(type) ?? [];
      listeners.push(callback);
      this.inputEl.listeners.set(type, listeners);
    },
    fire: (type: string, event: any = {}) =>
      this.inputEl.listeners.get(type)?.forEach((fn) => fn(event)),
  };
  setValue(value: string): this {
    this.value = value;
    return this;
  }
  getValue(): string {
    return this.value;
  }
  onChange(callback: (value: string) => unknown): this {
    this.changeCallback = callback;
    return this;
  }
  change(value: string): void {
    this.value = value;
    this.changeCallback?.(value);
  }
  addOption(value: string, label: string): this {
    this.options.set(value, label);
    return this;
  }
  setButtonText(value: string): this {
    this.value = value;
    return this;
  }
  onClick(callback: () => unknown): this {
    this.clickCallback = callback;
    return this;
  }
  click(): void {
    this.clickCallback?.();
  }
  setCta(): this {
    return this;
  }
  setIcon(value: string): this {
    this.value = value;
    return this;
  }
  setTooltip(_value: string): this {
    return this;
  }
  setDisabled(value: boolean): this {
    this.disabled = value;
    return this;
  }
}

class SettingsElement {
  children: SettingsElement[] = [];
  textContent = "";
  attrs = new Map<string, string>();
  empty(): void {
    this.children = [];
  }
  createEl(_tag: string, options?: { text?: string }): SettingsElement {
    const child = new SettingsElement();
    child.textContent = options?.text ?? "";
    this.children.push(child);
    return child;
  }
  createDiv(_options?: unknown): SettingsElement {
    const child = new SettingsElement();
    this.children.push(child);
    return child;
  }
  querySelector(_selector: string): null {
    return null;
  }
  remove(): void {}
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
}

export class SearchComponent {
  readonly inputEl: any;
  constructor(container: any) {
    this.inputEl = container.createEl("input");
  }
  setPlaceholder(value: string): this {
    this.inputEl.placeholder = value;
    return this;
  }
}

export class TextAreaComponent {
  readonly inputEl: any;
  constructor(container: any) {
    this.inputEl = container.createEl("textarea");
  }
}

export class ButtonComponent {
  readonly buttonEl: any;
  constructor(container: any) {
    this.buttonEl = container.createEl("button");
  }
  setButtonText(value: string): this {
    this.buttonEl.textContent = value;
    return this;
  }
  onClick(callback: (event: unknown) => unknown): this {
    this.buttonEl.addEventListener("click", callback);
    return this;
  }
}

export class Notice {
  constructor(public message: string) {}
  setMessage(message: string): this {
    this.message = message;
    return this;
  }
  hide(): void {}
}
