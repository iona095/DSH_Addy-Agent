# Addy Agent 1.0.3 — DEV bundle for evolving the mode

Source: M:\AIFUN\WorkDir\addy-agent (full copy, 2026-10-11)
Version: 1.0.3 (@local/dsh-addy-agent)
Upstream: https://github.com/addyosmani/agent-skills @ 1be8e34187e34647bb83adc3a1323b26ae6f6abe
Target DSH runtime: 0.2.1-alpha.2
Contents: 426 files, ~24 MB (vs -latest install bundle 230 files, ~1.3 MB)

## -latest vs -dev
- addy-agent-1.0.3-latest = install only: top files + locale + upstream (212 files, no .git). Use to install on another machine.
- addy-agent-1.0.3-dev (this folder) = evolve: everything in -latest PLUS:
  - tests/ (21 files, 0.18 MB) — contract + native + duplicate-guard + live-verifier suites
  - evidence/ (176 files) — baselines: contracts-*.json, native-*.json, duplicate-guard-*.json, live-*.json + live-*.md reports, before-install.json
  - upstream/.git/ (28 files, 2 MB) — needed so prepare.mjs can run git ls-tree/hash-object to rebuild upstream-manifest.json when bumping upstream
  - tests/live-fixture/.git/ — tiny fixture repo used by live tests

## How to evolve / add features
1. Copy this folder to permanent dev path (keep while installed — local installs link it).
2. Edit: adapter-v2.mjs / core-v2.mjs (runtime), cordis.patch.yml (preset), duplicate-guard.mjs / duplicate-guard-core.mjs (guard), locale/en.json, docs.
   Do NOT edit upstream/ bytes directly — adaptation lives outside upstream. To bump upstream: git fetch + checkout new revision in upstream/, then run prepare.mjs.
3. Verify (from this directory):
   node --test tests/core.test.mjs
   node tests/contracts-runtime.mjs / contracts-config.mjs / native-*.mjs / duplicate-guard-*.mjs
   Compare new evidence/*.json against baselines in evidence/.
4. Rebuild manifest/patch if needed: node prepare.mjs (needs same DSH runtime path + upstream/.git + js-yaml; never writes profile/upstream tree).
5. Re-install via Plugin Manager install_bundle (absolute path), new session -> Addy Agent, test /spec /plan /build /test /ship.
6. Update README.md / VERIFICATION.md / REPAIR_NOTES.md / DUPLICATE-GUARD.md + keep new evidence/ before shipping.

## Install on another machine from -dev
Works same as -latest (install_bundle absolute path), just heavier (~24 MB vs ~1.3 MB) because of tests/evidence/.git. Prefer -latest for pure install.
