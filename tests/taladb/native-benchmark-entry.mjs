import { IndexManager } from "../../src/index/IndexManager.ts";
import { chunkMarkdown } from "../../src/index/chunking.ts";
import { createTalaNamespace } from "../../src/index/taladb/namespace.ts";

const DIMENSIONS = 768;
const CHUNK_SIZE = 384;
const CHUNK_OVERLAP = 64;
const PROFILES = Object.freeze({
  oneK: { name: "one-k", noteCount: 128, targetChunkCount: 1_024 },
  representative: { name: "representative-2740-25k", noteCount: 2_740, targetChunkCount: 25_000 },
  fiftyK: { name: "fifty-k", noteCount: 2_740, targetChunkCount: 50_000 },
  oneHundredK: { name: "one-hundred-k", noteCount: 2_740, targetChunkCount: 100_000 },
});

function xorshift(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4_294_967_296;
  };
}

function seedFor(value) {
  let hash = 2_166_136_261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0 || 1;
}

/** Synthetic but production-shaped 768d normalized Float32 embedding. */
function embeddingFor(value) {
  const random = xorshift(seedFor(`trama-taladb-native-v1:${value}`));
  const result = new Float32Array(DIMENSIONS);
  let norm = 0;
  for (let i = 0; i < DIMENSIONS; i += 1) {
    const item = random() * 2 - 1;
    result[i] = item;
    norm += item * item;
  }
  const scale = 1 / Math.sqrt(norm);
  for (let i = 0; i < DIMENSIONS; i += 1) result[i] *= scale;
  return result;
}

function repeatToLength(pattern, length) {
  let result = "";
  while (result.length < length) result += pattern;
  return result.slice(0, length);
}

function noteContent(index, chunks) {
  const stride = CHUNK_SIZE - CHUNK_OVERLAP;
  const length = chunks === 1 ? 300 : stride * (chunks - 1) + CHUNK_OVERLAP + 1;
  return repeatToLength(
    `Synthetic note ${String(index).padStart(4, "0")} architecture delta retrieval lifecycle local semantic corpus. `,
    length
  );
}

