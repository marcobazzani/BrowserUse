# CI + packaging

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development

**Goal:** Put BrowserUse under CI so we can't merge red, package the extension for realistic distribution, and reduce setup friction with a one-command install script.

---

### Task 1: GitHub Actions — fast CI (unit + integration)

**File:** `.github/workflows/ci.yml`

Matrix: `ubuntu-latest`, `macos-latest`. Node 20. Cache pnpm store. Run `test:unit` + `test:integration`. Build every package. No headed Chromium here — that's Task 2.

```yaml
name: CI
on:
  push:
    branches: [main, master]
  pull_request:
jobs:
  test:
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9.12.0 }
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r build
      - run: pnpm -r test:unit
      - run: pnpm -r test:integration
```

Add a README badge (`![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg)`) — update after first green run.

Commit: `ci: add unit + integration workflow on ubuntu + macos`

---

### Task 2: GitHub Actions — headed e2e (manual + nightly)

**File:** `.github/workflows/e2e.yml`

Runs the Playwright e2e test inside xvfb so Chromium can run "headed" in CI. Gated: manual dispatch + nightly cron so it doesn't slow down regular PR review. Assumes Task 6 of the runtime-robustness plan has fixed the e2e test.

```yaml
name: E2E
on:
  workflow_dispatch:
  schedule:
    - cron: "0 4 * * *"   # daily at 04:00 UTC
jobs:
  e2e:
    runs-on: ubuntu-latest
    env:
      BROWSERUSE_E2E: "1"
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9.12.0 }
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r build
      - run: pnpm -F @browseruse/extension exec playwright install --with-deps chromium
      - run: xvfb-run -a pnpm -F @browseruse/extension test:integration
      - name: upload artefacts on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-artefacts
          path: |
            packages/extension/test-results
            packages/extension/playwright-report
```

Commit: `ci: add nightly headed e2e workflow (xvfb + Playwright chromium)`

---

### Task 3: Release workflow — tagged extension zip

**File:** `.github/workflows/release.yml`

When a `v*` tag is pushed, build the extension and publish a `.zip` of `packages/extension/dist/` as a GitHub release asset. No Chrome Web Store upload (that requires an account + privacy review we haven't done); the zip is for manual sideload / inspection.

```yaml
name: Release
on:
  push:
    tags: ['v*']
jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9.12.0 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -F @browseruse/shared build
      - run: pnpm -F @browseruse/mcp-server build
      - run: pnpm -F @browseruse/extension build
      - name: package extension
        run: cd packages/extension/dist && zip -r ../../../browseruse-extension-${{ github.ref_name }}.zip .
      - uses: softprops/action-gh-release@v2
        with:
          files: browseruse-extension-*.zip
          generate_release_notes: true
```

Commit: `ci: release workflow — tag v* publishes packaged extension zip`

---

### Task 4: Extension — Chrome Web Store readiness

Not a submission, just a checklist of manifest hygiene so a future submission is one step away.

**Files:**
- Modify: `packages/extension/manifest.json`
- Create: `packages/extension/PRIVACY.md`
- Create: `packages/extension/README.md` (short — extension-specific)

Manifest edits:
- `"name"`: keep `"BrowserUse"`.
- `"description"`: expand to ≤132 chars, no hype language.
- Consider narrowing `host_permissions: ["<all_urls>"]` to `"activeTab"` if the tools work with that — but most of our handlers use `chrome.tabs.update` + `chrome.scripting.executeScript` cross-tab, so `<all_urls>` is justified. Document why in PRIVACY.md.
- Add `"short_name": "BrowserUse"`.
- Add `"author": "Marco Bazzani"` (or the user's choice).
- Add `"homepage_url"` pointing at the GitHub repo once it exists.

`PRIVACY.md` content outline:
- What the extension does (in two sentences).
- What data leaves the browser: NONE (to any server you don't control). It talks to a localhost-only WebSocket run by a process on your own machine.
- What permissions are used and why (each of the 6 explained in one line).
- No telemetry, no analytics, no third-party SDKs.

Commit: `docs: extension manifest + privacy notes ready for Chrome Web Store`

---

### Task 5: Install script

**File:** `scripts/install.sh`

One command: builds everything, registers the MCP server with Claude Code, generates a token, prints the chrome://extensions URL. Doesn't load the extension (Chrome has no CLI API for this; user still clicks "Load unpacked").

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> building packages"
pnpm install --frozen-lockfile
pnpm -r build

echo "==> registering MCP server with Claude Code (user scope)"
TOKEN="$(openssl rand -hex 24)"
claude mcp add browseruse \
  --scope user \
  --env "BROWSERUSE_TOKEN=$TOKEN" \
  -- node "$(pwd)/packages/mcp-server/dist/index.js"

echo
echo "==> NEXT STEPS (manual)"
echo "1. Open chrome://extensions"
echo "2. Enable Developer mode (top right)"
echo "3. Click 'Load unpacked' and select:"
echo "   $(pwd)/packages/extension/dist"
echo "4. Click the BrowserUse toolbar icon and paste this token:"
echo "   $TOKEN"
echo "5. Start 'claude' and try: 'open https://example.com'"
```

Make it executable and reference it from the root `README.md`:
```bash
chmod +x scripts/install.sh
```

Commit: `chore: install.sh — one command builds + registers MCP server`

---

### Task 6: Pre-commit hook (optional but recommended)

**File:** `.githooks/pre-commit` + hook install in `scripts/install.sh`

Runs `pnpm -r test:unit` before every commit. Fast (< 3s on a clean cache). Can be bypassed with `--no-verify` in emergencies.

```bash
#!/usr/bin/env bash
exec pnpm -r test:unit
```

Install hook via git config:
```bash
git config core.hooksPath .githooks
```

Add the `git config` line to `install.sh`.

Commit: `ci: pre-commit hook runs unit tests`

---

### Manual verification after all tasks

- [ ] Push a branch → CI workflow runs on GitHub → green on both OSes.
- [ ] Tag `v0.2.0` → release workflow runs → a `browseruse-extension-v0.2.0.zip` appears on the GitHub Releases page.
- [ ] Run `./scripts/install.sh` on a clean clone — Claude Code is registered, a token is printed, the user can complete setup in 3 clicks.
- [ ] Commit a broken test — pre-commit hook refuses.

## Out of scope

- Actually submitting to the Chrome Web Store. That requires a dev account, US$5, a privacy review cycle (~1-2 weeks), and screenshots. Do as a separate push.
- Signed releases / `provenance: true` on GitHub Actions. Worth adding once there are external users; overkill for personal use.
- Dependabot / Renovate config — sensible but not blocking. Add separately.
