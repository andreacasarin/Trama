import { EndpointPolicy, type EndpointApproval } from "@/security/EndpointPolicy";

export interface ChatSettings {
  readonly endpoint: string;
  readonly modelId: string;
  readonly temperature: number;
  readonly maxOutputTokens?: number;
  readonly reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
}
export interface EmbeddingSettings {
  readonly endpoint: string;
  readonly modelId: string;
  readonly dimensions: number;
}
export interface TramaSettings {
  readonly chat: ChatSettings;
  readonly embedding: EmbeddingSettings;
  readonly approvedOrigins: readonly EndpointApproval[];
  readonly excludedFolders: readonly string[];
}

export const DEFAULT_SETTINGS: TramaSettings = Object.freeze({
  chat: Object.freeze({ endpoint: "http://127.0.0.1:1234/v1", modelId: "", temperature: 0.2 }),
  embedding: Object.freeze({ endpoint: "http://127.0.0.1:1234/v1", modelId: "", dimensions: 768 }),
  approvedOrigins: Object.freeze([]),
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
    const approvals = Array.isArray(data.approvedOrigins) ? data.approvedOrigins : [];
    const policy = new EndpointPolicy({ approvals: approvals.filter(isApproval) });
    const chat = data.chat && typeof data.chat === "object" ? data.chat : {};
    const embedding = data.embedding && typeof data.embedding === "object" ? data.embedding : {};
    const endpoint = (raw: unknown, fallback: string) => {
      try {
        return policy.normalize(typeof raw === "string" ? raw : fallback);
      } catch {
        return fallback;
      }
    };
    const modelId = typeof chat.modelId === "string" ? chat.modelId : "";
    const effort = normalizeReasoningEffort(chat.reasoningEffort);
    const settings: TramaSettings = {
      chat: {
        endpoint: endpoint(chat.endpoint, DEFAULT_SETTINGS.chat.endpoint),
        modelId,
        temperature:
          Number.isFinite(chat.temperature) && chat.temperature >= 0 && chat.temperature <= 1
            ? chat.temperature
            : 0.2,
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
      approvedOrigins: approvals
        .filter(isApproval)
        .map(({ scheme, host, port }: EndpointApproval) => ({
          scheme,
          host: host.toLowerCase(),
          port,
        })),
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

function isApproval(value: unknown): value is EndpointApproval {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<EndpointApproval>;
  return (
    (item.scheme === "http" || item.scheme === "https") &&
    typeof item.host === "string" &&
    Number.isSafeInteger(item.port) &&
    Number(item.port) > 0
  );
}
