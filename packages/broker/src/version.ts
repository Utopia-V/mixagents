import { readFileSync } from "node:fs";

// The plugin's package.json sits next to dist/ in the published package, so
// the reported version cannot drift from the released one.
const manifest: unknown = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

export const BROKER_VERSION: string =
  typeof manifest === "object" &&
  manifest !== null &&
  typeof (manifest as { version?: unknown }).version === "string"
    ? (manifest as { version: string }).version
    : "0.0.0";
