import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createWorkload } from "./generator";
import { runTramaBenchmark } from "./trama-benchmark";

describe("Trama deterministic benchmark", () => {
  it.runIf(Boolean(process.env.TRAMA_BENCHMARK))(
    "measures the 10K feature workload",
    async () => {
      const evidence = await runTramaBenchmark(createWorkload("trama-10k"));
      const outputDirectory = ".artifacts/trama-benchmark";
      mkdirSync(outputDirectory, { recursive: true });
      writeFileSync(
        `${outputDirectory}/${evidence.profile}.json`,
        `${JSON.stringify(evidence, null, 2)}\n`
      );
      expect(evidence.chunks).toBe(10_000);
      expect(evidence.counts.initialIndexedNotes).toBe(1_100);
      expect(evidence.counts.initialIndexedChunks).toBe(10_000);
    },
    3_600_000
  );
});
