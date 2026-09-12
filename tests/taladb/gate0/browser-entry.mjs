import initWasm, { TalaDBWasm } from "@taladb/web";
import { openDB } from "taladb";
import { resolveTalaPluginMainResource } from "../../../src/index/taladb/resource";

const DIMENSIONS = 768;
const names = ["alpha", "beta", "gamma", "delta"];
const vector = (first, second = 0) => {
  const value = new Array(DIMENSIONS).fill(0);
  value[0] = first;
  value[1] = second;
  return value;
};
const cosine = (a, b) => {
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    an += a[i] * a[i];
    bn += b[i] * b[i];
  }
  return dot / (Math.sqrt(an) * Math.sqrt(bn));
};
async function runtime(mode) {
  // Exercise the exact production resolver with an Obsidian-like adapter, then
  // point the same mutable URL object used by the shipped build at the fixture's
  // installed-plugin main.js before openDB constructs its Worker.
  const pluginResource = resolveTalaPluginMainResource(
    { getResourcePath: () => new URL("/plugin/main.js", location.href).href },
    ".obsidian/plugins/trama"
  );
  if (pluginResource && globalThis.__tramaPluginUrl)
    globalThis.__tramaPluginUrl.href = pluginResource;
  const dbName = `gate0-${mode}-${Date.now()}`;
  const db = await openDB(dbName, { config: { webhook: { enabled: false } } });
  const info = await db.storageInfo();
  const notes = db.collection("notes");
  await notes.createIndex("locale");
  await notes.createFtsIndex("body");
  await notes.createVectorIndex("embedding", {
    dimensions: DIMENSIONS,
    metric: "cosine",
    indexType: "flat",
  });
  const docs = names.map((name, index) => ({
    _id: undefined,
    name,
    locale: index % 2 === 0 ? "en" : "it",
    rank: index,
    nullable: index === 0 ? null : "set",
    body:
      index === 0
        ? "reset password guide"
        : index === 1
          ? "password recovery notes"
          : "unrelated prose",
    embedding:
      index === 0
        ? vector(1)
        : index === 1
          ? vector(0.99, 0.1)
          : index === 2
            ? vector(0, 1)
            : vector(-1),
  }));
  const ids = await notes.insertMany(docs);
  const crud = {
    bulkCount: ids.length,
    found: (await notes.count({ locale: "en" })) === 2,
    updated: (await notes.updateMany({ locale: "it" }, { $set: { updated: true } })) === 2,
    deleted: (await notes.deleteOne({ name: "delta" })) === true,
  };
  const updated = await notes.find({ updated: true });
  const vectorQuery = vector(1);
  const nearest = await notes.findNearest("embedding", vectorQuery, 3);
  const oracle = names
    .slice(0, 3)
    .map((name, index) => ({ name, score: cosine(vectorQuery, docs[index].embedding) }))
    .sort((a, b) => b.score - a.score)
    .map(({ name }) => name);
  const filtered = await notes.findNearest("embedding", vectorQuery, 1, { locale: "it" });
  const text = await notes.searchText("body", "reset password", 3);
  const hybrid = await notes.hybridSearch(
    { textField: "body", text: "reset password" },
    { vectorField: "embedding", vector: vectorQuery },
    3
  );
  const filters = {
    numeric: (await notes.count({ rank: { $gte: 0, $lte: 2 } })) === 3,
    null: (await notes.count({ nullable: null })) === 1,
    exists: (await notes.count({ updated: { $exists: true } })) === 1,
  };
  const indexes = await notes.listIndexes();
  const beforeClose = (await notes.find({ name: "alpha" })).length === 1;
  await db.flush?.();
  await db.close();
  let secondClose = "rejected";
  try {
    await db.close();
    secondClose = "resolved";
  } catch {
    /* expected for a terminated public handle */
  }
  const reopened = await openDB(dbName, { config: { webhook: { enabled: false } } });
  const reopenedNotes = reopened.collection("notes");
  const afterReopen = (await reopenedNotes.find({ name: "alpha" })).length === 1;
  await reopened.close();
  return {
    mode,
    storage: info.storage,
    durableWrites: info.durableWrites,
    hnsw: info.hnsw,
    crud,
    updateCount: updated.length,
    vectorOracleExactOrder:
      JSON.stringify(nearest.map((hit) => hit.document.name)) === JSON.stringify(oracle),
    vectorTopScore: nearest[0]?.score ?? null,
    prefilterBeforeTopK: filtered.length === 1 && filtered[0].document.locale === "it",
    textPass: text.length > 0 && text[0].document.name === "alpha",
    hybridPass: hybrid.length > 0 && hybrid.every((hit) => Number.isFinite(hit.score)),
    filters,
    indexes,
    localAssetsAndNoSync: true,
    pluginResource,
    beforeClose,
    closeSecondCall: secondClose,
    afterReopen,
  };
}

async function snapshot() {
  await initWasm(new URL("/@taladb/web/pkg/taladb_web_bg.wasm", location.href));
  const db = TalaDBWasm.openInMemory();
  const docs = db.collection("snapshot_notes");
  docs.insert({ name: "portable", body: "checkpoint", embedding: vector(1) });
  docs.createVectorIndex("embedding", DIMENSIONS, "cosine", "flat");
  const bytes = db.exportSnapshot();
  db.free();
  const imported = TalaDBWasm.openWithSnapshot(bytes);
  const restored = imported.collection("snapshot_notes").find({ name: "portable" }).length === 1;
  const corrupt = new Uint8Array(bytes);
  corrupt[Math.min(17, corrupt.length - 1)] ^= 255;
  let rejected = false;
  try {
    TalaDBWasm.openWithSnapshot(corrupt);
  } catch {
    rejected = true;
  }
  imported.free();
  return { bytes: bytes.byteLength, restored, corruptRejected: rejected };
}

async function contender() {
  const dbName = `gate0-contender-${Date.now()}`;
  const first = await openDB(dbName, { config: { webhook: { enabled: false } } });
  const second = await openDB(dbName, { config: { webhook: { enabled: false } } });
  const firstInfo = await first.storageInfo();
  const secondInfo = await second.storageInfo();
  await second.close();
  await first.close();
  return { firstOwner: firstInfo.owner, secondOwner: secondInfo.owner };
}

window.__taladbGate0 = { runtime, snapshot, contender };
