/* global document, Worker, crypto, TextEncoder, TextDecoder, fetch, navigator, URL, Blob, location */
const result = document.querySelector("#result");
const workerUrl = "/note-worker.mjs";
let sequence = 0;

function rpc(worker, method, payload = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const listener = (event) => {
      if (event.data.id !== id) return;
      worker.removeEventListener("message", listener);
      if (event.data.ok) resolve(event.data.result);
      else
        reject(Object.assign(new Error(event.data.error.message), { name: event.data.error.name }));
    };
    worker.addEventListener("message", listener);
    worker.postMessage({ id, method, payload });
  });
}

function createWorker(namespace) {
  const worker = new Worker(workerUrl, { type: "module" });
  return rpc(worker, "init", { namespace }).then(() => worker);
}

function poolStats(worker) {
  return rpc(worker, "__testOpfsPool");
}

async function assertPoolClean(worker, phase) {
  const stats = await poolStats(worker);
  assert(
    stats.count === 1 && stats.names.join(",") === "/notes.sqlite3" && stats.capacity === 8,
    `${phase} left SAH pool files allocated or changed capacity: ${JSON.stringify(stats)}`
  );
  return stats;
}

function hashBytes(bytes) {
  return crypto.subtle
    .digest("SHA-256", bytes)
    .then((digest) =>
      [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("")
    );
}

function hashText(value) {
  return hashBytes(new TextEncoder().encode(value));
}

function vector(index, dimensions = 8) {
  const values = Array.from({ length: dimensions }, (_, i) => (index + i + 1) / 100);
  const bytes = new Uint8Array(dimensions * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, i) => view.setFloat32(i * 4, value, true));
  return bytes;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function findSequence(bytes, sequence) {
  outer: for (let start = 0; start <= bytes.length - sequence.length; start++) {
    for (let index = 0; index < sequence.length; index++) {
      if (bytes[start + index] !== sequence[index]) continue outer;
    }
    return start;
  }
  return -1;
}

async function rejectedImport(worker, profile, dimensions, bytes) {
  try {
    await rpc(worker, "embeddingCacheSqliteImport", {
      profile,
      checksum: await hashBytes(bytes),
      dimensions,
      bytes,
      now: Date.now(),
    });
    return false;
  } catch {
    return true;
  }
}

function cancelImport(worker, profile, dimensions, bytes, checksum) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const listener = (event) => {
      if (event.data.id !== id) return;
      worker.removeEventListener("message", listener);
      if (event.data.ok) reject(new Error("cancelled import unexpectedly succeeded"));
      else resolve(event.data.error.name);
    };
    worker.addEventListener("message", listener);
    worker.postMessage({
      id,
      method: "embeddingCacheSqliteImport",
      payload: {
        profile,
        checksum,
        dimensions,
        bytes,
        now: Date.now(),
      },
    });
    worker.postMessage({ id: ++sequence, method: "cancel", payload: { requestId: id } });
  });
}

async function malformedFixture(name) {
  return new Uint8Array(
    await fetch(`/fixtures/${name}.sqlite3`).then((response) => response.arrayBuffer())
  );
}

function namespace() {
  return crypto.randomUUID().replaceAll("-", "").padStart(64, "0").slice(0, 64);
}

async function storageFiles(name) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(`trama-note-v2-${name}`);
  const files = [];
  for await (const [entry] of dir.entries()) files.push(entry);
  return files.sort();
}

