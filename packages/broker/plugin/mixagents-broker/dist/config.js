import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrokerError } from "./errors.js";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ACCESS_VALUES = new Set(["read-only", "workspace-write"]);
const EFFORT_VALUES = new Set([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
]);
const FORBIDDEN_ROUTE_KEYS = [
    "apiKey",
    "api_key",
    "token",
    "bearerToken",
    "authorization",
    "httpHeaders",
    "headers",
];
const CREDENTIALS_ENVIRONMENT = "MIXAGENTS_BROKER_CREDENTIALS_JSON";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringValue(value, label) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new BrokerError("invalid_config", `${label} must be a non-empty string`);
    }
    return value.trim();
}
function optionalString(value, label) {
    if (value === undefined) {
        return undefined;
    }
    return stringValue(value, label);
}
function expandHome(input) {
    if (input === "~") {
        return homedir();
    }
    if (input.startsWith(`~${path.sep}`) || input.startsWith("~/")) {
        return path.join(homedir(), input.slice(2));
    }
    return input;
}
export function defaultConfigPath(environment = process.env) {
    if (environment.MIXAGENTS_BROKER_CONFIG) {
        return path.resolve(expandHome(environment.MIXAGENTS_BROKER_CONFIG));
    }
    if (platform() === "win32") {
        const root = environment.APPDATA ?? path.join(homedir(), "AppData", "Roaming");
        return path.join(root, "MixAgents", "broker.json");
    }
    const root = environment.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");
    return path.join(root, "mixagents", "broker.json");
}
export function defaultDataDir(environment = process.env) {
    if (environment.MIXAGENTS_BROKER_DATA_DIR) {
        return path.resolve(expandHome(environment.MIXAGENTS_BROKER_DATA_DIR));
    }
    if (platform() === "win32") {
        const root = environment.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local");
        return path.join(root, "MixAgents", "Broker");
    }
    const root = environment.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state");
    return path.join(root, "mixagents-broker");
}
export function materializeCredentialEnvironment(environment) {
    const result = { ...environment };
    const encoded = environment[CREDENTIALS_ENVIRONMENT];
    if (!encoded) {
        return result;
    }
    let parsed;
    try {
        parsed = JSON.parse(encoded);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new BrokerError("invalid_credential_environment", `${CREDENTIALS_ENVIRONMENT} must be a JSON object: ${message}`);
    }
    if (!isRecord(parsed)) {
        throw new BrokerError("invalid_credential_environment", `${CREDENTIALS_ENVIRONMENT} must be a JSON object`);
    }
    for (const [name, value] of Object.entries(parsed)) {
        if (!ENVIRONMENT_NAME.test(name) || typeof value !== "string" || value === "") {
            throw new BrokerError("invalid_credential_environment", `${CREDENTIALS_ENVIRONMENT} entries must map environment-variable names to non-empty strings`);
        }
        if (!result[name]) {
            result[name] = value;
        }
    }
    return result;
}
function parseEnvironmentHeaders(value, routeId) {
    if (value === undefined) {
        return {};
    }
    if (!isRecord(value)) {
        throw new BrokerError("invalid_config", `routes.${routeId}.envHttpHeaders must be an object`);
    }
    const result = {};
    for (const [header, environmentName] of Object.entries(value)) {
        const name = stringValue(environmentName, `routes.${routeId}.envHttpHeaders.${header}`);
        if (!ENVIRONMENT_NAME.test(name)) {
            throw new BrokerError("invalid_config", `routes.${routeId}.envHttpHeaders.${header} is not an environment-variable name`);
        }
        result[header] = name;
    }
    return result;
}
function parseRoute(id, value) {
    if (!IDENTIFIER.test(id)) {
        throw new BrokerError("invalid_config", `route id ${JSON.stringify(id)} must match ${IDENTIFIER.source}`);
    }
    if (!isRecord(value)) {
        throw new BrokerError("invalid_config", `routes.${id} must be an object`);
    }
    for (const key of FORBIDDEN_ROUTE_KEYS) {
        if (key in value) {
            throw new BrokerError("inline_credential_forbidden", `routes.${id}.${key} is not allowed; reference credential environment variables instead`);
        }
    }
    const provider = stringValue(value.provider, `routes.${id}.provider`);
    if (!IDENTIFIER.test(provider)) {
        throw new BrokerError("invalid_config", `routes.${id}.provider must match ${IDENTIFIER.source}`);
    }
    const baseUrl = stringValue(value.baseUrl, `routes.${id}.baseUrl`);
    let parsedUrl;
    try {
        parsedUrl = new URL(baseUrl);
    }
    catch {
        throw new BrokerError("invalid_config", `routes.${id}.baseUrl is not a valid URL`);
    }
    if (parsedUrl.username || parsedUrl.password) {
        throw new BrokerError("inline_credential_forbidden", `routes.${id}.baseUrl must not contain credentials`);
    }
    const localHttp = parsedUrl.protocol === "http:" &&
        ["localhost", "127.0.0.1", "::1"].includes(parsedUrl.hostname);
    if (parsedUrl.protocol !== "https:" && !localHttp) {
        throw new BrokerError("invalid_config", `routes.${id}.baseUrl must use HTTPS, except for a loopback test endpoint`);
    }
    const envKey = optionalString(value.envKey, `routes.${id}.envKey`);
    if (envKey && !ENVIRONMENT_NAME.test(envKey)) {
        throw new BrokerError("invalid_config", `routes.${id}.envKey is not an environment-variable name`);
    }
    const tagsValue = value.tags ?? [];
    if (!Array.isArray(tagsValue) || !tagsValue.every((tag) => typeof tag === "string")) {
        throw new BrokerError("invalid_config", `routes.${id}.tags must be strings`);
    }
    const maxAccessValue = value.maxAccess ?? "read-only";
    if (typeof maxAccessValue !== "string" || !ACCESS_VALUES.has(maxAccessValue)) {
        throw new BrokerError("invalid_config", `routes.${id}.maxAccess must be read-only or workspace-write`);
    }
    const effortValue = value.reasoningEffort;
    if (effortValue !== undefined &&
        (typeof effortValue !== "string" || !EFFORT_VALUES.has(effortValue))) {
        throw new BrokerError("invalid_config", `routes.${id}.reasoningEffort is unsupported`);
    }
    const contextWindowValue = value.contextWindow;
    if (contextWindowValue !== undefined &&
        (!Number.isSafeInteger(contextWindowValue) || contextWindowValue < 1_024)) {
        throw new BrokerError("invalid_config", `routes.${id}.contextWindow must be an integer of at least 1024`);
    }
    const route = {
        id,
        description: stringValue(value.description, `routes.${id}.description`),
        provider,
        providerName: optionalString(value.providerName, `routes.${id}.providerName`) ?? provider,
        model: stringValue(value.model, `routes.${id}.model`),
        baseUrl: parsedUrl.toString().replace(/\/$/, ""),
        envHttpHeaders: parseEnvironmentHeaders(value.envHttpHeaders, id),
        tags: tagsValue.map((tag) => tag.trim()).filter(Boolean),
        maxAccess: maxAccessValue,
    };
    if (envKey) {
        route.envKey = envKey;
    }
    if (contextWindowValue !== undefined) {
        route.contextWindow = contextWindowValue;
    }
    if (effortValue) {
        route.reasoningEffort = effortValue;
    }
    return route;
}
export function parseConfig(input, configPath, environment = process.env) {
    if (!isRecord(input)) {
        throw new BrokerError("invalid_config", "Broker configuration must be an object");
    }
    if (!isRecord(input.routes) || Object.keys(input.routes).length === 0) {
        throw new BrokerError("invalid_config", "Broker configuration needs at least one route");
    }
    const routes = Object.entries(input.routes).map(([id, value]) => parseRoute(id, value));
    const defaultRoute = optionalString(input.defaultRoute, "defaultRoute");
    if (defaultRoute && !routes.some((route) => route.id === defaultRoute)) {
        throw new BrokerError("invalid_config", `defaultRoute ${JSON.stringify(defaultRoute)} does not exist`);
    }
    const rootsValue = input.workspaceRoots ?? [];
    if (!Array.isArray(rootsValue) || !rootsValue.every((root) => typeof root === "string")) {
        throw new BrokerError("invalid_config", "workspaceRoots must be an array of paths");
    }
    const dataDirValue = optionalString(input.dataDir, "dataDir") ?? defaultDataDir(environment);
    const codexBin = optionalString(input.codexBin, "codexBin") ??
        optionalString(environment.MIXAGENTS_BROKER_CODEX_BIN, "MIXAGENTS_BROKER_CODEX_BIN") ??
        "codex";
    const result = {
        path: path.resolve(configPath),
        workspaceRoots: rootsValue.map((root) => path.resolve(expandHome(root))),
        dataDir: path.resolve(expandHome(dataDirValue)),
        codexBin: expandHome(codexBin),
        routes,
    };
    if (defaultRoute) {
        result.defaultRoute = defaultRoute;
    }
    return result;
}
export async function loadConfig(configPath = defaultConfigPath(), environment = process.env) {
    let contents;
    try {
        contents = await readFile(configPath, "utf8");
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new BrokerError("config_missing", `Cannot read Broker configuration at ${configPath}: ${message}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(contents);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new BrokerError("invalid_config", `Invalid JSON in ${configPath}: ${message}`);
    }
    return parseConfig(parsed, configPath, environment);
}
export function routeView(route, config, environment = process.env) {
    const environmentNames = [
        ...(route.envKey ? [route.envKey] : []),
        ...Object.values(route.envHttpHeaders),
    ];
    const missingEnvironment = [...new Set(environmentNames)].filter((name) => !environment[name]);
    const view = {
        id: route.id,
        description: route.description,
        provider: route.provider,
        model: route.model,
        tags: [...route.tags],
        available: missingEnvironment.length === 0,
        missingEnvironment,
        maxAccess: route.maxAccess,
        backend: "app_server",
        selectionReason: "Current native Codex children cannot use a provider distinct from the controller; App Server preserves this route.",
        nativeAgentType: null,
        default: config.defaultRoute === route.id,
    };
    if (route.contextWindow !== undefined) {
        view.contextWindow = route.contextWindow;
    }
    return view;
}
function rootPathFromInput(root) {
    if (root.startsWith("file:")) {
        return fileURLToPath(root);
    }
    return root;
}
function isWithin(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
export async function validateWorkspace(cwdInput, configuredRoots, clientRoots) {
    const cwd = await resolveWorkspace(cwdInput);
    const roots = [...configuredRoots, ...clientRoots.map(rootPathFromInput)];
    const resolvedRoots = [];
    for (const root of roots) {
        try {
            resolvedRoots.push(await realpath(path.resolve(expandHome(root))));
        }
        catch {
            // A stale advertised root grants nothing.
        }
    }
    if (resolvedRoots.length === 0) {
        throw new BrokerError("workspace_root_required", "No usable workspace root is authorized");
    }
    if (!resolvedRoots.some((root) => isWithin(root, cwd))) {
        throw new BrokerError("workspace_denied", `cwd ${cwd} is outside the allowed workspace roots`);
    }
    return cwd;
}
export async function resolveWorkspace(cwdInput) {
    if (!path.isAbsolute(cwdInput)) {
        throw new BrokerError("invalid_workspace", "cwd must be an absolute path");
    }
    try {
        const cwd = await realpath(cwdInput);
        const info = await stat(cwd);
        if (!info.isDirectory()) {
            throw new BrokerError("invalid_workspace", `${cwdInput} is not a directory`);
        }
        await access(cwd, constants.R_OK);
        return cwd;
    }
    catch (error) {
        if (error instanceof BrokerError) {
            throw error;
        }
        throw new BrokerError("invalid_workspace", `Cannot resolve or read cwd ${cwdInput}`);
    }
}
export function requireRoute(config, routeId) {
    const route = config.routes.find((candidate) => candidate.id === routeId);
    if (!route) {
        throw new BrokerError("route_not_found", `Broker route ${routeId} is not configured`);
    }
    return route;
}
export function requireAccess(route, requested) {
    const accessValue = requested ?? "read-only";
    if (typeof accessValue !== "string" || !ACCESS_VALUES.has(accessValue)) {
        throw new BrokerError("invalid_access", "access must be read-only or workspace-write");
    }
    const result = accessValue;
    if (result === "workspace-write" && route.maxAccess !== "workspace-write") {
        throw new BrokerError("access_denied", `route ${route.id} is capped at read-only access`);
    }
    return result;
}
