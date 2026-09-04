export const Platform = { isDesktopApp: true };

type Listener = (event?: any) => void;

export class TestElement {
  readonly children: TestElement[] = [];
  readonly classes = new Set<string>();
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  parent?: TestElement;
  textContent = "";
  value = "";
  disabled = false;
  title = "";
  type = "";
  rows = 0;
  selectionStart = 0;
  selectionEnd = 0;

  constructor(readonly tagName: string) {}

  empty() {
    this.children.length = 0;
    this.textContent = "";
  }

  createEl(tag: string, options?: unknown) {
    const child = new TestElement(tag);
    child.parent = this;
    child.applyOptions(options);
    this.children.push(child);
    return child;
  }

  createDiv(options?: unknown) {
    return this.createEl("div", options);
  }

  createSpan(options?: unknown) {
    return this.createEl("span", options);
  }

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, event: Record<string, unknown> = {}) {
    const listeners = this.listeners.get(type) ?? [];
    const payload = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
      ...event,
      target: event.target ?? this,
      currentTarget: this,
    };
    for (const listener of listeners) listener(payload);
    return payload;
  }

  click() {
    this.dispatch("click");
  }

  focus() {}

  setText(value: string) {
    this.textContent = value;
  }

  setSelectionRange(start: number, end: number) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  closest(selector: string): TestElement | null {
    const tagAndClass = selector.match(/^([a-z]+)?(?:\.([\w-]+))?$/i);
    if (!tagAndClass) return null;
    const [, tag, cls] = tagAndClass;
    if ((!tag || this.tagName === tag) && (!cls || this.classes.has(cls))) return this;
    return this.parent?.closest(selector) ?? null;
  }

  remove() {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = undefined;
  }

  private applyOptions(options?: unknown) {
    if (!options || typeof options === "string") return;
    const info = options as {
      cls?: string | string[];
      text?: string;
      attr?: Record<string, string | number | boolean | null>;
      value?: string;
      type?: string;
    };
    if (info.cls) {
      const classes = Array.isArray(info.cls) ? info.cls : info.cls.split(/\s+/);
      for (const cls of classes) if (cls) this.classes.add(cls);
    }
    if (info.text) this.textContent = info.text;
    if (info.value) this.value = info.value;
    if (info.type) this.type = info.type;
    for (const [name, value] of Object.entries(info.attr ?? {})) {
      if (value === null) continue;
      this.setAttribute(name, String(value));
      if (name === "rows") this.rows = Number(value);
      if (name === "type") this.type = String(value);
      if (name === "value") this.value = String(value);
    }
  }
}

export class Plugin {}
export class Component {
  private readonly children = new Set<Component>();

  load() {}
  unload() {
    for (const child of this.children) child.unload();
    this.children.clear();
  }
  addChild<T extends Component>(component: T): T {
    this.children.add(component);
    return component;
  }
  removeChild<T extends Component>(component: T): T {
    component.unload();
    this.children.delete(component);
    return component;
  }
  register() {}
  registerEvent() {}
}
export class PluginSettingTab {
  constructor(
    public app: unknown,
    public plugin: unknown
  ) {}
  containerEl = new TestElement("div");
}
export class ItemView extends Component {
  contentEl = new TestElement("div");
  app: unknown;
  constructor(public leaf: unknown) {
    super();
    this.app = (leaf as { app?: unknown })?.app;
  }
}
export class WorkspaceLeaf {
  constructor(public app?: unknown) {}
}

export class Keymap {
  static isModEvent(event?: { metaKey?: boolean; ctrlKey?: boolean } | null): boolean {
    return Boolean(event?.metaKey || event?.ctrlKey);
  }
}

export class FuzzySuggestModal<T> {
  static lastOpened: FuzzySuggestModal<unknown> | undefined;
  opened = false;
  placeholder = "";

  constructor(public app: unknown) {}

  open() {
    this.opened = true;
    FuzzySuggestModal.lastOpened = this;
  }

  close() {
    this.opened = false;
  }

  setPlaceholder(value: string) {
    this.placeholder = value;
  }

  getSuggestions(): Array<{ item: T }> {
    return this.getItems().map((item) => ({ item }));
  }

  renderSuggestion(): void {}

  onChooseSuggestion(item: { item: T }, evt: MouseEvent | KeyboardEvent): void {
    this.onChooseItem(item.item, evt);
  }

  choose(item: T) {
    this.onChooseItem(item, {} as KeyboardEvent);
  }

  getItems(): T[] {
    return [];
  }

  getItemText(item: T): string {
    return String(item);
  }

  onChooseItem(_item: T, _evt: MouseEvent | KeyboardEvent): void {}
}

