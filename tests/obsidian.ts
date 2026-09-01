export const Platform = { isDesktopApp: true };

export class Plugin {}
export class PluginSettingTab {
  constructor(
    public app: unknown,
    public plugin: unknown
  ) {}
  containerEl = { empty() {}, createEl() {} };
}
export class ItemView {
  contentEl = { empty() {}, createEl() {}, createDiv() {} };
  constructor(public leaf: unknown) {}
}
export class Setting {
  constructor(public containerEl: unknown) {}
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  addText() {
    return this;
  }
}
export class Notice {
  constructor(public message: string) {}
}
