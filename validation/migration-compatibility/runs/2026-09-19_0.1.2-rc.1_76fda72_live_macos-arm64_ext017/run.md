# Codex Validation Run 2026-09-19_0.1.2-rc.1_76fda72_live_macos-arm64_ext017

## Environment

- Started: 2026-09-19 Asia/Shanghai
- Operator: Codex automated delivery validation
- Plugin candidate: `relay-dsh-plugin-codex@0.2.4-rc.1`
- Plugin baseline commit: `2c5523bb64c1d5201cafa63545ac136c30fe40b4`
- Plugin branch: `codex/issue-44-runtime-hot-reload`
- DSH commit: `76fda729799fe9b3848dbe2c211d4b231032b81e`
- Node.js/OS: `v25.5.0`, `Darwin 24.3.0 arm64`
- Browser: Playwright Chromium 1228, headless, isolated profile
- Model: `gpt-5.6-sol`, reasoning effort `high`

## Cases selected

- `cases/CDX-EXT-017--reserved-dsh-mcp-tool-name.md`
- Existing delivery regression scenarios in `scripts/verify-codex-delivery.mjs`

## Candidate and fixture

- Candidate tarball SHA-256: `55e53cf776a8c213de99ce7163efa3d5344d22802a2648bdb1caa1a282fda018`
- Candidate tarball size: `657548` bytes
- Installed client bundle SHA-256: `81b190719417b020e6799b3c7e6061cbaa3f56c66083f45c2b03edbb1af8c0bd`
- MCP fixture SHA-256: `da5489b2f92d6d1d4b2c3d1788e0c593c4fec0b5935dff50d7a15fec1d462cfe`
- MCP fixture size: `1663` bytes

## Invocation

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/Users/boboyang/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' \
node scripts/verify-codex-delivery.mjs
```

## Evidence index

- `evidence/CDX-EXT-017/session-evidence.md`
- `evidence/CDX-EXT-017/result.json`
- `evidence/CDX-EXT-017/08-reserved-mcp-alias.png`
- `evidence/CDX-EXT-017/01-baseline.png` through `07-cancelled.png`

The run used a temporary isolated DSH home. No credentials, temporary home,
complete Session archive, or production/customer data are retained here.
