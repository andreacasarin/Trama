import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { IndexManager } from "@/index/IndexManager";
import { MemoryIndexStorage } from "@/index/storage";
import {
  createSyntheticEmbedding,
  createSyntheticWorkload,
  SyntheticVault,
} from "./syntheticWorkload";

interface CharacterizationReport {
  readonly schemaVersion: 2;
  readonly harness: "unified-orama-characterization";
  readonly backend: "candidate-unified-orama";
  readonly phaseAttribution: {
    readonly scale: number;
    readonly buildMs: number;
    readonly snapshotIoMs: number;
    readonly eventLoopMaxMs: number | undefined;
    readonly snapshotSerializationExempt: true;
  };
  readonly cancellation: {
    readonly durableSnapshotPreserved: boolean;
    readonly partialProjectionRemainedAvailable: boolean;
  };
  readonly corruption: {
    readonly loadRejected: boolean;
    readonly durableSnapshotPreserved: boolean;
  };
  readonly fingerprint: { readonly mismatchedLoadRejected: boolean };
  readonly replacement: { readonly failedReplacementPreservedSnapshot: boolean };
  readonly postGc: {
    readonly onlyCompletedSnapshotRemained: boolean;
    readonly temporarySnapshotAbsent: boolean;
  };
  readonly unsupported: readonly string[];
}

class TimingStorage extends MemoryIndexStorage {
  writeMs = 0;
  replaceMs = 0;

  override async write(path: string, value: string): Promise<void> {
    const started = performance.now();
    await super.write(path, value);
    if (path.endsWith("index.json.tmp")) this.writeMs += performance.now() - started;
  }

  override async replace(from: string, to: string): Promise<void> {
    const started = performance.now();
    await super.replace(from, to);
    this.replaceMs += performance.now() - started;
  }
}

function eventLoopMax(
  operation: () => Promise<void>
): Promise<{ readonly elapsed: number; readonly max: number | undefined }> {
  const samples: number[] = [];
  let expected = Date.now() + 5;
  const timer = setInterval(() => {
    const now = Date.now();
    samples.push(Math.max(0, now - expected));
    expected += 5;
  }, 5);
  const started = performance.now();
  return operation()
    .finally(() => clearInterval(timer))
    .then(() => ({
      elapsed: performance.now() - started,
      max: samples.length ? Math.max(...samples) : undefined,
    }));
}

function manager(
  vault: SyntheticVault,
  storage: MemoryIndexStorage,
  model = createSyntheticEmbedding(),
  modelId = "synthetic"
) {
  return new IndexManager(vault.port(), model, storage, "http://synthetic.invalid/v1", modelId, {
    size: 384,
    overlap: 64,
  });
}

export async function runCharacterization(): Promise<CharacterizationReport> {
  const workload = createSyntheticWorkload(1_000);
  const vault = new SyntheticVault(workload.notes);
  const storage = new TimingStorage();
  const indexed = manager(vault, storage);
  const build = await eventLoopMax(() => indexed.build(new AbortController().signal));
  const durable = await storage.read("index.json");

  const cancellationVault = new SyntheticVault(workload.notes);
  const cancellationController = new AbortController();
  const cancellationModel = {
    dimensions: 768 as const,
    embed: async (_texts: readonly string[]) => {
      cancellationController.abort();
      throw new Error("synthetic cancellation");
    },
  };
  const cancelled = manager(cancellationVault, storage, cancellationModel);
  let cancellationRejected = false;
  try {
    await cancelled.build(cancellationController.signal);
  } catch {
    cancellationRejected = true;
  }
  const cancellationDurable = await storage.read("index.json");
  let partialProjectionRemainedAvailable = false;
  try {
    partialProjectionRemainedAvailable = cancelled.hasUsableIndex();
  } catch {
    partialProjectionRemainedAvailable = false;
  }

  const corrupted = await storage.read("index.json");
  await storage.write("index.json", "{");
  const rejectedCorruption = !(await manager(vault, storage).load());
  const corruptionDurablePreserved =
    corrupted !== null && (await storage.read("index.json")) === "{";
  await storage.write("index.json", corrupted ?? "");

  const mismatchedLoadRejected = !(await manager(
    vault,
    storage,
    createSyntheticEmbedding(),
    "different-model"
  ).load());

  const replace = storage.replace.bind(storage);
  const updatedVault = new SyntheticVault(workload.notes);
  const updated = manager(updatedVault, storage);
  await updated.load();
  updatedVault.update(workload.notes[0].path, `${workload.notes[0].content}\nchanged`);
  storage.replace = async () => {
    throw new Error("synthetic replacement failure");
  };
  updated.queueChange(workload.notes[0].path);
  let replacementFailed = false;
  try {
    await updated.reconcileQueuedChanges(new AbortController().signal);
  } catch {
    replacementFailed = true;
  }
  const replacementPreserved = replacementFailed && (await storage.read("index.json")) === durable;
  storage.replace = replace;

  const files = [...storage.files.keys()].sort();
  return {
    schemaVersion: 2,
    harness: "unified-orama-characterization",
    backend: "candidate-unified-orama",
    phaseAttribution: {
      scale: workload.scale,
      buildMs: Number(build.elapsed.toFixed(2)),
      snapshotIoMs: Number((storage.writeMs + storage.replaceMs).toFixed(2)),
      eventLoopMaxMs: build.max,
      snapshotSerializationExempt: true,
    },
    cancellation: {
      durableSnapshotPreserved: cancellationRejected && cancellationDurable === durable,
      partialProjectionRemainedAvailable,
    },
    corruption: {
      loadRejected: rejectedCorruption,
      durableSnapshotPreserved: corruptionDurablePreserved,
    },
    fingerprint: { mismatchedLoadRejected },
    replacement: { failedReplacementPreservedSnapshot: replacementPreserved },
    postGc: {
      onlyCompletedSnapshotRemained: files.length === 1 && files[0] === "index.json",
      temporarySnapshotAbsent: !storage.files.has("index.json.tmp"),
    },
    unsupported: [
      "snapshot serialization and Orama fresh-load validation are measured together",
      "event-loop drift during the explicit snapshot serialization/save phase is exempt from the 100ms gate",
      "queue depth and individual mutation-batch timings are not exposed by the frozen runner",
    ],
  };
}

export async function writeCharacterization(
  path: string,
  report: CharacterizationReport
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
