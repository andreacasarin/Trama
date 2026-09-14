import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { ChatSession } from "@/chat/ChatSession";
import type { ChatModel, EmbeddingModel, ReadonlyVault } from "@/domain/contracts";
import { IndexManager, type IndexVaultPort, type SnapshotDataAdapter } from "@/index/IndexManager";
import { LenteSearch } from "@/index/LenteSearch";
import { RelatedNotes } from "@/index/RelatedNotes";
import { ToolRegistry, VaultSearchTool } from "@/tools/ToolRegistry";
import { createTestSqliteClient } from "../sqlite-test-client";
import type { Workload, WorkloadMutation, WorkloadNote } from "./generator";

export interface TramaBenchmark {
  readonly profile: string;
  readonly seed: number;
  readonly notes: number;
  readonly chunks: number;
  readonly durationMs: Readonly<Record<string, number>>;
  readonly latencyMs: Readonly<Record<string, { p50: number; p95: number }>>;
  readonly counts: Readonly<Record<string, number>>;
  readonly bytes: Readonly<Record<string, number | "unsupported">>;
  readonly unsupported: readonly string[];
}

const signal = new AbortController().signal;
const percentile = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
};
const elapsed = async (operation: () => Promise<unknown>): Promise<number> => {
  const started = performance.now();
  await operation();
  return performance.now() - started;
};
const latency = async (operation: () => Promise<unknown>, samples = 5) => {
  const values: number[] = [];
  for (let sample = 0; sample < samples; sample++) values.push(await elapsed(operation));
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
};

class BenchmarkVault implements IndexVaultPort, ReadonlyVault {
  readonly notes = new Map<string, string>();
  readonly mtimes = new Map<string, number>();

  constructor(notes: readonly WorkloadNote[]) {
    for (const note of notes) this.set(note.path, note.content);
  }

  set(path: string, content: string): void {
    this.notes.set(path, content);
    this.mtimes.set(path, (this.mtimes.get(path) ?? this.mtimes.size) + 1);
  }
  apply(mutation: WorkloadMutation): void {
    if (mutation.kind === "add" || mutation.kind === "modify")
      this.set(mutation.path, mutation.note!.content);
    if (mutation.kind === "delete") {
      this.notes.delete(mutation.path);
      this.mtimes.delete(mutation.path);
    }
    if (mutation.kind === "rename" && mutation.to) {
      const content = this.notes.get(mutation.path);
      this.notes.delete(mutation.path);
      this.mtimes.delete(mutation.path);
      if (content !== undefined) this.set(mutation.to, content);
    }
  }
  async listMarkdownPaths(): Promise<readonly string[]> {
    return [...this.notes.keys()];
  }
  async readMarkdown(path: string): Promise<{ path: string; content: string }> {
    return { path, content: this.required(path) };
  }
  async isMarkdownAvailable(path: string): Promise<boolean> {
    return this.notes.has(path);
  }
  async readNote(path: string) {
    const content = this.required(path);
    return { path, content, startLine: 1, endLine: content.split("\n").length };
  }
  async currentNotePath(): Promise<string | null> {
    return this.notes.keys().next().value ?? null;
  }
  async resolveLink(): Promise<string | null> {
    return null;
  }
  async discoverLinks(): Promise<readonly []> {
    return [];
  }
  private required(path: string): string {
    const content = this.notes.get(path);
    if (content === undefined) throw new Error(`Missing benchmark note: ${path}`);
    return content;
  }
}

class BenchmarkEmbedding implements EmbeddingModel {
  readonly dimensions = 768;
  private readonly vectors = new Map<string, Float32Array>();

  constructor(workload: Workload) {
    for (const note of [
      ...workload.notes,
      ...workload.mutations.flatMap((mutation) => (mutation.note ? [mutation.note] : [])),
    ])
      for (const chunk of note.chunks) this.vectors.set(chunk.text, chunk.vector);
    for (const query of workload.queries) this.vectors.set(query.text, query.vector);
  }

  async embed(texts: readonly string[]): Promise<readonly number[][]> {
    return texts.map((text) => Array.from(this.vectors.get(text) ?? this.fallback()));
  }

  private fallback(): Float32Array {
    const vector = new Float32Array(this.dimensions);
    vector[0] = 1;
    return vector;
  }
}

