export type ConsoleDebugLevel = "info" | "warn" | "error";

export class ConsoleDebug {
  constructor(private readonly enabled: () => boolean) {}

  isEnabled(): boolean {
    return this.enabled();
  }

  info(label: string, fields?: Record<string, string | number | boolean>): void {
    this.write("info", label, undefined, fields);
  }

  warn(label: string, error?: unknown, fields?: Record<string, string | number | boolean>): void {
    this.write("warn", label, error, fields);
  }

  error(label: string, error?: unknown, fields?: Record<string, string | number | boolean>): void {
    this.write("error", label, error, fields);
  }

  start(label: string, fields?: Record<string, string | number | boolean>) {
    const startedAt = performance.now();
    this.info(`${label} started`, fields);
    let finished = false;
    return (
      outcome: string,
      extra?: Record<string, string | number | boolean>,
      error?: unknown,
      level: ConsoleDebugLevel = "info"
    ) => {
      if (finished) return;
      finished = true;
      const details = {
        ...fields,
        ...extra,
        elapsedMs: Math.round(performance.now() - startedAt),
      };
      this.write(level, `${label} ${outcome}`, error, details);
    };
  }

  private write(
    level: ConsoleDebugLevel,
    label: string,
    error?: unknown,
    fields?: Record<string, string | number | boolean>
  ): void {
    if (!this.enabled()) return;
    const output = console[level].bind(console);
    if (error === undefined) {
      if (fields) output(`[Trama] ${label}`, fields);
      else output(`[Trama] ${label}`);
    } else if (fields) output(`[Trama] ${label}`, error, fields);
    else output(`[Trama] ${label}`, error);
  }
}
