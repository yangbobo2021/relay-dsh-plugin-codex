import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { releaseMetadata } from "../scripts/release-metadata.mjs";

test("stable release tags publish to latest", () => {
  assert.deepEqual(releaseMetadata("v0.1.0", "0.1.0"), {
    version: "0.1.0",
    npmTag: "latest",
  });
});

test("prerelease tags publish to next", () => {
  assert.deepEqual(releaseMetadata("v0.2.0-rc.1", "0.2.0-rc.1"), {
    version: "0.2.0-rc.1",
    npmTag: "next",
  });
});

test("release tags must exactly match the package version", () => {
  assert.throws(
    () => releaseMetadata("v0.2.0", "0.1.0"),
    /must exactly match v0\.1\.0/,
  );
});

test("release workflow uses guarded tokenless npm publishing", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /node scripts\/release-metadata\.mjs/);
  assert.match(workflow, /git merge-base --is-ancestor/);
  assert.match(workflow, /b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/);
  assert.match(workflow, /npm publish --provenance --access public --tag/);
  assert.match(workflow, /Verify the published dist-tag/);
  assert.match(workflow, /npm view \"\$\{package_name\}@\$\{npm_tag\}\" version/);
  assert.match(workflow, /os: \[ubuntu-latest, macos-latest, windows-latest\]/);
  assert.match(workflow, /publish:\s+needs: codex-runtime/);
  assert.ok(
    workflow.indexOf("npm install --global") > workflow.indexOf("Check whether this version already exists"),
    "the OIDC npm upgrade must not affect DSH build or verification",
  );
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN/);
});

test("CI and release build clean official DSH packages before plugin verification", async () => {
  const workflowUrls = [
    new URL("../.github/workflows/ci.yml", import.meta.url),
    new URL("../.github/workflows/release.yml", import.meta.url),
  ];

  for (const workflowUrl of workflowUrls) {
    const workflow = await readFile(workflowUrl, "utf8");
    assert.match(workflow, /pnpm\/action-setup@v6/);
    assert.match(workflow, /node-version: 22\.23\.2/);
    const installIndex = workflow.indexOf("pnpm install --ignore-scripts --frozen-lockfile");
    const buildIndex = workflow.indexOf("pnpm run build:lib");
    const verifyIndex = workflow.indexOf("npm run verify");

    assert.notEqual(installIndex, -1, `${workflowUrl.pathname} must install official DSH`);
    assert.ok(buildIndex > installIndex, `${workflowUrl.pathname} must build DSH after install`);
    assert.ok(verifyIndex > buildIndex, `${workflowUrl.pathname} must build DSH before verification`);
  }
});
