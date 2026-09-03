import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = path.resolve(packageRoot, "../..");

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

test("release metadata exposes one installable Broker plugin with aligned versions", async () => {
  const pluginRoot = path.join(packageRoot, "plugin", "mixagents-broker");
  const [packageManifest, pluginManifest, runtimeManifest, marketplace] =
    await Promise.all([
      readJson(path.join(packageRoot, "package.json")),
      readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json")),
      readJson(path.join(pluginRoot, "package.json")),
      readJson(path.join(repositoryRoot, ".agents", "plugins", "marketplace.json")),
    ]);

  assert.equal(packageManifest.version, pluginManifest.version);
  assert.equal(pluginManifest.version, runtimeManifest.version);
  assert.equal(packageManifest.private, true);
  assert.equal(pluginManifest.name, "mixagents-broker");
  assert.equal(runtimeManifest.name, pluginManifest.name);
  assert.equal(runtimeManifest.publishConfig.access, "public");
  assert.equal(path.basename(pluginRoot), pluginManifest.name);

  assert.equal(marketplace.name, "mixagents");
  assert.equal(marketplace.plugins.length, 1);
  const entry = marketplace.plugins[0];
  assert.equal(entry.name, pluginManifest.name);
  assert.equal(entry.source.source, "npm");
  assert.equal(entry.source.package, runtimeManifest.name);
  assert.equal(entry.source.version, pluginManifest.version);
  assert.equal(entry.source.registry, "https://registry.npmjs.org");
  assert.equal(entry.policy.installation, "AVAILABLE");
  assert.equal(entry.policy.authentication, "ON_INSTALL");
  assert.equal(entry.category, pluginManifest.interface.category);

  await access(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
  await access(path.join(pluginRoot, ".mcp.json"));
  await access(path.join(pluginRoot, "README.md"));
  await access(path.join(pluginRoot, "skills", "broker", "SKILL.md"));
  await access(path.join(pluginRoot, "dist", "server.js"));
});
