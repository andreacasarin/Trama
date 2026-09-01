import { EndpointApproval, EndpointPolicy } from "@/security/EndpointPolicy";

export interface ChatSettings {
  readonly endpoint: string;
  readonly modelId: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly context?: number;
  readonly reasoning?: boolean;
}
export interface EmbeddingSettings {
  readonly endpoint: string;
  readonly modelId: string;
  readonly dimensions: number;
  readonly batchSize: number;
}
export interface TramaSettings {
  readonly schemaVersion: 1;
  readonly chat: ChatSettings;
  readonly embedding: EmbeddingSettings;
  readonly approvedOrigins: readonly EndpointApproval[];
}

export const DEFAULT_SETTINGS: TramaSettings = Object.freeze({
  schemaVersion: 1,
  chat: Object.freeze({
    endpoint: "http://127.0.0.1:1234/v1",
    modelId: "",
    temperature: 0.2,
    maxTokens: 1024,
  }),
  embedding: Object.freeze({
    endpoint: "http://127.0.0.1:1234/v1",
    modelId: "",
    dimensions: 768,
    batchSize: 32,
  }),
  approvedOrigins: Object.freeze([]),
});

/** Owns the versioned, non-secret settings persisted through Obsidian plugin data. */
export class SettingsStore {
  private value: TramaSettings = DEFAULT_SETTINGS;
  /** Loads and sanitizes plugin data without performing network I/O. */
  load(data: unknown): TramaSettings {
    if (
      !data ||
      typeof data !== "object" ||
      (data as { schemaVersion?: unknown }).schemaVersion !== 1
    ) {
      this.value = DEFAULT_SETTINGS;
      return this.value;
    }
    const input = data as Partial<TramaSettings>;
    const rawChat = (input.chat && typeof input.chat === "object" ? input.chat : {}) as Record<
      string,
      unknown
    >;
    const rawEmbedding = (
      input.embedding && typeof input.embedding === "object" ? input.embedding : {}
    ) as Record<string, unknown>;
    const chatEndpoint = this.string(rawChat.endpoint, DEFAULT_SETTINGS.chat.endpoint);
    const embeddingEndpoint = this.string(
      rawEmbedding.endpoint,
      DEFAULT_SETTINGS.embedding.endpoint
    );
    const approvals = this.sanitizeApprovals(input.approvedOrigins);
    const policy = new EndpointPolicy({ approvals });
    const chat = {
      endpoint: this.safeEndpoint(policy, chatEndpoint, DEFAULT_SETTINGS.chat.endpoint),
      modelId: this.string(rawChat.modelId, DEFAULT_SETTINGS.chat.modelId),
      temperature: this.range(rawChat.temperature, DEFAULT_SETTINGS.chat.temperature, 0, 2),
      maxTokens: this.positiveInt(rawChat.maxTokens, DEFAULT_SETTINGS.chat.maxTokens),
      ...(this.positiveInt(rawChat.context, 0)
        ? { context: this.positiveInt(rawChat.context, 0) }
        : {}),
      ...(typeof rawChat.reasoning === "boolean" ? { reasoning: rawChat.reasoning } : {}),
    };
    const embedding = {
      endpoint: this.safeEndpoint(policy, embeddingEndpoint, DEFAULT_SETTINGS.embedding.endpoint),
      modelId: this.string(rawEmbedding.modelId, DEFAULT_SETTINGS.embedding.modelId),
      dimensions: this.positiveInt(rawEmbedding.dimensions, DEFAULT_SETTINGS.embedding.dimensions),
      batchSize: this.positiveInt(rawEmbedding.batchSize, DEFAULT_SETTINGS.embedding.batchSize),
    };
    this.value = {
      schemaVersion: 1,
      chat: Object.freeze(chat),
      embedding: Object.freeze(embedding),
      approvedOrigins: Object.freeze(
        approvals.map((v) => ({ scheme: v.scheme, host: v.host.toLowerCase(), port: v.port }))
      ),
    } as TramaSettings;
    return this.value;
  }
  private string(value: unknown, fallback: string): string {
    return typeof value === "string" ? value : fallback;
  }
  private safeEndpoint(policy: EndpointPolicy, value: string, fallback: string): string {
    try {
      return policy.normalize(value);
    } catch {
      return fallback;
    }
  }
  private positiveInt(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
  }
  private range(value: unknown, fallback: number, min: number, max: number): number {
    return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
      ? value
      : fallback;
  }
  private sanitizeApprovals(value: unknown): readonly EndpointApproval[] {
    if (!Array.isArray(value)) return DEFAULT_SETTINGS.approvedOrigins;
    const result: EndpointApproval[] = [];
    for (const candidate of value) {
      if (!candidate || typeof candidate !== "object") continue;
      const item = candidate as Partial<EndpointApproval>;
      const port = item.port as number;
      if (
        (item.scheme !== "http" && item.scheme !== "https") ||
        typeof item.host !== "string" ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
      )
        continue;
      const approval = {
        scheme: item.scheme,
        host: item.host.toLowerCase(),
        port,
      } as EndpointApproval;
      try {
        new EndpointPolicy({ approvals: [approval] }).normalize(
          `${approval.scheme}://${this.formatHost(approval.host)}:${approval.port}/v1`
        );
      } catch {
        continue;
      }
      if (
        !result.some(
          (v) =>
            v.scheme === approval.scheme && v.host === approval.host && v.port === approval.port
        )
      )
        result.push(approval);
    }
    return result;
  }
  private formatHost(host: string): string {
    return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  }
  /** Returns the current settings snapshot for persistence or model construction. */
  get(): TramaSettings {
    return this.value;
  }
  /** Normalizes and validates a candidate without changing the committed snapshot. */
  stage(next: TramaSettings): TramaSettings {
    const approvals = this.sanitizeApprovals(next.approvedOrigins);
    const policy = new EndpointPolicy({ approvals });
    const chatEndpoint = policy.normalize(next.chat.endpoint);
    const embeddingEndpoint = policy.normalize(next.embedding.endpoint);
    return {
      schemaVersion: 1,
      chat: Object.freeze({ ...next.chat, endpoint: chatEndpoint }),
      embedding: Object.freeze({ ...next.embedding, endpoint: embeddingEndpoint }),
      approvedOrigins: Object.freeze(approvals.map((v) => Object.freeze({ ...v }))),
    };
  }
  /** Commits a previously staged snapshot after its persistence succeeds. */
  commit(next: TramaSettings): TramaSettings {
    this.value = next;
    return this.value;
  }
  /** Validates both independent endpoints and returns a persistable snapshot. */
  save(next: TramaSettings): TramaSettings {
    return this.commit(this.stage(next));
  }
}
