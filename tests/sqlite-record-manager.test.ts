import { describe, expect, it } from "vitest";
import { SqliteNoteRecordManager } from "@/index/SqliteNoteRecordManager";
import { NoteSqliteDatabase } from "@/index/note-sqlite/database";
import { loadTestSqlite } from "./note-sqlite-test-client";

describe("SQLite LangChain record manager", () => {
  it("uses monotonic time, strict paging bounds, sorted keys, and current note UIDs", async () => {
    const sqlite = await loadTestSqlite();
    const db = new sqlite.oo1.DB(":memory:", "c");
    const database = new NoteSqliteDatabase(db);
    const call = database.call.bind(database);
    const records = new SqliteNoteRecordManager(call);
    const start = await records.getTime();
    try {
      await records.update(["uid-b", "uid-a"], {
        groupIds: ["vault", "vault"],
        timeAtLeast: start,
      });
      const updated = Number(db.selectValue("SELECT MAX(updated_at) FROM note_records"));
      const reserved = await records.getTime();
      expect(reserved).toBeGreaterThan(updated);
      expect(await records.listKeys({ before: updated, limit: 10 })).toEqual([]);
      expect(await records.listKeys({ after: start, limit: 10 })).toEqual(["uid-a", "uid-b"]);
      expect(await records.listKeys({ groupIds: ["other"], limit: 10 })).toEqual([]);
      expect(await records.listKeys({ groupIds: ["vault"], limit: 1 })).toEqual(["uid-a"]);
      expect(await records.exists(["uid-a", "uid-b"])).toEqual([false, false]);

      await database.call("noteStoreReplace", {
        uid: "uid-a",
        path: "a.md",
        profile: null,
        markdown: "# current note",
        vectors: [],
      });
      expect(await records.exists(["uid-a", "uid-b"])).toEqual([true, false]);
      await database.call("noteStoreReplace", {
        uid: "uid-new",
        path: "a.md",
        profile: null,
        markdown: "# replacement note",
        vectors: [],
      });
      expect(await records.exists(["uid-a", "uid-new"])).toEqual([false, true]);
    } finally {
      db.close();
    }
  });

  it("preserves group IDs on update and enforces timeAtLeast", async () => {
    const sqlite = await loadTestSqlite();
    const db = new sqlite.oo1.DB(":memory:", "c");
    const database = new NoteSqliteDatabase(db);
    const records = new SqliteNoteRecordManager(database.call.bind(database));
    try {
      await records.update(["uid"], { groupIds: ["original"] });
      const time = await records.getTime();
      await expect(records.update(["next"], { timeAtLeast: time + 1 })).rejects.toThrow(
        /earlier than timeAtLeast/
      );
      await records.update(["uid"], {});
      expect(await records.listKeys({ groupIds: ["original"], limit: 10 })).toEqual(["uid"]);
    } finally {
      db.close();
    }
  });
});
