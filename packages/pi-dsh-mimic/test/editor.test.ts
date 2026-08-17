import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { executeEditor } from "../src/editor.js";

test("str_replace_editor supports create, numbered view, replace, and insert", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dsh-mimic-editor-"));
  try {
    const path = join(root, "sample.txt");
    assert.match(executeEditor({
      command: "create",
      path,
      file_text: "alpha\nbeta\ngamma",
    }), /created successfully/i);
    assert.match(executeEditor({
      command: "view",
      path,
      view_range: [2, 3],
    }), /2  beta[\s\S]*3  gamma/);
    executeEditor({
      command: "str_replace",
      path,
      old_str: "beta",
      new_str: "BETA",
    });
    executeEditor({
      command: "insert",
      path,
      insert_line: 1,
      new_str: "between",
    });
    assert.equal(readFileSync(path, "utf8"), "alpha\nbetween\nBETA\ngamma");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("str_replace_editor rejects ambiguous replacements and relative paths", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dsh-mimic-editor-"));
  try {
    const path = join(root, "sample.txt");
    executeEditor({ command: "create", path, file_text: "same\nsame" });
    assert.throws(() => executeEditor({
      command: "str_replace",
      path,
      old_str: "same",
      new_str: "different",
    }), /Multiple matches/);
    assert.throws(() => executeEditor({
      command: "view",
      path: "relative.txt",
    }), /not an absolute path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