class MemorySnapshots implements SnapshotDataAdapter {
  readonly binary = new Map<string, ArrayBuffer>();
  async exists(path: string): Promise<boolean> {
    return this.binary.has(path);
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.binary.get(path);
    if (!value) throw new Error(`Missing benchmark snapshot: ${path}`);
    return value.slice(0);
  }
  async writeBinary(path: string, value: ArrayBuffer): Promise<void> {
    this.binary.set(path, value.slice(0));
  }
}

function packageBytes(): number | "unsupported" {
  try {
    return [
      "main.js",
      "sqlite-worker.mjs",
      "sqlite3.mjs",
      "sqlite3.wasm",
      "manifest.json",
      "styles.css",
    ].reduce((sum, file) => sum + statSync(file).size, 0);
  } catch {
    return "unsupported";
  }
}

function manager(
  vault: BenchmarkVault,
  embedding: BenchmarkEmbedding,
  snapshots: MemorySnapshots,
  identity: object
): IndexManager {
  return new IndexManager(vault, embedding, snapshots, "http://benchmark.invalid/v1", "fixture", {
    sqliteClient: createTestSqliteClient(identity, { persistMutations: false }),
    snapshotAdapter: snapshots,
  });
}

export async function runTramaBenchmark(workload: Workload): Promise<TramaBenchmark> {
  const rssBefore = process.memoryUsage().rss;
  const vault = new BenchmarkVault(workload.notes);
  const embedding = new BenchmarkEmbedding(workload);
  const snapshots = new MemorySnapshots();
  const index = manager(vault, embedding, snapshots, {});
  const durationMs: Record<string, number> = {};

  durationMs.fullBuild = await elapsed(() => index.build(signal));
  const initialState = await index.getState();
  durationMs.unchangedUpdate = await elapsed(() => index.synchronize(signal));

  const lente = new LenteSearch(index, { getMtime: (path) => vault.mtimes.get(path) ?? null });
  const query = workload.queries.find((candidate) => candidate.id === "hostile")!;
  const latencyMs = {
    lexical: await latency(() => lente.search(query.text, { searchMethod: "keyword" })),
    hybrid: await latency(() => lente.search(query.text)),
    filo: await latency(() =>
      new RelatedNotes(index).find(workload.notes[0].path, signal, 7, true)
    ),
    voce: await latency(() => new VaultSearchTool(index).execute({ query: query.text }, signal)),
  };

  for (const mutation of workload.mutations) {
    if (mutation.kind !== "unchanged") vault.apply(mutation);
    index.queueChange();
    durationMs[`${mutation.kind}Update`] = await elapsed(() => index.synchronize(signal));
  }

  const snapshot = await index.exportSnapshot();
  const restarted = manager(vault, embedding, snapshots, {});
  durationMs.snapshotRestore = await elapsed(async () => {
    await restarted.load();
    await restarted.importSnapshot(snapshot);
  });

  let round = 0;
  const chatModel: ChatModel = {
    complete: async () =>
      round++ === 0
        ? {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "search", name: "vault_search", arguments: { query: query.text } }],
            },
            finishReason: "tool_calls",
          }
        : { message: { role: "assistant", content: "done" }, finishReason: "stop" },
  };
  durationMs.chatToolTurn = await elapsed(() =>
    new ChatSession(chatModel, new ToolRegistry([new VaultSearchTool(restarted)]), vault).send({
      content: "Find relevant notes",
      attachmentPaths: [],
    })
  );

  const rssAfter = process.memoryUsage().rss;
  const finalState = await restarted.getState();
  await index.dispose();
  await restarted.dispose();
  return {
    profile: workload.profile.id,
    seed: workload.seed,
    notes: workload.notes.length,
    chunks: workload.notes.reduce((sum, note) => sum + note.chunks.length, 0),
    durationMs,
    latencyMs,
    counts: {
      initialIndexedNotes: initialState?.noteCount ?? 0,
      initialIndexedChunks: initialState?.chunkCount ?? 0,
      finalIndexedNotes: finalState?.noteCount ?? 0,
      finalIndexedChunks: finalState?.chunkCount ?? 0,
    },
    bytes: {
      package: packageBytes(),
      snapshot: snapshot.size,
      processRssDelta: rssAfter - rssBefore,
    },
    unsupported: ["OPFS restart", "real LM Studio inference", "real Obsidian UI"],
  };
}
