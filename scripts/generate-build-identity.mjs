import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const value = randomUUID();
await mkdir(path.join(root, ".cache"), { recursive: true });
await writeFile(
  path.join(root, ".cache/runtime-build.json"),
  `${JSON.stringify({ buildId: value }, null, 2)}\n`
);
