import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { BrokerError } from "./errors.js";
const WINDOWS_TARGETS = {
    x64: {
        packageName: "@openai/codex-win32-x64",
        targetTriple: "x86_64-pc-windows-msvc",
    },
    arm64: {
        packageName: "@openai/codex-win32-arm64",
        targetTriple: "aarch64-pc-windows-msvc",
    },
};
function environmentValue(environment, name) {
    const entry = Object.entries(environment).find(([key, value]) => key.toLowerCase() === name.toLowerCase() && value);
    return entry?.[1];
}
function managedWindowsExecutable(managedRoot, arch) {
    const target = WINDOWS_TARGETS[arch];
    if (!target) {
        return undefined;
    }
    let vendorRoot;
    try {
        const requireFromCodex = createRequire(path.join(managedRoot, "package.json"));
        const platformPackage = requireFromCodex.resolve(`${target.packageName}/package.json`);
        vendorRoot = path.join(path.dirname(platformPackage), "vendor");
    }
    catch {
        vendorRoot = path.join(managedRoot, "vendor");
    }
    const executable = path.join(vendorRoot, target.targetTriple, "bin", "codex.exe");
    return existsSync(executable) ? executable : undefined;
}
function windowsPathEntry(filename, environment) {
    const searchPath = environmentValue(environment, "PATH");
    if (!searchPath) {
        return undefined;
    }
    for (const rawDirectory of searchPath.split(";")) {
        const directory = rawDirectory.trim().replace(/^"|"$/g, "");
        if (!directory) {
            continue;
        }
        const candidate = path.win32.join(directory, filename);
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}
function windowsScriptSpec(command) {
    return {
        command,
        prefixArgs: [],
        launcher: "windows-command-script",
    };
}
export function resolveCodexProcess(codexBin, environment = process.env, options = {}) {
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    if (platform !== "win32") {
        return { command: codexBin, prefixArgs: [] };
    }
    const extension = path.win32.extname(codexBin).toLowerCase();
    if (extension === ".cmd" || extension === ".bat") {
        const resolved = path.win32.isAbsolute(codexBin)
            ? codexBin
            : windowsPathEntry(codexBin, environment) ?? codexBin;
        return windowsScriptSpec(resolved);
    }
    if (codexBin.toLowerCase() !== "codex") {
        return { command: codexBin, prefixArgs: [] };
    }
    const managedRoot = environmentValue(environment, "CODEX_MANAGED_PACKAGE_ROOT");
    const managedExecutable = managedRoot
        ? managedWindowsExecutable(managedRoot, arch)
        : undefined;
    if (managedExecutable) {
        return { command: managedExecutable, prefixArgs: [] };
    }
    const pathExecutable = windowsPathEntry("codex.exe", environment);
    if (pathExecutable) {
        return { command: pathExecutable, prefixArgs: [] };
    }
    const commandShim = windowsPathEntry("codex.cmd", environment);
    if (commandShim) {
        const inferredManagedRoot = path.win32.join(path.win32.dirname(commandShim), "node_modules", "@openai", "codex");
        const inferredExecutable = managedWindowsExecutable(inferredManagedRoot, arch);
        if (inferredExecutable) {
            return { command: inferredExecutable, prefixArgs: [] };
        }
        return windowsScriptSpec(commandShim);
    }
    const batchShim = windowsPathEntry("codex.bat", environment);
    if (batchShim) {
        return windowsScriptSpec(batchShim);
    }
    return { command: "codex.exe", prefixArgs: [] };
}
function windowsCommandToken(value) {
    if (/[\0\r\n"%!]/u.test(value)) {
        throw new BrokerError("invalid_codex_command", "The Windows Codex command contains characters that cannot be passed safely; configure codexBin with the full path to codex.exe");
    }
    if (/[\s&|<>^()]/u.test(value)) {
        return `"${value}"`;
    }
    return value;
}
export function buildProcessInvocation(spec, args, environment = process.env) {
    const fullArgs = [...spec.prefixArgs, ...args];
    if (spec.launcher !== "windows-command-script") {
        return {
            command: spec.command,
            args: fullArgs,
            windowsVerbatimArguments: false,
        };
    }
    const comspec = environmentValue(environment, "ComSpec") ?? "cmd.exe";
    const commandLine = `"${[
        windowsCommandToken(spec.command),
        ...fullArgs.map(windowsCommandToken),
    ].join(" ")}"`;
    return {
        command: comspec,
        args: ["/d", "/s", "/c", commandLine],
        windowsVerbatimArguments: true,
    };
}
