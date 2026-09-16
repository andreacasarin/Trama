import { EndpointApproval, EndpointPolicy } from "@/security/EndpointPolicy";
import {
  DEFAULT_PUBLICATION_DIRECTORY,
  normalizePublicationDirectory as normalizeStoredPublicationDirectory,
} from "@/index/publications/PublicationStore";

/** Normalizes the synchronized SQLite publication folder. Invalid persisted values use the safe default. */
export function normalizePublicationDirectory(value: unknown): string {
  return normalizeStoredPublicationDirectory(value);
}

export interface ChatSettings {
  readonly endpoint: string;
  readonly modelId: string;
  readonly temperature: number;
  readonly maxOutputTokens?: number;
  readonly reasoningEffort?: "none" | "low" | "medium" | "high";
}
export interface EmbeddingSettings {
  readonly endpoint: string;
  readonly modelId: string;
  readonly dimensions: number;
  readonly batchSize: number;
}
export type LenteSearchMethod = "hybrid" | "keyword";
export interface LenteSettings {
  readonly searchMethod: LenteSearchMethod;
  readonly maxResults: number;
  readonly automaticSearchDelayMs: number;
}
export interface FiloSettings {
  readonly automaticUpdates: boolean;
  readonly excludedPaths: readonly string[];
}
export interface TramaSettings {
  readonly schemaVersion: 4;
  readonly publicationDirectory: string;
  readonly chat: ChatSettings;
  readonly embedding: EmbeddingSettings;
  readonly lente: LenteSettings;
  readonly filo: FiloSettings;
  readonly approvedOrigins: readonly EndpointApproval[];
  readonly detailedDebug: boolean;
}

type ReasoningEffort = "none" | "low" | "medium" | "high";
const LENTE_SEARCH_METHODS = ["hybrid", "keyword"] as const;

function isLenteSearchMethod(value: unknown): value is LenteSearchMethod {
  return LENTE_SEARCH_METHODS.includes(value as LenteSearchMethod);
}

function isValidLenteMaxResults(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 5 &&
    value <= 50 &&
    value % 5 === 0
  );
}

function isValidLenteAutomaticSearchDelay(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 1000 &&
    value % 50 === 0
  );
}

/** Normalizes one vault-relative file or directory path, or returns undefined when invalid. */
export function normalizeExcludedPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.includes("\0")) return undefined;
  let raw = value.trim().replace(/\\/g, "/");
  while (raw.startsWith("./")) raw = raw.slice(2);
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return undefined;
  const parts = raw
    .split("/")
    .map((part: string) => part.trim())
    .filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return undefined;
  return parts.join("/");
}

/** Normalizes, sorts, and deduplicates vault-relative exclusions without touching the vault. */
export function normalizeExcludedPaths(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.map(normalizeExcludedPath).filter((path): path is string => !!path)),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Returns whether a vault-relative file is itself or below an excluded file/directory path. */
export function isExcludedPath(path: unknown, excludedPaths: readonly string[]): boolean {
  const normalizedPath = normalizeExcludedPath(path);
  if (!normalizedPath) return false;
  return normalizeExcludedPaths(excludedPaths).some(
    (excluded) => normalizedPath === excluded || normalizedPath.startsWith(`${excluded}/`)
  );
}

function isValidTemperature(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1 &&
    Number.isInteger(value * 10)
  );
}

function isValidMaxOutputTokens(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1024 &&
    value <= 131072 &&
    value % 1024 === 0
  );
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "none" || value === "low" || value === "medium" || value === "high";
}

export const DEFAULT_SETTINGS: TramaSettings = Object.freeze({
  schemaVersion: 4,
  publicationDirectory: DEFAULT_PUBLICATION_DIRECTORY,
  chat: Object.freeze({
    endpoint: "http://127.0.0.1:1234/v1",
    modelId: "",
    temperature: 0.7,
  }),
  embedding: Object.freeze({
    endpoint: "http://127.0.0.1:1234/v1",
    modelId: "",
    dimensions: 768,
    batchSize: 32,
  }),
  lente: Object.freeze({
    searchMethod: "hybrid",
    maxResults: 20,
    automaticSearchDelayMs: 0,
  }),
  filo: Object.freeze({
    automaticUpdates: false,
    excludedPaths: Object.freeze([]),
  }),
  approvedOrigins: Object.freeze([]),
  detailedDebug: false,
});

