import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.license !== "MIT" || !readFileSync("LICENSE", "utf8").startsWith("MIT License"))
  throw new Error("Project license does not match the license inventory");

const supplements = JSON.parse(readFileSync("vendor/npm/licenses.json", "utf8"));
for (const { file, sha256 } of Object.values(supplements))
  if (
    createHash("sha256")
      .update(readFileSync(`vendor/npm/${file}`))
      .digest("hex") !== sha256
  )
    throw new Error(`Bundled dependency license checksum mismatch: ${file}`);
