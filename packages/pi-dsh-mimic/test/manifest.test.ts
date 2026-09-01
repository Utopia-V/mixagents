import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("package manifest exposes one loadable Pi extension", () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "pi-dsh-mimic");
  assert.equal(manifest.version, "0.1.2");
  assert.equal(
    manifest.description,
    "Unlock DeepSeek V4 Pro's DSH Minimal capability in Pi while keeping Pi's full plugin ecosystem",
  );
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.keywords.includes("pi-package"), true);
  assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);
  assert.equal(manifest.files.includes("docs/advanced.md"), true);
  assert.equal(manifest.files.includes("docs/advanced.zh-CN.md"), true);
  assert.equal(manifest.files.includes("docs/project2-evidence.md"), true);
  assert.equal(manifest.files.includes("scripts/session-stats.mjs"), true);
  assert.equal(manifest.files.some((path: string) => path.endsWith(".local.md")), false);
  assert.equal(manifest.files.includes("SECURITY.md"), true);
  assert.equal(existsSync(join(packageRoot, "src", "index.ts")), true);
  assert.equal(existsSync(join(packageRoot, "docs", "advanced.md")), true);
  assert.equal(existsSync(join(packageRoot, "docs", "advanced.zh-CN.md")), true);
  assert.equal(existsSync(join(packageRoot, "docs", "project2-evidence.md")), true);
  assert.equal(existsSync(join(packageRoot, "scripts", "session-stats.mjs")), true);
  assert.equal(manifest.repository.directory, "packages/pi-dsh-mimic");
});
