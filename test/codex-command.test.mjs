import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { resolveCodexLaunch } from "../codex-command.mjs";

const execFileAsync = promisify(execFile);

test("default auto mode discovers and validates a local executable before bundled fallback", () => {
  const launch = resolveCodexLaunch({
    env: { PATH: "" },
    candidatePaths: [process.execPath],
  });
  assert.equal(launch.command, process.execPath);
  assert.equal(launch.source, "local");
  assert.equal(launch.mode, "auto");
  assert.equal(launch.fallback.source, "bundled");
});

test("auto candidates are tried in order and invalid candidates are skipped", () => {
  const fsApi = fakeFs({
    "/bad": { kind: "directory" },
    "/not-executable": { kind: "file", accessError: true },
    "/good": { kind: "file" },
  });
  const launch = resolveCodexLaunch({
    platform: "linux",
    candidatePaths: ["", "  ", null, "/bad", "/broken", "/not-executable", "/good"],
    fsApi,
    resolvePackage: fakePackageResolver,
  });
  assert.equal(launch.command, "/good");
  assert.deepEqual(launch.fallback, {
    command: process.execPath,
    argsPrefix: ["/bundled/codex.js"],
    source: "bundled",
    mode: "bundled",
  });
});

test("empty, whitespace, and null configuration values leave auto mode enabled", () => {
  for (const command of ["", "  ", null]) {
    const launch = resolveCodexLaunch({
      command,
      env: { RELAY_CODEX_COMMAND: " ", PATH: "" },
      candidatePaths: [process.execPath],
    });
    assert.equal(launch.source, "local");
  }
});

test("explicit paths and environment paths override auto discovery", () => {
  const fsApi = fakeFs({ "/configured": { kind: "file" }, "/environment": { kind: "file" } });
  assert.equal(
    resolveCodexLaunch({
      platform: "linux",
      command: "/configured",
      env: { RELAY_CODEX_COMMAND: "/environment" },
      candidatePaths: ["/auto"],
      fsApi,
    }).source,
    "config",
  );
  assert.equal(
    resolveCodexLaunch({
      platform: "linux",
      env: { RELAY_CODEX_COMMAND: "/environment" },
      candidatePaths: ["/auto"],
      fsApi,
    }).source,
    "environment",
  );
});

test("auto and bundled are explicit supported modes", () => {
  const fsApi = fakeFs({ "/local": { kind: "file" } });
  assert.equal(resolveCodexLaunch({
    platform: "linux",
    arch: "x64",
    command: "auto",
    candidatePaths: ["/local"],
    fsApi,
    resolvePackage: fakePackageResolver,
  }).source, "local");
  assert.equal(resolveCodexLaunch({ command: "bundled" }).source, "bundled");
});

test("explicit invalid paths fail instead of silently falling back", () => {
  assert.throws(
    () => resolveCodexLaunch({ platform: "linux", command: "/missing/codex", candidatePaths: [process.execPath] }),
    (error) => error.code === "CODEX_EXECUTABLE_NOT_FOUND",
  );
  assert.throws(
    () => resolveCodexLaunch({ platform: "linux", command: "relative/codex" }),
    (error) => error.code === "CODEX_EXECUTABLE_INVALID" && /absolute/.test(error.message),
  );
  assert.throws(
    () => resolveCodexLaunch({ platform: "linux", command: "/directory", fsApi: fakeFs({ "/directory": { kind: "directory" } }) }),
    (error) => error.code === "CODEX_EXECUTABLE_INVALID" && /regular file/.test(error.message),
  );
});

test("paths with spaces stay one spawn argument and are canonicalized", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay codex "));
  const executable = join(root, "Codex Tools", "codex");
  try {
    await mkdir(join(root, "Codex Tools"));
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    const launch = resolveCodexLaunch({ command: executable });
    assert.match(launch.command, /relay codex .*Codex Tools[\\/]codex$/);
    assert.deepEqual(launch.argsPrefix, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled package resolution covers macOS, Windows, and Linux on x64 and arm64", () => {
  const targets = [
    ["darwin", "arm64", "@openai/codex-darwin-arm64"],
    ["darwin", "x64", "@openai/codex-darwin-x64"],
    ["linux", "arm64", "@openai/codex-linux-arm64"],
    ["linux", "x64", "@openai/codex-linux-x64"],
    ["win32", "arm64", "@openai/codex-win32-arm64"],
    ["win32", "x64", "@openai/codex-win32-x64"],
  ];
  for (const [platform, arch, platformPackage] of targets) {
    const resolved = [];
    const launch = resolveCodexLaunch({
      command: "bundled",
      platform,
      arch,
      execPath: platform === "win32" ? "C:\\Program Files\\nodejs\\node.exe" : "/opt/node with spaces/node",
      resolvePackage(specifier) {
        resolved.push(specifier);
        return specifier === "@openai/codex/bin/codex.js"
          ? (platform === "win32" ? "C:\\relay plugin\\codex.js" : "/relay plugin/codex.js")
          : `/packages/${specifier}/package.json`;
      },
    });
    assert.deepEqual(resolved, ["@openai/codex/bin/codex.js", `${platformPackage}/package.json`]);
    assert.equal(launch.source, "bundled");
    assert.equal(launch.argsPrefix.length, 1);
  }
});

test("a missing bundled runtime has an actionable error", () => {
  assert.throws(
    () => resolveCodexLaunch({ command: "bundled", resolvePackage() { throw new Error("missing"); } }),
    (error) => error.code === "CODEX_RUNTIME_MISSING" && /RELAY_CODEX_COMMAND/.test(error.message),
  );
});

test("unsupported architectures require an explicit compatible command", () => {
  assert.throws(
    () => resolveCodexLaunch({ command: "bundled", platform: "linux", arch: "riscv64" }),
    (error) => error.code === "CODEX_PLATFORM_UNSUPPORTED" && /RELAY_CODEX_COMMAND/.test(error.message),
  );
});

test("the bundled platform binary runs with an empty PATH", async () => {
  const launch = resolveCodexLaunch({ command: "bundled", env: { PATH: "" } });
  const { stdout } = await execFileAsync(launch.command, [...launch.argsPrefix, "--version"], {
    env: { ...process.env, PATH: "" },
    windowsHide: true,
  });
  assert.match(stdout, /^codex-cli \d+\./);
});

test("the pinned Codex package covers supported desktop targets", async () => {
  const manifest = await import("@openai/codex/package.json", { with: { type: "json" } });
  assert.deepEqual(
    Object.keys(manifest.default.optionalDependencies).sort(),
    [
      "@openai/codex-darwin-arm64",
      "@openai/codex-darwin-x64",
      "@openai/codex-linux-arm64",
      "@openai/codex-linux-x64",
      "@openai/codex-win32-arm64",
      "@openai/codex-win32-x64",
    ],
  );
});

function fakeFs(entries) {
  return {
    realpathSync(path) {
      if (!entries[path]) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return path;
    },
    statSync(path) {
      if (entries[path]?.kind !== "file") return { isFile: () => false };
      return { isFile: () => true };
    },
    accessSync(path) {
      if (entries[path]?.accessError) throw new Error("EACCES");
    },
  };
}

function fakePackageResolver(specifier) {
  return specifier === "@openai/codex/bin/codex.js"
    ? "/bundled/codex.js"
    : `/packages/${specifier}/package.json`;
}
