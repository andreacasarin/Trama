export const Platform = { isDesktopApp: true };

type Listener = (event?: any) => void;

type WindowListener = {
  callback: Listener;
  capture: boolean;
};

export class TestWindow {
  readonly listeners = new Map<string, WindowListener[]>();

  addEventListener(type: string, callback: Listener, options?: boolean | { capture?: boolean }) {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ callback, capture });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, callback: Listener, options?: boolean | { capture?: boolean }) {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    const listeners = this.listeners.get(type) ?? [];
    const index = listeners.findIndex(
      (listener) => listener.callback === callback && listener.capture === capture
    );
    if (index >= 0) listeners.splice(index, 1);
  }

  dispatchFrom(target: TestElement, event: { type: string; [key: string]: unknown }) {
    let stopped = false;
    let immediateStopped = false;
    const originalPreventDefault = event.preventDefault as (() => void) | undefined;
    const originalStopPropagation = event.stopPropagation as (() => void) | undefined;
    const originalStopImmediatePropagation = event.stopImmediatePropagation as
      (() => void) | undefined;
    const payload: any = {
      ...event,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
        originalPreventDefault?.();
      },
      stopPropagation() {
        stopped = true;
        originalStopPropagation?.();
      },
      stopImmediatePropagation() {
        stopped = true;
        immediateStopped = true;
        originalStopImmediatePropagation?.();
      },
      target,
      currentTarget: this,
    };
    const listeners = this.listeners.get(event.type) ?? [];
    for (const listener of [...listeners]) {
      if (!this.listeners.get(event.type)?.includes(listener)) continue;
      const { callback, capture } = listener;
      if (!capture) continue;
      callback(payload);
      if (immediateStopped) return !payload.defaultPrevented;
    }
    if (stopped) return !payload.defaultPrevented;
    target.dispatchLocal(event.type, payload);
    if (stopped) return !payload.defaultPrevented;
    for (const listener of [...listeners]) {
      if (!this.listeners.get(event.type)?.includes(listener)) continue;
      const { callback, capture } = listener;
      if (capture) continue;
      callback(payload);
      if (immediateStopped) break;
    }
    return !payload.defaultPrevented;
  }
}

const testWindow = new TestWindow();
const testDocument = { defaultView: testWindow };

export function resetTestWindow(): void {
  testWindow.listeners.clear();
}

export class TestElement {
  readonly children: TestElement[] = [];
  readonly classes = new Set<string>();
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  parent?: TestElement;
  textContent = "";
  value = "";
  disabled = false;
  hidden = false;
  focused = false;
  title = "";
  type = "";
  rows = 0;
  selectionStart = 0;
  selectionEnd = 0;
  readonly ownerDocument = testDocument;

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

  dispatchEvent(event: { type: string; [key: string]: unknown }) {
    if (event.type === "keydown") return this.ownerDocument.defaultView.dispatchFrom(this, event);
    this.dispatch(event.type, event);
    return true;
  }

