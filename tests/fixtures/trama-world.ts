import type { EmbeddingModel, ReadonlyVault } from "@/domain/contracts";
import type { TramaDiagnosticInput as TramaDiagnosticRecord } from "@/diagnostics/TramaDiagnostics";
import { IndexManager, type IndexVaultPort } from "@/index/IndexManager";
import { LenteSearch } from "@/index/LenteSearch";
import { RelatedNotes } from "@/index/RelatedNotes";
import { PublicationManager } from "@/index/publications/PublicationManager";
import {
  PublicationStore,
  type PublicationDataAdapter,
} from "@/index/publications/PublicationStore";
import { ReadNoteTool, ToolRegistry, VaultSearchTool } from "@/tools/ToolRegistry";
import { createTestSqliteClient } from "../sqlite-test-client";

export const FEATURE_NOTES = Object.freeze({
  "Atlas/Garden.md": "# Garden\nAlpha garden notes link to [[Seeds]].",
  "Atlas/Seeds.md": "# Seeds\nAlpha garden seeds and planting calendar.",
  "Kitchen/Pasta.md": "# Pasta\nBeta cooking notes for fresh pasta.",
  "Unicode/東京.md": "# 東京\nNaïve café observations from Tokyo.",
  ".trama/Excluded.md": "PRIVATE_FIXTURE_SENTINEL alpha garden",
});

const signal = new AbortController().signal;

class FixtureEmbedding implements EmbeddingModel {
  readonly dimensions = 4;
  calls = 0;
  async embed(texts: readonly string[]): Promise<readonly number[][]> {
    this.calls += texts.length;
    return texts.map((text) => {
      const lower = text.toLowerCase();
      const vector = [
        Number(lower.includes("alpha") || lower.includes("garden")),
        Number(lower.includes("beta") || lower.includes("pasta")),
        Number(lower.includes("tokyo") || lower.includes("東京")),
        0.1,
      ];
      const norm = Math.hypot(...vector);
      return vector.map((value) => value / norm);
    });
  }
}

class FixtureVault implements IndexVaultPort, ReadonlyVault {
  readonly notes = new Map<string, string>(Object.entries(FEATURE_NOTES));
  readonly mtimes = new Map([...this.notes.keys()].map((path, index) => [path, index + 1]));

  async listMarkdownPaths(): Promise<readonly string[]> {
    return [...this.notes.keys()];
  }
  async readMarkdown(path: string): Promise<{ path: string; content: string }> {
    return { path, content: this.required(path) };
  }
  async isMarkdownAvailable(path: string): Promise<boolean> {
    return this.notes.has(path);
  }
  isIndexEligible(path: string): boolean {
    return !path.startsWith(".trama/");
  }
  async readNote(path: string) {
    const content = this.required(path);
    return { path, content, startLine: 1, endLine: content.split("\n").length };
  }
  async currentNotePath(): Promise<string> {
    return "Atlas/Garden.md";
  }
  async resolveLink(link: string): Promise<string | null> {
    return link === "Seeds" ? "Atlas/Seeds.md" : null;
  }
  async discoverLinks() {
    return [{ link: "Seeds", sourcePath: "Atlas/Garden.md", targetPath: "Atlas/Seeds.md" }];
  }
  set(path: string, content: string): void {
    this.notes.set(path, content);
    this.mtimes.set(path, Math.max(0, ...this.mtimes.values()) + 1);
  }
  delete(path: string): void {
    this.notes.delete(path);
    this.mtimes.delete(path);
  }
  rename(from: string, to: string): void {
    const content = this.required(from);
    this.delete(from);
    this.set(to, content);
  }
  private required(path: string): string {
    const content = this.notes.get(path);
    if (content === undefined) throw new Error(`Missing fixture note: ${path}`);
    return content;
  }
}

class FixturePublicationAdapter implements PublicationDataAdapter {
  readonly files = new Map<string, Uint8Array>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.files.get(path);
    if (!value) throw new Error(`Missing fixture publication: ${path}`);
    return value.slice().buffer;
  }
  async writeBinary(path: string, value: ArrayBuffer): Promise<void> {
    this.files.set(path, new Uint8Array(value.slice(0)));
  }
  async mkdir(): Promise<void> {
    // The in-memory adapter does not need directories.
  }
  async rename(oldPath: string, newPath: string): Promise<void> {
    const value = this.files.get(oldPath);
    if (!value) throw new Error(`Missing fixture staged publication: ${oldPath}`);
    this.files.set(newPath, value);
    this.files.delete(oldPath);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}

export class TramaTestWorld {
  readonly vault = new FixtureVault();
  readonly embedding = new FixtureEmbedding();
  readonly diagnostics: TramaDiagnosticRecord[] = [];
  readonly publicationAdapter = new FixturePublicationAdapter();
  readonly index: IndexManager;
  readonly publicationManager: PublicationManager;
  readonly lente: LenteSearch;
  readonly filo: RelatedNotes;
  readonly tools: ToolRegistry;

  constructor(identity: object = {}) {
    this.index = new IndexManager(
      this.vault,
      this.embedding,
      "http://fixture.invalid/v1",
      "fixture",
      {
        sqliteClient: createTestSqliteClient(identity),
        publicationDirectory: "Trama/index",
      },
      { enabled: () => true, emit: (record) => this.diagnostics.push(record) }
    );
    this.publicationManager = new PublicationManager(
      this.index,
      new PublicationStore(this.publicationAdapter, {
        directory: "Trama/index",
        temporaryToken: () => "fixture",
      })
    );
    this.lente = new LenteSearch(this.index, {
      getMtime: (path) => this.vault.mtimes.get(path) ?? null,
    });
    this.filo = new RelatedNotes(this.index);
    this.tools = new ToolRegistry([new ReadNoteTool(this.vault), new VaultSearchTool(this.index)]);
  }

  async build(): Promise<void> {
    await this.index.build(signal);
    const state = await this.index.getState();
    if (state) {
      if (!state.incomplete) await this.publicationManager.publish();
    }
  }
  async update(): Promise<void> {
    this.index.requestFullRecovery();
    const result = await this.index.synchronize(signal);
    const state = await this.index.getState();
    if (state) {
      if (result.changed && result.converged) await this.publicationManager.publish();
    }
  }

  async prepare(): Promise<void> {
    const result = await this.index.prepareSemantic(signal);
    if (result.changed && result.converged) await this.publicationManager.publish();
  }
}
