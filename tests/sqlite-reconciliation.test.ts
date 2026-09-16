import { describe, expect, it } from "vitest";
import { MutableSqliteDatabase } from "@/index/sqlite/database";
import { loadTestSqlite } from "./sqlite-test-client";

const id = (letter: string) => letter.repeat(64);

async function openIndex() {
  const sqlite = await loadTestSqlite();
  const database = new sqlite.oo1.DB(":memory:", "c");
  const index = new MutableSqliteDatabase(database);
  index.boot(id("f"), 2);
  return { index, database };
}

describe("mutable SQLite reconciliation", () => {
  it("makes rename, delete, and replay acknowledgements idempotent", async () => {
    const { index, database } = await openIndex();
    index.upsertNote({
      path: "old.md",
      contentId: id("a"),
      chunks: [
        {
          id: `${id("a")}:0`,
          ordinal: 0,
          startLine: 1,
          endLine: 1,
          text: "same",
          vector: new Float32Array([1, 0]),
        },
      ],
    });
    expect(index.renameNote("old.md", "new.md", id("a")).status).toBe("changed");
    expect(index.renameNote("old.md", "new.md", id("a")).status).toBe("alreadyApplied");
    expect(index.deleteNote("missing.md")).toMatchObject({ changed: false, status: "absent" });
    index.upsertNote({ path: "other.md", contentId: id("b"), chunks: [] });
    expect(index.renameNote("new.md", "other.md", id("a"))).toMatchObject({
      changed: false,
      status: "state_changed",
      rescan: true,
    });
    index.close();
    database.close();
  });

  it("finishes only from an exact sorted summary and persists empty notes", async () => {
    const { index, database } = await openIndex();
    index.upsertNote({ path: "empty.md", contentId: id("e"), chunks: [] });
    expect(
      index.finishReconciliation(
        [{ path: "empty.md", contentId: id("x"), chunkCount: 0 }],
        index.getState().changeCounter
      ).incomplete
    ).toBe(true);
    expect(
      index.finishReconciliation(
        [{ path: "empty.md", contentId: id("e"), chunkCount: 1 }],
        index.getState().changeCounter
      ).incomplete
    ).toBe(true);
    expect(
      index.finishReconciliation(
        [{ path: "empty.md", contentId: id("e") }],
        index.getState().changeCounter
      ).incomplete
    ).toBe(false);
    index.markIncomplete();
    expect(
      index.finishReconciliation(
        [{ path: "empty.md", contentId: id("e"), chunkCount: 0 }],
        index.getState().changeCounter
      ).incomplete
    ).toBe(false);
    expect(index.getState().incomplete).toBe(false);
    index.close();
    database.close();
  });

  it("plans deterministic renames, upserts, and deletes inside SQLite", async () => {
    const { index, database } = await openIndex();
    index.upsertNote({ path: "old.md", contentId: id("a"), chunks: [] });
    index.upsertNote({ path: "changed.md", contentId: id("b"), chunks: [] });
    index.upsertNote({ path: "gone.md", contentId: id("c"), chunks: [] });
    index.finishReconciliation(
      [
        { path: "changed.md", contentId: id("b") },
        { path: "gone.md", contentId: id("c") },
        { path: "old.md", contentId: id("a") },
      ],
      index.getState().changeCounter
    );

    const plan = index.planReconciliation([
      { path: "added.md", contentId: id("d") },
      { path: "changed.md", contentId: id("e") },
      { path: "new.md", contentId: id("a") },
    ]);

    expect(plan).toMatchObject({
      renames: [{ from: "old.md", to: "new.md", contentId: id("a") }],
      upserts: [
        { path: "added.md", contentId: id("d") },
        { path: "changed.md", contentId: id("e") },
      ],
      deletes: [{ path: "gone.md", contentId: id("c") }],
      state: { incomplete: true },
    });
    index.close();
    database.close();
  });

  it("preserves a published state across Worker restart", async () => {
    const { index, database } = await openIndex();
    index.upsertNote({ path: "note.md", contentId: id("d"), chunks: [] });
    const published = index.finishReconciliation(
      [{ path: "note.md", contentId: id("d"), chunkCount: 0 }],
      index.getState().changeCounter
    );
    expect(published.incomplete).toBe(false);
    const reopened = index.boot(id("f"), 2);
    expect(reopened).toMatchObject({ incomplete: false, noteCount: 1 });
    expect(reopened.changeCounter).toBe(published.changeCounter);
    const fenced = index.markIncomplete();
    expect(fenced).toMatchObject({ incomplete: true });
    expect(fenced.changeCounter).toBe(published.changeCounter + 1);
    index.close();
    database.close();
  });
});