  dispatchLocal(type: string, event: Record<string, unknown>) {
    const listeners = this.listeners.get(type) ?? [];
    for (const listener of listeners) listener(event);
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

  focus() {
    this.focused = true;
  }

  toggleVisibility(visible: boolean) {
    this.hidden = !visible;
  }

  addClass(...classes: string[]) {
    for (const value of classes.flatMap((item) => item.split(/\s+/))) {
      if (value) this.classes.add(value);
    }
  }

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

type ScopeListener = (event: KeyboardEvent, context: { vkey: string }) => false | any;

export class Scope {
  private readonly listeners: Array<{
    key: string | null;
    callback: ScopeListener;
  }> = [];
  active = false;

  constructor(readonly parent?: Scope) {}

  register(_modifiers: unknown[] | null, key: string | null, callback: ScopeListener) {
    const handler = { key, callback };
    this.listeners.push(handler);
    return { scope: this, ...handler };
  }

  unregister(handler: { callback: ScopeListener }) {
    const index = this.listeners.findIndex((listener) => listener.callback === handler.callback);
    if (index >= 0) this.listeners.splice(index, 1);
  }

  dispatch(event: KeyboardEvent): boolean {
    if (!this.active) return true;
    for (const listener of [...this.listeners]) {
      if (listener.key !== null && listener.key !== event.key) continue;
      const result = listener.callback(event, { vkey: event.key });
      if (result === false) {
        event.preventDefault();
        return false;
      }
    }
    return true;
  }
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

export class SuggestModal<T> {
  static lastOpened: SuggestModal<unknown> | undefined;
  opened = false;
  placeholder = "";
  instructions: Array<{ command: string; purpose: string }> = [];
  emptyStateText = "";
  readonly containerEl = new TestElement("div");
  readonly modalEl = new TestElement("div");
  readonly contentEl = new TestElement("div");
  readonly inputEl = new TestElement("input");
  readonly resultContainerEl = new TestElement("div");
  readonly scope: Scope;
  private activeIndex = 0;
  private renderedSuggestions: T[] = [];

  constructor(public app: unknown) {
    this.scope = new Scope((app as { scope?: Scope })?.scope);
    this.inputEl.parent = this.containerEl;
    this.containerEl.children.push(this.inputEl);
    this.contentEl.parent = this.containerEl;
    this.containerEl.children.push(this.contentEl);
    this.resultContainerEl.parent = this.contentEl;
    this.contentEl.children.push(this.resultContainerEl);
    this.scope.register(null, "Enter", (event) => {
      if (event.isComposing) return undefined;
      const value = this.renderedSuggestions[this.activeIndex];
      if (value !== undefined) this.onChooseSuggestion(value, event);
      return false;
    });
    this.inputEl.addEventListener("input", () => {
      this.activeIndex = 0;
      this.renderSuggestions();
    });
    this.scope.register(null, "ArrowDown", () => {
      this.activeIndex = Math.min(this.activeIndex + 1, this.renderedSuggestions.length - 1);
      this.updateActiveSuggestion();
      return false;
    });
    this.scope.register(null, "ArrowUp", () => {
      this.activeIndex = Math.max(0, this.activeIndex - 1);
      this.updateActiveSuggestion();
      return false;
    });
    this.inputEl.ownerDocument.defaultView.addEventListener(
      "keydown",
      (event) => {
        if (!this.scope.active || event.target !== this.inputEl) return;
        const consumed = this.scope.dispatch(event as KeyboardEvent);
        if (event.key === "Enter" && !event.isComposing) {
          if (consumed === false) event.stopPropagation();
          const trace = (event as KeyboardEvent & { trace?: string[] }).trace;
          trace?.push(consumed === false ? "native-consume" : "native-pass");
        }
      },
      true
    );
  }

  open() {
    this.opened = true;
    SuggestModal.lastOpened = this;
    this.onOpen();
  }

  close() {
    if (!this.opened) return;
    this.opened = false;
    this.onClose();
  }

  onOpen() {
    this.scope.active = true;
  }
  onClose() {
    this.scope.active = false;
  }

  setPlaceholder(value: string) {
    this.placeholder = value;
  }

  setInstructions(value: Array<{ command: string; purpose: string }>) {
    this.instructions = value;
  }

  getSuggestions(_query: string): T[] {
    return [];
  }

  renderSuggestion(_value: T, _el: TestElement): void {}

  selectSuggestion(_value: T, _evt: MouseEvent | KeyboardEvent): void {}

  onChooseSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void {
    this.selectSuggestion(value, evt);
  }

  selectActiveSuggestion(evt: MouseEvent | KeyboardEvent): void {
    const value = this.renderedSuggestions[this.activeIndex];
    if (value !== undefined) this.selectSuggestion(value, evt);
  }

  private renderSuggestions() {
    const suggestions = this.getSuggestions(this.inputEl.value);
    this.renderedSuggestions = suggestions instanceof Promise ? [] : [...suggestions];
    this.resultContainerEl.empty();
    this.renderedSuggestions.forEach((suggestion) => {
      const row = this.resultContainerEl.createDiv({ cls: "suggestion-item" });
      this.renderSuggestion(suggestion, row);
    });
    this.updateActiveSuggestion();
  }

  private updateActiveSuggestion() {
    this.resultContainerEl.children.forEach((row, index) => {
      if (index === this.activeIndex) row.classes.add("is-selected");
      else row.classes.delete("is-selected");
    });
  }
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
  isHeading = false;
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
  setHeading() {
    this.isHeading = true;
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
