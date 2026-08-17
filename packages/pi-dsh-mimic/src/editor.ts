import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

import { EDITOR_TRUNCATED_MESSAGE } from "./constants.js";

export type EditorCommand = "view" | "create" | "str_replace" | "insert";

export interface EditorArgs {
  path: string;
  command: EditorCommand;
  view_range?: number[];
  old_str?: string;
  new_str?: string;
  insert_line?: number;
  file_text?: string;
}

const OUTPUT_LIMIT = 16_000;

function requireAbsolutePath(candidate: string): string {
  if (candidate.trim() === "" || !isAbsolute(candidate)) {
    throw new Error(`Path is not an absolute path: ${candidate}`);
  }
  return candidate;
}

function requireArgument(value: string | undefined, argument: string, command: EditorCommand): string {
  if (value === undefined) throw new Error(`${command} requires ${argument}`);
  return value;
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n${EDITOR_TRUNCATED_MESSAGE}`;
}

function directoryView(root: string): string {
  const rows: string[] = [root];
  const walk = (directory: string, depth: number): void => {
    if (depth > 2) return;
    const children = readdirSync(directory, { withFileTypes: true })
      .filter((item) => !item.name.startsWith(".")
        && item.name !== "node_modules"
        && item.name !== "__pycache__")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const absolute = join(directory, child.name);
      rows.push(`${relative(root, absolute)}${child.isDirectory() ? "/" : ""}`);
      if (child.isDirectory()) walk(absolute, depth + 1);
    }
  };
  walk(root, 1);
  return rows.join("\n");
}

function fileView(path: string, range?: number[]): string {
  const lines = readFileSync(path, "utf8").split("\n");
  const start = range?.[0] ?? 1;
  const requestedEnd = range?.[1] ?? -1;
  const end = requestedEnd === -1 ? lines.length : requestedEnd;
  if ((range !== undefined && range.length !== 2)
    || !Number.isInteger(start)
    || !Number.isInteger(end)
    || start < 1
    || end < start
    || end > lines.length) {
    throw new Error(`Invalid view_range for ${path}`);
  }
  const body = lines.slice(start - 1, end)
    .map((line, offset) => `${String(start + offset).padStart(6, " ")}  ${line}`)
    .join("\n");
  return `Contents of ${path}:\n${body}`;
}

function replaceUnique(source: string, needle: string, replacement: string): string {
  const match = source.indexOf(needle);
  if (match === -1) throw new Error("old_str was not found");
  if (source.indexOf(needle, match + needle.length) !== -1) {
    throw new Error("Multiple matches found for old_str");
  }
  return source.slice(0, match) + replacement + source.slice(match + needle.length);
}

export function executeEditor(args: EditorArgs, outputLimit = OUTPUT_LIMIT): string {
  const path = requireAbsolutePath(args.path);

  if (args.command === "create") {
    if (existsSync(path)) throw new Error(`Cannot create an existing path: ${path}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, requireArgument(args.file_text, "file_text", args.command), {
      encoding: "utf8",
      flag: "wx",
    });
    return `Created successfully: ${path}`;
  }

  if (!existsSync(path)) throw new Error(`Path does not exist: ${path}`);
  const info = statSync(path);

  if (args.command === "view") {
    const output = info.isDirectory() ? directoryView(path) : fileView(path, args.view_range);
    return clip(output, outputLimit);
  }
  if (!info.isFile()) throw new Error(`Editing requires a regular file: ${path}`);

  const source = readFileSync(path, "utf8");
  if (args.command === "str_replace") {
    const next = replaceUnique(
      source,
      requireArgument(args.old_str, "old_str", args.command),
      args.new_str ?? "",
    );
    writeFileSync(path, next, "utf8");
    return `Replaced text in ${path}`;
  }

  if (!Number.isInteger(args.insert_line)) throw new Error("insert requires insert_line");
  const insertAfter = args.insert_line as number;
  const lines = source.split("\n");
  if (insertAfter < 0 || insertAfter > lines.length) {
    throw new Error(`insert_line is outside the file: ${insertAfter}`);
  }
  lines.splice(insertAfter, 0, requireArgument(args.new_str, "new_str", args.command));
  writeFileSync(path, lines.join("\n"), "utf8");
  return `Inserted text in ${path}`;
}
