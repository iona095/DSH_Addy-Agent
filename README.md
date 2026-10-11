# DSH Addy-Agent — v1.0.3 bundles

DSH mode **Addy Agent** (`@local/dsh-addy-agent@1.0.3`).
Upstream: https://github.com/addyosmani/agent-skills @ `1be8e34187e34647bb83adc3a1323b26ae6f6abe` (upstream package 0.6.12).
Target DSH runtime: `0.2.1-alpha.2`.

## Contents

- `addy-agent-1.0.3.r2-Install/` — install bundle (~1.3 MB, 230 files). Top files + `locale/` + `upstream/` (212 files). Use to install on another machine.
- `addy-agent-1.0.3.r2-dev/` — evolve bundle (~22 MB, ~365 files after GitHub prep). Everything in Install PLUS `tests/` + `evidence/` (baselines). Nested `.git/` stripped for GitHub (see below).

## Install on another machine (from r2-Install)

1. Copy `addy-agent-1.0.3.r2-Install/` to a permanent path (keep while installed — local installs link it).
2. DSH Plugin Manager → `install_bundle` → absolute directory. No build step.
3. Check activation status. Restart DSH if replacing an imported generation.
4. New session → select **Addy Agent**, working directory = target repo.

Disable: `plugin_manager` → `set_bundle` `@local/dsh-addy-agent` enabled false. Remove: `remove_bundle` same target.

## Evolve / add features (from r2-dev)

1. Edit `adapter-v2.mjs` / `core-v2.mjs` / `cordis.patch.yml` / `duplicate-guard*.mjs` — never edit `upstream/` bytes directly.
2. Verify from dev dir:
   ```powershell
   node --test tests/core.test.mjs
   node tests/contracts-runtime.mjs
   node tests/contracts-config.mjs
   ```
   Compare new `evidence/*.json` vs baselines.
3. Bump upstream: re-clone upstream at new revision into `upstream/`, run `node prepare.mjs` (needs matching DSH runtime + `js-yaml` + git), update docs.
4. Re-install via `install_bundle`, new session → Addy Agent, test `/spec /plan /build /test /ship`.

## GitHub prep notes (already applied here)

- Removed for GitHub push (breaks git submodules, re-creatable):
  - `addy-agent-1.0.3.r2-dev/upstream/.git/` (28 files, 2 MB) — revision still pinned in `upstream-manifest.json`
  - `addy-agent-1.0.3.r2-dev/tests/live-fixture/.git/` — tiny fixture repo
- Kept: `upstream/LICENSE`, all 212 upstream files, all tests/evidence baselines.
- To rebuild exact upstream bytes: `git clone https://github.com/addyosmani/agent-skills + git checkout 1be8e34187e34647bb83adc3a1323b26ae6f6abe`.

## Releases

See Releases `v1.0.3` for prior `addy-agent-1.0.3-latest.zip` + `addy-agent-1.0.3-dev.zip`; R2 workspace uses `addy-agent-1.0.3.r2-Install/` + `addy-agent-1.0.3.r2-dev/` directly (no local zips).