function allocation(noteCount, target) {
  const base = Math.floor(target / noteCount);
  const remainder = target % noteCount;
  return Array.from({ length: noteCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

function compareCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function generateFixture(profile) {
  const parts = allocation(profile.noteCount, profile.targetChunkCount);
  const contents = new Map();
  const candidates = [];
  for (let index = 0; index < profile.noteCount; index += 1) {
    const path = `synthetic/${String(index).padStart(5, "0")}-${index % 2 ? "é" : "α"}.md`;
    const content = noteContent(index, parts[index]);
    const chunks = chunkMarkdown(content, CHUNK_SIZE, CHUNK_OVERLAP);
    if (chunks.length !== parts[index]) throw new Error(`chunk count mismatch for ${path}`);
    contents.set(path, content);
    chunks.forEach((chunk, ordinal) => candidates.push({ path, ordinal, text: chunk.text }));
  }
  candidates.sort((a, b) => compareCodeUnits(`${a.path}#${a.ordinal}`, `${b.path}#${b.ordinal}`));
  return { contents, candidates };
}

class BrowserStorage {
  constructor() {
    this.root = ".trama/index";
    this.files = new Map();
  }
  async read(path) {
    return this.files.get(path) ?? null;
  }
  async write(path, value) {
    this.files.set(path, value);
  }
  async remove(path) {
    this.files.delete(path);
  }
  async activate(pointer, value) {
    this.files.set(pointer, value);
  }
}

function fixtureVault(contents) {
  return {
    async listMarkdownPaths() {
      return [...contents.keys()];
    },
    async readMarkdown(path) {
      const content = contents.get(path);
      if (content === undefined) throw new Error(`missing markdown: ${path}`);
      return { path, content };
    },
    async isMarkdownAvailable(path) {
      return contents.has(path);
    },
  };
}

function embeddingModel(counter) {
  return {
    dimensions: DIMENSIONS,
    async embed(texts, signal) {
      if (signal?.aborted) throw new Error("embedding cancelled");
      counter.count += texts.length;
      return texts.map((text) => Array.from(embeddingFor(text)));
    },
  };
}

function exactOracle(query, candidates, limit = 20) {
  const queryVector = embeddingFor(query);
  return candidates
    .map((candidate) => {
      const vector = embeddingFor(candidate.text);
      let score = 0;
      for (let i = 0; i < DIMENSIONS; i += 1) score += queryVector[i] * vector[i];
      return { ...candidate, score };
    })
    .sort((a, b) => b.score - a.score || compareCodeUnits(a.path, b.path) || a.ordinal - b.ordinal)
    .slice(0, limit);
}

function metric(kind, value, unit, sampleCount = 1) {
  return { kind, value, unit, sampleCount };
}

async function runProfile(profileKey) {
  const profile = PROFILES[profileKey];
  const fixture = generateFixture(profile);
  const counter = { count: 0 };
  const embedding = embeddingModel(counter);
  const storage = new BrowserStorage();
  const namespace = createTalaNamespace(`native-benchmark-${profileKey}`);
  const manager = new IndexManager(
    fixtureVault(fixture.contents),
    embedding,
    storage,
    "http://127.0.0.1:1234/v1",
    "synthetic-768-v1",
    { namespace, backend: "native" }
  );
  const drift = { max: 0, last: performance.now() };
  const timer = setInterval(() => {
    const now = performance.now();
    drift.max = Math.max(drift.max, now - drift.last - 50);
    drift.last = now;
  }, 50);
  const started = performance.now();
  try {
    await manager.build(new AbortController().signal);
  } finally {
    clearInterval(timer);
  }
  const buildMs = performance.now() - started;
  const lease = manager.acquireLenteLease();
  if (!lease) throw new Error("manager did not publish a native bundle");
  const query = "retrieval lifecycle";
  const searchStarted = performance.now();
  const semantic = await lease.retriever.search({
    query,
    queryVector: Array.from(embeddingFor(query)),
    mode: "semantic",
    resultShape: "chunks",
    limit: 20,
    semanticCandidateLimit: 20,
  });
  const semanticMs = performance.now() - searchStarted;
  const expected = exactOracle(query, fixture.candidates);
  const expectedByKey = new Map(expected.map((hit) => [`${hit.path}#${hit.ordinal}`, hit]));
  const actual = semantic.map((hit) => ({
    key: `${hit.path}#${hit.ordinal}`,
    score: hit.semanticScore ?? hit.fusedScore,
  }));
  const nonTied = expected.filter(
    (hit, index) => index === 0 || Math.abs(hit.score - expected[index - 1].score) > 1e-7
  );
  const actualKeys = new Set(actual.map((hit) => hit.key));
  const recall = nonTied.length
    ? nonTied.filter((hit) => actualKeys.has(`${hit.path}#${hit.ordinal}`)).length / nonTied.length
    : 1;
  let maxScoreError = 0;
  for (const hit of actual) {
    const oracle = expectedByKey.get(hit.key);
    if (oracle) maxScoreError = Math.max(maxScoreError, Math.abs(oracle.score - hit.score));
  }
  const hybridStarted = performance.now();
  const hybrid = await lease.retriever.search({
    query: "local semantic corpus",
    queryVector: Array.from(embeddingFor("local semantic corpus")),
    mode: "hybrid",
    resultShape: "chunks",
    limit: 20,
    semanticCandidateLimit: 80,
    lexicalCandidateLimit: 80,
  });
  const hybridMs = performance.now() - hybridStarted;
  const lexicalStarted = performance.now();
  const lexical = await lease.retriever.search({
    query: "architecture delta",
    mode: "lexical",
    resultShape: "chunks",
    limit: 20,
    lexicalCandidateLimit: 80,
  });
  const lexicalMs = performance.now() - lexicalStarted;
  await lease.release();

  const beforeMutation = counter.count;
  const unchangedPath = "synthetic/00000-α.md";
  manager.queueChange(unchangedPath);
  await manager.reconcileQueuedChanges(new AbortController().signal);
  const unchangedEmbedTexts = counter.count - beforeMutation;

  const mutationPath = "synthetic/00001-é.md";
  fixture.contents.set(mutationPath, "architecture delta modified retrieval lifecycle\n");
  const modifyStart = performance.now();
  manager.queueChange(mutationPath);
  await manager.reconcileQueuedChanges(new AbortController().signal);
  const modifyMs = performance.now() - modifyStart;
  const modifiedEmbedTexts = counter.count - beforeMutation - unchangedEmbedTexts;

  const addPath = "synthetic/added-native.md";
  fixture.contents.set(addPath, "architecture delta added native note\n");
  manager.queueChange(addPath);
  await manager.reconcileQueuedChanges(new AbortController().signal);
  const afterAdd = await manager.search("added native", new AbortController().signal, 5);
  fixture.contents.delete("synthetic/00002-α.md");
  manager.queueOperation({ kind: "delete", path: "synthetic/00002-α.md" });
  await manager.reconcileQueuedChanges(new AbortController().signal);
  const renameFrom = "synthetic/00003-é.md";
  const renameTo = "synthetic/renamed-native.md";
  fixture.contents.set(renameTo, fixture.contents.get(renameFrom));
  fixture.contents.delete(renameFrom);
  manager.queueRename(renameFrom, renameTo);
  await manager.reconcileQueuedChanges(new AbortController().signal);
  const converged = (await manager.search("renamed native", new AbortController().signal, 20)).some(
    (hit) => hit.path === renameTo
  );

  const deleteSearch = await manager.search(
    "deleted native sentinel",
    new AbortController().signal,
    20
  );
  const stateBeforeRestart = manager.state();
  const storageInfo = manager["engine"]?.storageInfo?.();
  await manager.close();
  // OPFS releases the worker's lock after the close response; give the browser
  // a turn to retire the large worker before opening the same database again.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const loadRecords = [];
  const restarted = new IndexManager(
    fixtureVault(fixture.contents),
    embeddingModel({ count: 0 }),
    storage,
    "http://127.0.0.1:1234/v1",
    "synthetic-768-v1",
    { namespace, backend: "native" },
    { emit: (record) => loadRecords.push({ event: record.event, error: record.error }) }
  );
  const loaded = await restarted.load({ emitDiagnostics: true });
  const persisted =
    loaded &&
    (await restarted.search("architecture delta", new AbortController().signal, 5)).length > 0;
  await restarted.close();
  let usage;
  try {
    usage = await navigator.storage?.estimate?.();
  } catch {
    usage = undefined;
  }
  const memory = performance.memory?.usedJSHeapSize;
  return {
    profile: profileKey,
    notes: profile.noteCount,
    chunks: profile.targetChunkCount,
    buildMs,
    semanticMs,
    lexicalMs,
    hybridMs,
    semanticRecallNonTied: recall,
    semanticMaxScoreError: maxScoreError,
    lexicalHits: lexical.length,
    hybridHits: hybrid.length,
    buildEmbedTexts: counter.count,
    unchangedEmbedTexts,
    modifiedEmbedTexts,
    addConverged: afterAdd.some((hit) => hit.path === addPath),
    deleteConverged: !deleteSearch.some((hit) => hit.path === "synthetic/00002-α.md"),
    renameConverged: converged,
    persisted,
    loadRecords,
    loaded,
    ready: stateBeforeRestart?.status === "ready",
    storageOpfs: storageInfo?.storage === "opfs",
    durableWrites: storageInfo?.durableWrites === true,
    hnswSupported: storageInfo?.hnsw === true,
    storageBytes: Number.isFinite(usage?.usage) ? usage.usage : undefined,
    memoryBytes: Number.isFinite(memory) ? memory : undefined,
    eventLoopDriftMs: drift.max,
  };
}

window.__taladbNativeBenchmark = { runProfile, profiles: Object.keys(PROFILES) };