export class MarkdownRenderer {
  static render(
    _app: unknown,
    markdown: string,
    el: TestElement,
    sourcePath: string
  ): Promise<void> {
    el.setAttribute("data-source-path", sourcePath);
    el.textContent = markdown;
    for (const match of markdown.matchAll(/\[\[([^\]|#^]+)(?:[#^][^\]|]+)?(?:\|([^\]]+))?\]\]/g)) {
      const path = match[1];
      el.createEl("a", {
        cls: "internal-link",
        text: match[2] ?? path,
        attr: { href: path, "data-href": path },
      });
    }
    return Promise.resolve();
  }
}

export function setIcon(parent: TestElement, icon: string) {
  parent.setAttribute("data-icon", icon);
}

export function setTooltip(el: TestElement, tooltip: string) {
  el.title = tooltip;
  el.setAttribute("title", tooltip);
}

export class Setting {
  static instances: Setting[] = [];
  readonly textControls: TextComponent[] = [];
  readonly sliderControls: SliderComponent[] = [];
  readonly dropdownControls: DropdownComponent[] = [];
  readonly toggleControls: ToggleComponent[] = [];
  readonly buttonControls: ButtonComponent[] = [];
  name = "";
  description = "";
  constructor(public containerEl: unknown) {
    Setting.instances.push(this);
  }
  setName(_name: string) {
    this.name = _name;
    return this;
  }
  setDesc(_description: string) {
    this.description = _description;
    return this;
  }
  addText(callback: (text: TextComponent) => void) {
    const text = new TextComponent();
    this.textControls.push(text);
    callback(text);
    return this;
  }
  addSlider(callback: (slider: SliderComponent) => void) {
    const slider = new SliderComponent();
    this.sliderControls.push(slider);
    callback(slider);
    return this;
  }
  addDropdown(callback: (dropdown: DropdownComponent) => void) {
    const dropdown = new DropdownComponent();
    this.dropdownControls.push(dropdown);
    callback(dropdown);
    return this;
  }
  addToggle(callback: (toggle: ToggleComponent) => void) {
    const toggle = new ToggleComponent();
    this.toggleControls.push(toggle);
    callback(toggle);
    return this;
  }
  addButton(callback: (button: ButtonComponent) => void) {
    const button = new ButtonComponent();
    this.buttonControls.push(button);
    callback(button);
    return this;
  }
}
export class TextComponent {
  value = "";
  placeholder = "";
  private callback?: (value: string) => void;
  setValue(value: string) {
    this.value = value;
    return this;
  }
  setPlaceholder(value: string) {
    this.placeholder = value;
    return this;
  }
  onChange(callback: (value: string) => void) {
    this.callback = callback;
    return this;
  }
  emit(value: string) {
    this.value = value;
    this.callback?.(value);
  }
}
export class SliderComponent {
  value = 0;
  limits?: { min: number; max: number; step: number };
  dynamicTooltip = false;
  private callback?: (value: number) => void;
  setLimits(min: number, max: number, step: number) {
    this.limits = { min, max, step };
    return this;
  }
  setValue(value: number) {
    this.value = value;
    return this;
  }
  setDynamicTooltip() {
    this.dynamicTooltip = true;
    return this;
  }
  onChange(callback: (value: number) => void) {
    this.callback = callback;
    return this;
  }
  emit(value: number) {
    this.value = value;
    this.callback?.(value);
  }
}
export class DropdownComponent {
  value = "";
  options: Record<string, string> = {};
  private callback?: (value: string) => void;
  addOption(value: string, label: string) {
    this.options[value] = label;
    return this;
  }
  setValue(value: string) {
    this.value = value;
    return this;
  }
  onChange(callback: (value: string) => void) {
    this.callback = callback;
    return this;
  }
  emit(value: string) {
    this.value = value;
    this.callback?.(value);
  }
}
export class ToggleComponent {
  value = false;
  private callback?: (value: boolean) => void;
  setValue(value: boolean) {
    this.value = value;
    return this;
  }
  onChange(callback: (value: boolean) => void) {
    this.callback = callback;
    return this;
  }
  emit(value: boolean) {
    this.value = value;
    this.callback?.(value);
  }
}
export class ButtonComponent {
  text = "";
  disabled = false;
  private callback?: () => void;
  setButtonText(value: string) {
    this.text = value;
    return this;
  }
  setDisabled(value: boolean) {
    this.disabled = value;
    return this;
  }
  onClick(callback: () => void) {
    this.callback = callback;
    return this;
  }
  click() {
    this.callback?.();
  }
}
export class Notice {
  constructor(public message: string) {}
}
