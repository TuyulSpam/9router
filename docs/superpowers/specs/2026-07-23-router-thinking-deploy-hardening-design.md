# Router Thinking Deploy Hardening Design

## Goal

Make the provider-owned thinking patch reproducible, prevent deployment of stale CLI tarballs, and provide a live smoke check for the two Codex-facing model paths used on this machine.

## Scope

- Preserve the existing `Kelas-berat` routing and provider-thinking behavior.
- Build deployment artifacts inside the unique pre-deploy backup directory.
- Verify package version, SHA-256, and Next.js `BUILD_ID` before installation.
- Verify the installed `BUILD_ID` matches the selected artifact.
- Add a guarded live smoke script for `Kelas-berat` and `ag/gemini-3-flash-agent`.
- Document the new deployment and smoke commands.
- Commit and deploy only the scoped thinking/deploy files from the isolated worktree.

## Non-Goals

- Do not alter combo members, fallback order, provider accounts, or dashboard thinking settings.
- Do not include unrelated Codex/Grok usage changes from the primary working tree.
- Do not add a Codex `model_catalog_json` override in this change.
- Do not change package version or install `9router@latest`.

## Artifact Flow

1. Create the pre-deploy backup directory.
2. Build the CLI application from `REPO`.
3. Run `npm pack` with the backup directory as `--pack-destination`.
4. Verify the tarball package version and packaged `BUILD_ID`.
5. Record SHA-256 and artifact metadata in `MANIFEST.txt`.
6. Install that exact tarball and compare its `BUILD_ID` with the live package.
7. Restart PM2, poll health, and optionally refresh the known-good pin.

## Verification

- Unit test runs `ops/deploy-live.sh` against a fake repo and fake process tools, proving the installed artifact comes from the unique backup directory rather than a stale fixed path.
- Existing provider-thinking regression tests remain green.
- Live smoke sends an explicit `medium` request through `Kelas-berat` and requires the Codex upstream request to use `max` under the current `ultra` setting.
- Live smoke sends an effort-free request to `ag/gemini-3-flash-agent` and requires Antigravity `thinkingLevel: high` under the current `xhigh` setting.

