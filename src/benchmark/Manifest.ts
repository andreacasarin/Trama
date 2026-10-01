export const BENCHMARK_MARKER = ".trama-benchmark-vault";
export const BENCHMARK_REPORT = ".trama-benchmark-report.json";
export const BENCHMARK_MARKER_VERSION = "trama-obsidian-vault-v1";
export const BENCHMARK_VAULT_NAME = "Trama Benchmark Vault";
const SOURCE_DIGESTS = {
  "trama-small": "86174d77fdec03cec1fae47980dabe682817e1b6bcb9acecf110cedb56060d37",
  "trama-10k": "822ac8dce2629647387b9f90eea2aca6980e90cc1355e5d5ef049af01436bff9",
  "trama-large": "d34ca817aac3605e20960644c6dd1964f97ae9df3ef05aaca13a8fd5b1ded108",
} as const;
const PROVIDER_DIGEST = "da609bed7a65f51e21ed579971f02dab7d70eb60dbeecc34dc72a3e441983747";
const QUERY_DIGEST = "7b0fa73abfdf474642ea98dac60e72c29c5566e5814f760c8365c5e3b3fe118b";

export interface BenchmarkMutation {
  readonly kind: "add" | "modify" | "delete" | "rename";
  readonly path: string;
  readonly to?: string;
  readonly content?: string;
}

export interface BenchmarkManifest {
  readonly version: typeof BENCHMARK_MARKER_VERSION;
  readonly runId: string;
  readonly vaultName: string;
  readonly expectedPath: string;
  readonly profile: "trama-small" | "trama-10k" | "trama-large";
  readonly noteCount: number;
  readonly targetChunks: number;
  readonly sourceDigest: string;
  readonly providerChallengeSha256: string;
  readonly queryVectorSha256: string;
  readonly mutations: readonly BenchmarkMutation[];
  readonly timeoutMs: number;
}

const PATH = /^(?!\.)(?!.*(?:^|\/)\.\.?(?:\/|$))[\p{L}\p{N}_ ./\-😀Ä]+\.md$/u;
function safePath(value: unknown): value is string {
  return (
    typeof value === "string" && value.length < 256 && PATH.test(value) && !value.startsWith("/")
  );
}

export function parseBenchmarkManifest(raw: string, vaultName: string): BenchmarkManifest | null {
  try {
    const value = JSON.parse(raw) as Partial<BenchmarkManifest>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.version !== BENCHMARK_MARKER_VERSION || value.vaultName !== vaultName) return null;
    if (typeof value.runId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.runId)) return null;
    const profiles = {
      "trama-small": [24, 128],
      "trama-10k": [1100, 10000],
      "trama-large": [2750, 25000],
    } as const;
    if (!value.profile || !(value.profile in profiles)) return null;
    if (value.vaultName !== BENCHMARK_VAULT_NAME) return null;
    if (
      typeof value.expectedPath !== "string" ||
      !value.expectedPath.endsWith(`/.artifacts/test-vaults/benchmark/${value.vaultName}`) ||
      value.expectedPath.includes("/../")
    )
      return null;
    const [notes, chunks] = profiles[value.profile];
    if (value.noteCount !== notes || value.targetChunks !== chunks) return null;
    if (value.sourceDigest !== SOURCE_DIGESTS[value.profile]) return null;
    if (value.providerChallengeSha256 !== PROVIDER_DIGEST) return null;
    if (value.queryVectorSha256 !== QUERY_DIGEST) return null;
    if (
      !Number.isSafeInteger(value.timeoutMs) ||
      value.timeoutMs! < 1000 ||
      value.timeoutMs! > 3_600_000
    )
      return null;
    if (!Array.isArray(value.mutations) || value.mutations.length !== 4) return null;
    const kinds = ["add", "modify", "delete", "rename"];
    for (let i = 0; i < 4; i++) {
      const mutation = value.mutations[i];
      if (!mutation || mutation.kind !== kinds[i] || !safePath(mutation.path)) return null;
      if (mutation.kind === "rename" ? !safePath(mutation.to) : mutation.to !== undefined)
        return null;
      if (mutation.kind === "add" || mutation.kind === "modify") {
        if (typeof mutation.content !== "string" || mutation.content.length > 100_000) return null;
      } else if (mutation.content !== undefined) return null;
    }
    return value as BenchmarkManifest;
  } catch {
    return null;
  }
}

export async function readBenchmarkManifest(
  adapter: { read(path: string): Promise<string> },
  vaultName: string
): Promise<BenchmarkManifest | null> {
  try {
    return parseBenchmarkManifest(await adapter.read(BENCHMARK_MARKER), vaultName);
  } catch {
    return null;
  }
}
