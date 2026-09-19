import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

const require = createRequire(import.meta.url);
const BUNDLED_CODEX_ENTRY = "@openai/codex/bin/codex.js";
const PLATFORM_PACKAGE = Object.freeze({
  "darwin-arm64": "@openai/codex-darwin-arm64",
  "darwin-x64": "@openai/codex-darwin-x64",
  "linux-arm64": "@openai/codex-linux-arm64",
  "linux-x64": "@openai/codex-linux-x64",
  "win32-arm64": "@openai/codex-win32-arm64",
  "win32-x64": "@openai/codex-win32-x64",
});

export function resolveCodexLaunch({
  command,
  env = process.env,
  execPath = process.execPath,
  platform = process.platform,
  arch = process.arch,
  homeDirectory = homedir(),
  candidatePaths,
  fsApi = { accessSync, realpathSync, statSync },
  resolvePackage = require.resolve,
} = {}) {
  const configured = nonBlank(command);
  if (configured !== undefined) return resolveRequested(configured, "config");

  const environmentCommand = nonBlank(env.RELAY_CODEX_COMMAND);
  if (environmentCommand !== undefined) {
    return resolveRequested(environmentCommand, "environment");
  }

  return resolveAuto({
    env,
    execPath,
    platform,
    arch,
    homeDirectory,
    candidatePaths,
    fsApi,
    resolvePackage,
  });

  function resolveRequested(value, origin) {
    if (value.toLowerCase() === "auto") {
      return resolveAuto({
        env,
        execPath,
        platform,
        arch,
        homeDirectory,
        candidatePaths,
        fsApi,
        resolvePackage,
      });
    }
    if (value.toLowerCase() === "bundled") {
      return bundledLaunch({ platform, arch, execPath, resolvePackage });
    }
    return Object.freeze({
      command: validateExecutablePath(value, { platform, fsApi }),
      argsPrefix: [],
      source: origin,
      mode: "explicit",
    });
  }
}

function resolveAuto({
  env,
  execPath,
  platform,
  arch,
  homeDirectory,
  candidatePaths,
  fsApi,
  resolvePackage,
}) {
  const failures = [];
  for (const candidate of candidatePaths ?? defaultCandidatePaths({
    env,
    platform,
    homeDirectory,
  })) {
    const path = nonBlank(candidate);
    if (path === undefined) continue;
    try {
      const command = validateExecutablePath(path, { platform, fsApi });
      return Object.freeze({
        command,
        argsPrefix: [],
        source: "local",
        mode: "auto",
        fallback: bundledLaunch({ platform, arch, execPath, resolvePackage }),
      });
    } catch (error) {
      failures.push({ path, code: error.code ?? "CODEX_EXECUTABLE_INVALID" });
    }
  }

  const launch = bundledLaunch({ platform, arch, execPath, resolvePackage });
  return Object.freeze({
    ...launch,
    mode: "auto",
    discoveryFailures: failures,
  });
}

function defaultCandidatePaths({ env, platform, homeDirectory }) {
  const candidates = [];
  if (platform === "darwin") {
    for (const base of ["/Applications", join(homeDirectory, "Applications")]) {
      candidates.push(
        join(base, "ChatGPT.app", "Contents", "Resources", "codex"),
        join(base, "Codex.app", "Contents", "Resources", "codex"),
      );
    }
  } else if (platform === "win32") {
    const bases = [
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs"),
      env.PROGRAMFILES,
      env["PROGRAMFILES(X86)"],
    ].filter(Boolean);
    for (const base of bases) {
      candidates.push(
        join(base, "ChatGPT", "resources", "codex.exe"),
        join(base, "Codex", "resources", "codex.exe"),
      );
    }
  } else if (platform === "linux") {
    for (const base of [
      env.XDG_DATA_HOME && join(env.XDG_DATA_HOME, "applications"),
      join(homeDirectory, ".local", "share", "applications"),
    ].filter(Boolean)) {
      candidates.push(
        join(base, "ChatGPT", "resources", "codex"),
        join(base, "Codex", "resources", "codex"),
      );
    }
  }

  const pathSeparator = platform === "win32" ? ";" : delimiter;
  const pathEntries = typeof env.PATH === "string" ? env.PATH.split(pathSeparator) : [];
  for (const entry of pathEntries) {
    if (!nonBlank(entry)) continue;
    candidates.push(join(entry, platform === "win32" ? "codex.exe" : "codex"));
  }
  return candidates;
}