async function main() {
  const corruptBootstrap = URL.createObjectURL(
    new Blob(
      [
        `globalThis.__TRAMA_SQLITE_ASSETS__=${JSON.stringify({ moduleUrl: new URL("/sqlite3.mjs", location.href).href, wasmUrl: new URL("/fixtures/bad-hash.sqlite3", location.href).href })};await import(${JSON.stringify(new URL(workerUrl, location.href).href)});self.postMessage({ready:true});`,
      ],
      { type: "text/javascript" }
    )
  );
  const corruptWorker = new Worker(corruptBootstrap, { type: "module" });
  await new Promise((resolve) =>
    corruptWorker.addEventListener("message", resolve, { once: true })
  );
  let invalidWasmRejected = false;
  try {
    await rpc(corruptWorker, "init", { namespace: namespace() });
  } catch {
    invalidWasmRejected = true;
  } finally {
    corruptWorker.terminate();
    URL.revokeObjectURL(corruptBootstrap);
  }
  assert(invalidWasmRejected, "corrupt WASM asset did not fail initialization");
  const profile = await hashText("opfs-proof-profile");
  const otherProfile = await hashText("opfs-proof-private-query");
  const sourceNs = namespace();
  const targetNs = namespace();
  const source = await createWorker(sourceNs);
  const target = await createWorker(targetNs);
  // Legacy SQLite-Vector shards remain readable; tiny/large Float32 values share the JS contract.
  const compatibility = await createWorker(namespace());
  const roundTrip = await createWorker(namespace());
  for (const name of ["legacy-valid", "tiny-vector", "large-vector"]) {
    const bytes = await malformedFixture(name);
    const imported = await rpc(compatibility, "embeddingCacheSqliteImport", {
      profile,
      checksum: await hashBytes(bytes),
      dimensions: 8,
      bytes,
      now: Date.now(),
    });
    assert(imported.imported === 1, `${name} failed native validation`);
  }
  await rpc(compatibility, "embeddingCacheSqliteReconcile", { profile, checksums: [] });
  const compatibleShard = await rpc(compatibility, "embeddingCacheSqliteExport", {
    profile,
    dimensions: 8,
    limit: 128,
  });
  assert(
    compatibleShard?.hashes.length === 3,
    "missing shards were not released for republication"
  );
  const roundTripped = await rpc(roundTrip, "embeddingCacheSqliteImport", {
    profile,
    checksum: await hashBytes(compatibleShard.bytes),
    dimensions: 8,
    bytes: compatibleShard.bytes,
    now: Date.now(),
  });
  assert(
    roundTripped.imported === 3,
    "legacy/extreme vectors did not round-trip through new shards"
  );
  await assertPoolClean(compatibility, "compatibility export");
  await assertPoolClean(roundTrip, "compatibility import");
  await rpc(compatibility, "close");
  await rpc(roundTrip, "close");
  const hashes = [];
  const allBytes = [];
  for (let i = 0; i < 129; i++) {
    const hash = await hashText(`document-vector-${i}`);
    hashes.push(hash);
    allBytes.push(vector(i));
  }
  await rpc(source, "embeddingCacheSet", {
    profile,
    task: "document",
    dimensions: 8,
    entries: hashes.map((hash, i) => ({ hash, vector: allBytes[i] })),
    now: Date.now(),
  });
  const queryHash = await hashText("secret-query-vector");
  const query = vector(300);
  await rpc(source, "embeddingCacheSet", {
    profile,
    task: "query",
    dimensions: 8,
    entries: [{ hash: queryHash, vector: query }],
    now: Date.now(),
  });
  await rpc(source, "embeddingCacheSet", {
    profile: otherProfile,
    task: "document",
    dimensions: 8,
    entries: [{ hash: await hashText("other-profile-secret"), vector: vector(400) }],
    now: Date.now(),
  });
  await rpc(source, "noteStoreReplace", {
    uid: "private-note-uid",
    path: "private-note.md",
    profile,
    markdown: "PRIVATE NOTE CORPUS MUST NEVER ENTER SHARD",
    vectors: [],
  });

  const sourceRevision = { path: "private-note.md", revision: "private-source-revision" };
  await rpc(source, "noteStoreRememberSources", { profile, sources: [sourceRevision] });

  const artifacts = [];
  for (let i = 0; i < 2; i++) {
    const shard = await rpc(source, "embeddingCacheSqliteExport", {
      profile,
      dimensions: 8,
      limit: 128,
    });
    assert(
      shard && shard.hashes.length > 0 && shard.hashes.length <= 128,
      "missing/invalid document shard"
    );
    assert(shard.bytes.byteLength < 4 * 1024 * 1024, "shard exceeds byte ceiling");
    assert(
      new TextDecoder().decode(shard.bytes.slice(0, 16)) === "SQLite format 3\0",
      "shard lacks SQLite header"
    );
    assert(
      !new TextDecoder().decode(shard.bytes).includes("PRIVATE NOTE CORPUS"),
      "private note text leaked"
    );
    assert(!shard.hashes.includes(queryHash), "query cache hash leaked");
    assert(
      findSequence(shard.bytes, new TextEncoder().encode(queryHash)) < 0,
      "query cache bytes leaked"
    );
    artifacts.push({
      bytes: shard.bytes,
      hashes: shard.hashes,
      checksum: await hashBytes(shard.bytes),
    });
    await rpc(source, "embeddingCacheSqliteMarkPublished", {
      profile,
      checksum: artifacts[i].checksum,
      hashes: shard.hashes,
      now: Date.now(),
    });
  }
  assert(
    artifacts.map(({ hashes: h }) => h.length).join(",") === "128,1",
    "expected 128-row and 1-row shards"
  );

  const invalidBytes = artifacts[0].bytes.slice();
  invalidBytes[68] ^= 0x01;
  const invalidRejected = await rejectedImport(target, profile, 8, invalidBytes);
  assert(invalidRejected, "bad application_id was accepted");
  await assertPoolClean(target, "invalid app-id validation");

  const badSchema = artifacts[0].bytes.slice();
  const metadataOffset = findSequence(badSchema, new TextEncoder().encode("metadata"));
  assert(metadataOffset >= 0, "metadata schema text was absent");
  badSchema[metadataOffset] = "x".charCodeAt(0);
  assert(await rejectedImport(target, profile, 8, badSchema), "malformed schema was accepted");
  await assertPoolClean(target, "invalid schema validation");

  for (const name of ["bad-hash", "nul-suffix-hash", "nul-ending-hash", "nul-short-hash"]) {
    const invalidHashArtifact = await malformedFixture(name);
    assert(await rejectedImport(target, profile, 8, invalidHashArtifact), `${name} was accepted`);
    await assertPoolClean(target, `${name} validation`);
  }
  const zeroArtifact = await malformedFixture("zero-vector");
  assert(await rejectedImport(target, profile, 8, zeroArtifact), "zero vector shard was accepted");
  const nonfiniteArtifact = await malformedFixture("nonfinite-vector");
  assert(
    await rejectedImport(target, profile, 8, nonfiniteArtifact),
    "non-finite vector was accepted"
  );
  await assertPoolClean(target, "non-finite vector validation");

  const oversized = new Uint8Array(4 * 1024 * 1024);
  assert(await rejectedImport(target, profile, 8, oversized), "oversized shard was accepted");
  await assertPoolClean(target, "oversized validation");

  const cancellation = await cancelImport(
    target,
    profile,
    8,
    artifacts[0].bytes,
    artifacts[0].checksum
  );
  assert(cancellation === "AbortError", `import cancellation returned ${cancellation}`);
  await assertPoolClean(target, "cancelled import");
  assert(
    (await rpc(target, "embeddingCacheKeys", { profile, task: "document", limit: 200 })).length ===
      0,
    "cancelled import committed rows"
  );

  assert(
    (await rpc(target, "embeddingCacheKeys", { profile, task: "document", limit: 200 })).length ===
      0,
    "invalid import wrote rows"
  );

  let wrongProfileRejected = false;
  try {
    await rpc(target, "embeddingCacheSqliteImport", {
      profile: otherProfile,
      checksum: artifacts[0].checksum,
      dimensions: 8,
      bytes: artifacts[0].bytes,
      now: Date.now(),
    });
  } catch {
    wrongProfileRejected = true;
  }
  assert(wrongProfileRejected, "wrong profile was accepted");
  let wrongDimensionsRejected = false;
  try {
    await rpc(target, "embeddingCacheSqliteImport", {
      profile,
      checksum: artifacts[0].checksum,
      dimensions: 7,
      bytes: artifacts[0].bytes,
      now: Date.now(),
    });
  } catch {
    wrongDimensionsRejected = true;
  }
  assert(wrongDimensionsRejected, "wrong dimensions were accepted");

  const localCollision = vector(999);
  await rpc(target, "embeddingCacheSet", {
    profile,
    task: "document",
    dimensions: 8,
    entries: [{ hash: artifacts[0].hashes[0], vector: localCollision }],
    now: Date.now(),
  });
  let importedRows = 0;
  for (const artifact of artifacts) {
    const imported = await rpc(target, "embeddingCacheSqliteImport", {
      profile,
      checksum: artifact.checksum,
      dimensions: 8,
      bytes: artifact.bytes,
      now: Date.now(),
    });
    const expectedImported = artifact.hashes.length - (artifact === artifacts[0] ? 1 : 0);
    assert(imported.imported === expectedImported, "import did not preserve local cache rows");
    importedRows += imported.imported;
  }
  assert(importedRows === 128, "import did not create all missing rows");
  const preservedLocal = await rpc(target, "embeddingCacheGet", {
    profile,
    task: "document",
    hashes: [artifacts[0].hashes[0]],
    now: Date.now(),
  });
  assert(
    preservedLocal[0]?.every((byte, index) => byte === localCollision[index]),
    "shared shard replaced a conflicting local vector"
  );
  await assertPoolClean(target, "successful import");
  await assertPoolClean(source, "successful export");
  const targetKeys = await rpc(target, "embeddingCacheKeys", {
    profile,
    task: "document",
    limit: 200,
  });
  assert(targetKeys.length === 129, "target cache is incomplete");
  assert(
    (await rpc(target, "embeddingCacheKeys", { profile, task: "query", limit: 200 })).length === 0,
    "query cache was imported"
  );
  assert(
    (
      await rpc(target, "embeddingCacheKeys", {
        profile: otherProfile,
        task: "document",
        limit: 200,
      })
    ).length === 0,
    "other profile was imported"
  );
  const noteSearch = await rpc(target, "noteStoreHybrid", {
    query: "PRIVATE NOTE CORPUS",
    profile,
    k: 10,
  });
  assert(noteSearch.hits.length === 0, "source note corpus leaked into destination");
  const sourceQuery = await rpc(source, "embeddingCacheGet", {
    profile,
    task: "query",
    hashes: [queryHash],
    now: Date.now(),
  });
  assert(sourceQuery[0]?.byteLength === 32, "source query cache was changed");
  const sourceFiles = await storageFiles(sourceNs);
  const targetFiles = await storageFiles(targetNs);
  assert(sourceFiles.join(",") === ".opaque", `unexpected source OPFS entries: ${sourceFiles}`);
  assert(targetFiles.join(",") === ".opaque", `unexpected target OPFS entries: ${targetFiles}`);

  await rpc(source, "close");
  await rpc(target, "close");
  const reopenedSource = await createWorker(sourceNs);
  assert(
    (
      await rpc(reopenedSource, "noteStoreCheckSources", { profile, sources: [sourceRevision] })
    ).join(",") === "private-note.md",
    "source revision did not persist after reopen"
  );
  await rpc(reopenedSource, "close");
  const reopened = await createWorker(targetNs);
  assert(
    (await rpc(reopened, "embeddingCacheKeys", { profile, task: "document", limit: 200 }))
      .length === 129,
    "target data did not persist after reopen"
  );
  await rpc(reopened, "close");

  const cycleResults = [];
  const cycleWorker = await createWorker(namespace());
  for (let cycle = 0; cycle < 9; cycle++) {
    await rpc(cycleWorker, "embeddingCacheSet", {
      profile,
      task: "document",
      dimensions: 8,
      entries: [{ hash: hashes[cycle], vector: allBytes[cycle] }],
      now: Date.now(),
    });
    const shard = await rpc(cycleWorker, "embeddingCacheSqliteExport", {
      profile,
      dimensions: 8,
      limit: 128,
    });
    assert(shard?.hashes.length === 1, "repeated cycle export failed");
    await assertPoolClean(cycleWorker, `repeat-cycle ${cycle} export`);
    const imported = await rpc(cycleWorker, "embeddingCacheSqliteImport", {
      profile,
      checksum: await hashBytes(shard.bytes),
      dimensions: 8,
      bytes: shard.bytes,
      now: Date.now(),
    });
    assert(imported.imported === 0, "repeated cycle import replaced local vectors");
    cycleResults.push(await assertPoolClean(cycleWorker, `repeat-cycle ${cycle} import`));
  }
  await rpc(cycleWorker, "close");
  result.textContent = JSON.stringify({
    ok: true,
    profile,
    dimensions: 8,
    compatibility: { legacy: true, tiny: true, large: true, roundTrip: true, reconciliation: true },
    artifactBytes: artifacts.map((item) => item.bytes.byteLength),
    artifactChecksums: artifacts.map((item) => item.checksum),
    artifactRows: artifacts.map((item) => item.hashes.length),
    importedRows,
    rejected: {
      appId: invalidRejected,
      schema: true,
      hash: true,
      nulHash: true,
      nonfinite: true,
      zero: true,
      invalidWasm: invalidWasmRejected,
      oversize: true,
      cancelled: cancellation === "AbortError",
      localCollisionPreserved: true,
      wrongProfile: wrongProfileRejected,
      wrongDimensions: wrongDimensionsRejected,
    },
    invalidRejected,
    wrongProfileRejected,
    wrongDimensionsRejected,
    sourceFiles: await storageFiles(sourceNs),
    targetFiles: await storageFiles(targetNs),
    cycleResults,
  });
}

main().catch((error) => {
  result.textContent = JSON.stringify({
    ok: false,
    error: `${error.name}: ${error.message}`,
    stack: error.stack,
  });
});
