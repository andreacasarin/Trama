export interface ChatSettings {
  readonly endpoint: string;
  readonly modelId: string;
  readonly temperature: number;
  readonly maxOutputTokens?: number;
  readonly contextWindowTokens?: number;
  readonly reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
}
export interface EmbeddingSettings {
  readonly endpoint: string;
  readonly modelId: string;
  readonly dimensions: number;
}
export interface TramaSettings {
  readonly consoleDebug: boolean;
  readonly chat: ChatSettings;
  readonly embedding: EmbeddingSettings;
  readonly excludedFolders: readonly string[];
}

export const DEFAULT_SETTINGS: TramaSettings = Object.freeze({
  consoleDebug: false,
  chat: Object.freeze({
    endpoint: "http://127.0.0.1:1234/v1",
    modelId: "",
    temperature: 0.2,
    contextWindowTokens: 4096,
  }),
  embedding: Object.freeze({ endpoint: "http://127.0.0.1:1234/v1", modelId: "", dimensions: 768 }),
  excludedFolders: Object.freeze([]),
});

export type ReasoningEffort = NonNullable<ChatSettings["reasoningEffort"]>;
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && REASONING_EFFORTS.includes(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : undefined;
}

export class SettingsStore {
  private value = DEFAULT_SETTINGS;
  load(value: unknown): TramaSettings {
    if (!value || typeof value !== "object") return (this.value = DEFAULT_SETTINGS);
    const data = value as Record<string, any>;
    const chat = data.chat && typeof data.chat === "object" ? data.chat : {};
    const embedding = data.embedding && typeof data.embedding === "object" ? data.embedding : {};
    const endpoint = (raw: unknown, fallback: string) => {
      if (typeof raw !== "string" || !raw.trim()) return fallback;
      try {
        new URL(raw.trim());
        return raw.trim();
      } catch {
        return fallback;
      }
    };
    const modelId = typeof chat.modelId === "string" ? chat.modelId : "";
    const effort = normalizeReasoningEffort(chat.reasoningEffort);
    const settings: TramaSettings = {
      consoleDebug: data.consoleDebug === true,
      chat: {
        endpoint: endpoint(chat.endpoint, DEFAULT_SETTINGS.chat.endpoint),
        modelId,
        temperature:
          Number.isFinite(chat.temperature) && chat.temperature >= 0 && chat.temperature <= 1
            ? chat.temperature
            : 0.2,
        contextWindowTokens:
          Number.isSafeInteger(chat.contextWindowTokens) && chat.contextWindowTokens > 0
            ? chat.contextWindowTokens
            : DEFAULT_SETTINGS.chat.contextWindowTokens,
        ...(Number.isSafeInteger(chat.maxOutputTokens) && chat.maxOutputTokens >= 1024
          ? { maxOutputTokens: chat.maxOutputTokens }
          : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
      },
      embedding: {
        endpoint: endpoint(embedding.endpoint, DEFAULT_SETTINGS.embedding.endpoint),
        modelId: typeof embedding.modelId === "string" ? embedding.modelId : "",
        dimensions:
          Number.isSafeInteger(embedding.dimensions) && embedding.dimensions > 0
            ? embedding.dimensions
            : DEFAULT_SETTINGS.embedding.dimensions,
      },
      excludedFolders: normalizeExcludedFolders(data.excludedFolders),
    };
    return (this.value = Object.freeze(settings));
  }
  get(): TramaSettings {
    return this.value;
  }
  stage(value: TramaSettings): TramaSettings {
    return value;
  }
  commit(value: TramaSettings): void {
    this.value = value;
  }
}

export function normalizeExcludedFolders(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((raw) => {
        if (typeof raw !== "string") return [];
        const path = raw.trim();
        if (!path || path.startsWith("/") || path.includes("\\")) return [];
        const parts = path.split("/").filter((part) => part && part !== ".");
        if (!parts.length || parts.includes("..")) return [];
        return [parts.join("/")];
      })
    ),
  ].sort((left, right) => left.localeCompare(right));
}