function bundledLaunch({ platform, arch, execPath, resolvePackage }) {
  const platformPackage = PLATFORM_PACKAGE[`${platform}-${arch}`];
  if (platformPackage === undefined) {
    const error = new Error(
      `The bundled Codex runtime does not support ${platform}/${arch}. `
      + "Set RELAY_CODEX_COMMAND to a compatible Codex executable.",
    );
    error.code = "CODEX_PLATFORM_UNSUPPORTED";
    throw error;
  }

  let launcher;
  try {
    launcher = resolvePackage(BUNDLED_CODEX_ENTRY);
    resolvePackage(`${platformPackage}/package.json`);
  } catch (cause) {
    const error = new Error(
      `The bundled Codex runtime for ${platform}/${arch} is unavailable. `
      + "Reinstall relay-dsh-plugin-codex, "
      + "or set RELAY_CODEX_COMMAND to an absolute Codex executable path.",
      { cause },
    );
    error.code = "CODEX_RUNTIME_MISSING";
    throw error;
  }

  return Object.freeze({
    command: execPath,
    argsPrefix: [launcher],
    source: "bundled",
    mode: "bundled",
  });
}

export function validateExecutablePath(
  value,
  { platform = process.platform, fsApi = { accessSync, realpathSync, statSync } } = {},
) {
  const path = nonBlank(value);
  if (path === undefined || !isAbsoluteForPlatform(path, platform)) {
    throw executableInvalidError(value, "an absolute executable path is required");
  }
  const { accessSync: checkAccess, realpathSync: resolvePath, statSync: stat } = fsApi;
  let canonical;
  try {
    canonical = resolvePath(path);
  } catch (cause) {
    const error = executableNotFoundError(path);
    error.cause = cause;
    throw error;
  }
  try {
    const details = stat(canonical);
    if (!details.isFile()) throw executableInvalidError(path, "the path is not a regular file");
    checkAccess(canonical, constants.X_OK);
  } catch (cause) {
    if (cause?.code === "CODEX_EXECUTABLE_INVALID") throw cause;
    throw executableInvalidError(path, "the file is not executable", cause);
  }
  return canonical;
}

export function codexSpawnError(error, command, source) {
  if (error?.code !== "ENOENT") return error;
  const wrapped = executableNotFoundError(command);
  wrapped.message = `Unable to start Codex from ${JSON.stringify(command)} (${source}). `
    + "Set RELAY_CODEX_COMMAND to an absolute Codex executable path, or reinstall "
    + "relay-dsh-plugin-codex to restore its bundled runtime.";
  wrapped.cause = error;
  return wrapped;
}

function executableNotFoundError(path) {
  const error = new Error(
    `Codex executable was not found at ${JSON.stringify(path)}. `
    + "Set RELAY_CODEX_COMMAND to an absolute executable path, or use auto/bundled.",
  );
  error.code = "CODEX_EXECUTABLE_NOT_FOUND";
  error.path = path;
  return error;
}

function executableInvalidError(path, reason, cause) {
  const error = new Error(`Codex executable at ${JSON.stringify(path)} is invalid: ${reason}.`);
  error.code = "CODEX_EXECUTABLE_INVALID";
  error.path = path;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function isAbsoluteForPlatform(value, platform) {
  return platform === "win32" ? /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) : isAbsolute(value);
}

function nonBlank(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
