import { describe, expect, it } from "vitest";
import { loadTestSqlite } from "./sqlite-test-client";
import { normalizedVector, vectorOf } from "@/index/sqlite/core";

describe("native SQLite scoring", () => {
  it.each([2, 768, 4096])(
    "uses SQLite-Vector scoring and preserves centroid normalization at %i dimensions",
    async (dimensions) => {
      const sqlite = await loadTestSqlite();
      const db = new sqlite.oo1.DB(":memory:", "c");
      try {
        const vectors = Array.from({ length: 3 }, (_, n) =>
          normalizedVector(
            Float32Array.from({ length: dimensions }, (_, i) => Math.sin((i + 1) * (n + 1))),
            dimensions
          )
        );
        let dot = 0;
        for (let i = 0; i < dimensions; i++) dot += vectors[0][i] * vectors[1][i];
        const operands = vectors.map((vector) => new Uint8Array(vector.buffer));
        const score = db.selectValue("SELECT trama_vector_dot(?,?)", operands.slice(0, 2));
        expect(score).toBeCloseTo(dot, 5);
        db.exec("CREATE TABLE scan_vectors(vector BLOB)");
        db.exec({ sql: "INSERT INTO scan_vectors VALUES(?)", bind: [operands[0]] });
        db.exec(
          `SELECT vector_init('scan_vectors','vector','dimension=${dimensions},type=FLOAT32,distance=DOT')`
        );
        expect(score).toBe(
          -db.selectValue("SELECT distance FROM vector_full_scan('scan_vectors','vector',?)", [
            operands[1],
          ])
        );
        // A different model dimension on the same connection needs no scan registration.
        expect(
          db.selectValue(
            "SELECT trama_vector_dot(vector_as_f32('[1,0,0]'),vector_as_f32('[1,0,0]'))"
          )
        ).toBe(1);
        const sum = new Float64Array(dimensions);
        for (const vector of vectors) for (let i = 0; i < dimensions; i++) sum[i] += vector[i];
        let norm = 0;
        for (const value of sum) norm += value * value;
        const scale = 1 / Math.sqrt(norm);
        const expected = Float32Array.from(sum, (value) => value * scale);
        db.exec("CREATE TABLE vectors(position INTEGER PRIMARY KEY,vector BLOB)");
        vectors.forEach((vector, position) =>
          db.exec({
            sql: "INSERT INTO vectors VALUES(?,?)",
            bind: [position, new Uint8Array(vector.buffer)],
          })
        );
        expect(
          vectorOf(
            db.selectValue(
              "SELECT trama_vector_centroid(vector) FROM (SELECT vector FROM vectors ORDER BY position)"
            )
          )
        ).toEqual(expected);
      } finally {
        db.close();
      }
    }
  );

  it("rejects malformed dot operands and preserves JS path ordering", async () => {
    const sqlite = await loadTestSqlite();
    const db = new sqlite.oo1.DB(":memory:", "c");
    try {
      for (const values of [
        [new Uint8Array(3), new Uint8Array(3)],
        [new Uint8Array(4), new Uint8Array(8)],
        ["text", new Uint8Array(4)],
      ])
        expect(() => db.selectValue("SELECT trama_vector_dot(?,?)", values)).toThrow(
          "Vector dimensions mismatch"
        );
      expect(db.selectValue("SELECT ? < ? COLLATE trama_code_units", ["😀.md", "\ue000.md"])).toBe(
        1
      );
      expect(db.selectValue("SELECT trama_token_count(?)", ["Café naïve 東京"])).toBe(3);
    } finally {
      db.close();
    }
  });
});