/** Owns the versioned, non-secret settings persisted through Obsidian plugin data. */
export class SettingsStore {
  private value: TramaSettings = DEFAULT_SETTINGS;
  /** Loads and sanitizes plugin data without performing network I/O. */
  load(data: unknown): TramaSettings {
    if (
      !data ||
      typeof data !== "object" ||
      ![2, 3, 4].includes((data as { schemaVersion?: unknown }).schemaVersion as number)
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
    const rawLente = (input.lente && typeof input.lente === "object" ? input.lente : {}) as Record<
      string,
      unknown
    >;
    const rawFilo = (input.filo && typeof input.filo === "object" ? input.filo : {}) as Record<
      string,
      unknown
    >;
    const publicationDirectory = normalizeStoredPublicationDirectory(
      (input as { publicationDirectory?: unknown }).publicationDirectory
    );
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
      temperature: isValidTemperature(rawChat.temperature)
        ? rawChat.temperature
        : DEFAULT_SETTINGS.chat.temperature,
      ...this.optionalMaxOutputTokens(rawChat.maxOutputTokens),
      ...this.optionalReasoningEffort(rawChat.reasoningEffort),
    };
    const embedding = {
      endpoint: this.safeEndpoint(policy, embeddingEndpoint, DEFAULT_SETTINGS.embedding.endpoint),
      modelId: this.string(rawEmbedding.modelId, DEFAULT_SETTINGS.embedding.modelId),
      dimensions: this.positiveInt(rawEmbedding.dimensions, DEFAULT_SETTINGS.embedding.dimensions),
      batchSize: this.positiveInt(rawEmbedding.batchSize, DEFAULT_SETTINGS.embedding.batchSize),
    };
    const lente = {
      searchMethod: isLenteSearchMethod(rawLente.searchMethod)
        ? rawLente.searchMethod
        : DEFAULT_SETTINGS.lente.searchMethod,
      maxResults: isValidLenteMaxResults(rawLente.maxResults)
        ? rawLente.maxResults
        : DEFAULT_SETTINGS.lente.maxResults,
      automaticSearchDelayMs: isValidLenteAutomaticSearchDelay(rawLente.automaticSearchDelayMs)
        ? rawLente.automaticSearchDelayMs
        : DEFAULT_SETTINGS.lente.automaticSearchDelayMs,
    };
    const filo = {
      automaticUpdates: rawFilo.automaticUpdates === true,
      excludedPaths: Object.freeze(normalizeExcludedPaths(rawFilo.excludedPaths)),
    };
    this.value = {
      schemaVersion: 4,
      publicationDirectory,
      chat: Object.freeze(chat),
      embedding: Object.freeze(embedding),
      lente: Object.freeze(lente),
      filo: Object.freeze(filo),
      approvedOrigins: Object.freeze(
        approvals.map((v) => ({ scheme: v.scheme, host: v.host.toLowerCase(), port: v.port }))
      ),
      detailedDebug: input.detailedDebug === true,
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
  private optionalMaxOutputTokens(value: unknown): { maxOutputTokens?: number } {
    return isValidMaxOutputTokens(value) ? { maxOutputTokens: value } : {};
  }
  private optionalReasoningEffort(value: unknown): {
    reasoningEffort?: "none" | "low" | "medium" | "high";
  } {
    return isReasoningEffort(value) ? { reasoningEffort: value } : {};
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
    const chatControls = this.validateChatControls(next.chat);
    const lente = this.validateLente(next.lente);
    const publicationDirectory = this.strictPublicationDirectory(next.publicationDirectory);
    return {
      schemaVersion: 4,
      publicationDirectory,
      chat: Object.freeze({
        endpoint: chatEndpoint,
        modelId: next.chat.modelId,
        ...chatControls,
      }),
      embedding: Object.freeze({ ...next.embedding, endpoint: embeddingEndpoint }),
      lente: Object.freeze(lente),
      filo: Object.freeze({
        automaticUpdates: next.filo.automaticUpdates === true,
        excludedPaths: Object.freeze(normalizeExcludedPaths(next.filo.excludedPaths)),
      }),
      approvedOrigins: Object.freeze(approvals.map((v) => Object.freeze({ ...v }))),
      detailedDebug: next.detailedDebug === true,
    };
  }
  private strictPublicationDirectory(value: unknown): string {
    const normalized = normalizeStoredPublicationDirectory(value, "");
    if (!normalized || normalized === "")
      throw new Error("Publication directory must be a valid vault-relative folder.");
    return normalized;
  }
  private validateLente(lente: LenteSettings): LenteSettings {
    if (!isLenteSearchMethod(lente.searchMethod)) {
      throw new Error("Lente search method must be hybrid or keyword.");
    }
    if (!isValidLenteMaxResults(lente.maxResults)) {
      throw new Error("Lente maximum displayed results must be from 5 to 50 in increments of 5.");
    }
    if (!isValidLenteAutomaticSearchDelay(lente.automaticSearchDelayMs)) {
      throw new Error(
        "Lente automatic search delay must be from 0 to 1000 ms in increments of 50."
      );
    }
    return {
      searchMethod: lente.searchMethod,
      maxResults: lente.maxResults,
      automaticSearchDelayMs: lente.automaticSearchDelayMs,
    };
  }
  private validateChatControls(
    chat: ChatSettings
  ): Pick<ChatSettings, "temperature" | "maxOutputTokens" | "reasoningEffort"> {
    if (!isValidTemperature(chat.temperature)) {
      throw new Error("Chat temperature must be a finite number from 0 to 1 in 0.1 increments.");
    }
    if (chat.maxOutputTokens !== undefined && !isValidMaxOutputTokens(chat.maxOutputTokens)) {
      throw new Error("Chat maxOutputTokens must be a multiple of 1024 between 1024 and 131072.");
    }
    if (chat.reasoningEffort !== undefined && !isReasoningEffort(chat.reasoningEffort)) {
      throw new Error("Chat reasoningEffort must be none, low, medium, or high.");
    }
    return {
      temperature: chat.temperature,
      ...(chat.maxOutputTokens === undefined ? {} : { maxOutputTokens: chat.maxOutputTokens }),
      ...(chat.reasoningEffort === undefined ? {} : { reasoningEffort: chat.reasoningEffort }),
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
