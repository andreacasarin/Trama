export const Platform = { isDesktopApp: true };

export class Plugin {}
export class PluginSettingTab {
  constructor(
    public app: unknown,
    public plugin: unknown
  ) {}
  containerEl = {
    empty() {},
    createEl(_tag: string, _options?: unknown) {
      return {
        createDiv() {
          return {
            createEl() {
              return { addEventListener() {} };
            },
          };
        },
      };
    },
    createDiv() {
      return {
        createEl() {
          return { addEventListener() {} };
        },
      };
    },
  };
}
export class ItemView {
  contentEl = { empty() {}, createEl() {}, createDiv() {} };
  constructor(public leaf: unknown) {}
}
export class Setting {
  static instances: Setting[] = [];
  readonly textControls: TextComponent[] = [];
  readonly sliderControls: SliderComponent[] = [];
  readonly dropdownControls: DropdownComponent[] = [];
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
