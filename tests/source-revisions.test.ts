import { describe, it, expect } from "vitest";
import { ManualIndex } from "@/index/ManualIndex";
import { SqliteNoteVectorStore } from "@/index/SqliteNoteVectorStore";
import { SqliteNoteRecordManager } from "@/index/SqliteNoteRecordManager";
import { NoteSqliteDatabase } from "@/index/note-sqlite/database";
import { ObsidianIndexVault } from "@/vault/indexing/ObsidianIndexVault";
import { loadTestSqlite } from "./note-sqlite-test-client";

describe("persisted note source revisions", () => {
  it("skips unchanged bodies across runs and handles changes, rename, exclusion and deletion", async () => {
    const sqlite = await loadTestSqlite();
    const connection = new sqlite.oo1.DB(":memory:", "c");
    const statements: string[] = [];
    const database = new NoteSqliteDatabase({
      exec: (value: any) => {
        statements.push(typeof value === "string" ? value : value.sql);
        connection.exec(value);
      },
      close: () => connection.close(),
    });
    const files = new Map<string, any>(
      ["a.md", "b.md"].map((path) => [
        path,
        { path, content: path, stat: { mtime: 1, ctime: 1, size: 4 } },
      ])
    );
    let reads: string[] = [];
    let exclude = "";
    const vault = new ObsidianIndexVault(
      {
        getMarkdownFiles: () => [...files.values()],
        getFileByPath: (path) => files.get(path) ?? null,
        read: async (file) => {
          reads.push(file.path);
          return files.get(file.path).content;
        },
      },
      (path) => path !== exclude
    );
    const embeddings = {
      embedDocuments: async (texts: string[]) => texts.map(() => [1, 0]),
      embedQuery: async () => [1, 0],
    };
    const store = new SqliteNoteVectorStore(
      embeddings,
      database.call.bind(database),
      async () => null,
      { endpoint: "http://localhost/v1", modelId: "revision", dimensions: 2 }
    );
    const run = (verify = false) =>
      new ManualIndex(
        vault,
        store,
        new SqliteNoteRecordManager(database.call.bind(database))
      ).update(verify);
    try {
      await run();
      reads = [];
      statements.length = 0;
      expect((await run()).numSkipped).toBe(2);
      expect(reads).toEqual([]);
      expect(
        statements.some(
          (sql) => sql.includes("CROSS JOIN note_sources") && sql.includes("CROSS JOIN note_index")
        )
      ).toBe(true);
      expect(
        statements.some(
          (sql) => sql.includes("UPDATE note_records") && sql.includes("RETURNING group_path")
        )
      ).toBe(true);
      expect(statements.some((sql) => /SELECT.*(?:vector|centroid)/i.test(sql))).toBe(false);
      files.get("a.md").content = "changed";
      files.get("a.md").stat.mtime++;
      expect((await run()).numAdded).toBe(1);
      expect(reads).toEqual(["a.md"]);
      reads = [];
      const renamed = { ...files.get("a.md"), path: "renamed.md" };
      files.delete("a.md");
      files.set("renamed.md", renamed);
      expect((await run()).deleted).toBe(1);
      expect(reads).toEqual(["renamed.md"]);
      exclude = "b.md";
      expect((await run()).deleted).toBe(1);
      files.clear();
      expect((await run()).deleted).toBe(1);
      expect(connection.selectValue("SELECT count(*) FROM note_sources")).toBe(0);
    } finally {
      connection.close();
    }
  });

  it("does not remember a revision when the note changes while it is read", async () => {
    const file = { path: "note.md", stat: { mtime: 1, ctime: 1, size: 4 } };
    const vault = new ObsidianIndexVault({
      getMarkdownFiles: () => [file] as any,
      getFileByPath: () => file as any,
      read: async () => {
        file.stat.mtime++;
        return "body";
      },
    });
    expect(await vault.readMarkdown(file.path, new AbortController().signal)).not.toHaveProperty(
      "revision"
    );
  });
});
