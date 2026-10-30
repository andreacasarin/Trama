import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Include notices for packages actually bundled, including transitive dependencies. */
export async function generateNotices(inputs) {
  const packages = new Map();
  for (const input of inputs.filter((name) => name.startsWith("node_modules/"))) {
    let directory = path.dirname(path.resolve(input));
    while (directory !== path.dirname(directory)) {
      const json = await readFile(path.join(directory, "package.json"), "utf8").catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (json) {
        const pkg = JSON.parse(json);
        if (pkg.name && pkg.version) {
          packages.set(`${pkg.name}@${pkg.version}`, directory);
          break;
        }
      }
      directory = path.dirname(directory);
    }
  }
  const supplemental = JSON.parse(await readFile("vendor/npm/licenses.json", "utf8"));
  const sections = [
    "Third-party licenses and notices\nTrama's MIT license applies to Trama code; dependencies retain their own terms.",
  ];
  for (const [name, directory] of [...packages].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const files = (await readdir(directory))
      .filter((name) => /^(licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(name))
      .sort();
    if (!files.length) {
      const extra = supplemental[name];
      if (!extra) throw new Error(`Missing bundled dependency license: ${name}`);
      sections.push(name, await readFile(path.join("vendor/npm", extra.file), "utf8"));
      continue;
    }
    sections.push(
      name,
      ...(await Promise.all(files.map((name) => readFile(path.join(directory, name), "utf8"))))
    );
  }
  sections.push("SQLite is in the public domain. https://sqlite.org/copyright.html");
  for (const file of ["emscripten-LICENSE.txt", "musl-COPYRIGHT.txt"])
    sections.push(file, await readFile(path.join("vendor/sqlite-wasm", file), "utf8"));
  const notices = sections.join("\n\n----------------------------------------\n\n") + "\n";
  await writeFile("THIRD-PARTY-NOTICES.txt", notices);
  return notices;
}
