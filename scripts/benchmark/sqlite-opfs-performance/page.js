const output = document.querySelector("#result");
if (new URLSearchParams(location.search).has("profile"))
  globalThis.__tramaBenchProfile = { phases: {} };
try {
  const [config, plan, corpus] = await Promise.all([
    fetch("/runner.json").then((response) => response.json()),
    fetch("/plan.json").then((response) => response.json()),
    fetch("/corpus.json").then((response) => response.json()),
  ]);
  if (corpus.sha256 !== plan.corpusSha256) throw new Error("Corpus hash differs from the plan");
  const versions = await Promise.all(
    config.versions.map(async (version) => ({
      ...version,
      runWorkload: (await import(version.bundle)).runWorkload,
      runs: [],
    }))
  );
  for (const run of plan.runs) {
    const notes = corpus.notes.slice(0, run.count);
    for (const version of versions)
      version.runs.push({ count: run.count, warmups: [], samples: [] });
    const target = Object.fromEntries(
      versions.map((version) => [version.label, version.runs.at(-1)])
    );
    const total = run.warmups + run.samples;
    for (let index = 0; index < total; index++) {
      const isWarmup = index < run.warmups;
      const phase = isWarmup ? "warmups" : "samples";
      const order =
        versions.length > 1 && (index + run.count) % 2 ? [...versions].reverse() : versions;
      for (const version of order) {
        target[version.label][phase].push(
          await version.runWorkload(
            plan,
            notes,
            run.queryWarmups,
            isWarmup ? 0 : run.querySamples,
            version.worker
          )
        );
      }
    }
  }
  output.textContent = JSON.stringify({
    ok: true,
    reports: Object.fromEntries(versions.map(({ label, runs }) => [label, runs])),
  });
} catch (error) {
  output.textContent = JSON.stringify({ ok: false, error: String(error), stack: error?.stack });
}
