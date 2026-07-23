# Router Thinking Deploy Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent stale 9Router CLI artifacts from being deployed and make provider-owned thinking behavior reproducible and smoke-testable.

**Architecture:** `ops/deploy-live.sh` builds and packs directly into a unique backup directory, validates the artifact, installs that exact file, and verifies the installed build identity. A guarded `ops/smoke-thinking.sh` performs live checks against the local Responses endpoint and SQLite request observability.

**Tech Stack:** Bash, npm, tar, SHA-256, PM2, SQLite, Vitest, Node.js.

---

### Task 1: Reproduce stale artifact selection

**Files:**
- Create: `tests/unit/deploy-live.test.js`
- Test: `tests/unit/deploy-live.test.js`

- [ ] **Step 1: Write a fake-runtime deployment test**

Create a temporary repo plus fake `git`, `npm`, `pm2`, and `curl` commands. Make the fake build produce `fresh-build-id`, execute `ops/deploy-live.sh`, and assert the installed package and tarball inside the backup directory both contain that ID.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
NODE_PATH=/tmp/node_modules /tmp/node_modules/.bin/vitest run --config ./tests/vitest.config.js tests/unit/deploy-live.test.js
```

Expected: FAIL because the current script searches `/home/ubuntu/9router-<version>.tgz` instead of the artifact produced for the overridden `REPO`.

### Task 2: Build and install one verified artifact

**Files:**
- Modify: `ops/deploy-live.sh:9`
- Test: `tests/unit/deploy-live.test.js`

- [ ] **Step 1: Build into the backup directory**

Replace the fixed build-path flow with:

```bash
npm --prefix cli run build
npm --prefix cli pack --pack-destination "$BK"
```

Use the resulting `9router-<version>.tgz` in `"$BK"` as the only installation artifact for normal builds.

- [ ] **Step 2: Validate artifact identity**

Read `package/package.json` and `package/app/.next-cli-build/BUILD_ID` from the tarball, compare them with the source build, calculate SHA-256, and abort on mismatch.

- [ ] **Step 3: Verify the installed build**

After `npm install -g`, compare the installed `app/.next-cli-build/BUILD_ID` with the packaged ID and record artifact metadata in `MANIFEST.txt`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
NODE_PATH=/tmp/node_modules /tmp/node_modules/.bin/vitest run --config ./tests/vitest.config.js tests/unit/deploy-live.test.js tests/unit/provider-thinking-default.test.js
```

Expected: both files pass with zero failures.

### Task 3: Add guarded live smoke verification

**Files:**
- Create: `ops/smoke-thinking.sh`
- Modify: `DEPLOY.md:121`

- [ ] **Step 1: Add explicit execution guard**

Require `--run` before sending model requests and support configurable endpoint and SQLite paths through environment variables.

- [ ] **Step 2: Verify `Kelas-berat` ownership**

Send a Responses request containing client effort `medium`, locate the unique request in `requestDetails`, and require effective Codex effort `max` under the machine's current provider setting.

- [ ] **Step 3: Verify Antigravity ownership**

Send an effort-free request to `ag/gemini-3-flash-agent`, locate it in `requestDetails`, and require `providerRequest.request.generationConfig.thinkingConfig.thinkingLevel = high`.

- [ ] **Step 4: Document commands**

Document verified-artifact deployment and:

```bash
./ops/smoke-thinking.sh --run
```

### Task 4: Commit, deploy, and pin

**Files:**
- Modify: `open-sse/handlers/chatCore.js`
- Modify: `open-sse/translator/concerns/thinkingUnified.js`
- Modify: `tests/unit/provider-thinking-default.test.js`
- Modify: `ops/deploy-live.sh`
- Create: `tests/unit/deploy-live.test.js`
- Create: `ops/smoke-thinking.sh`
- Modify: `DEPLOY.md`

- [ ] **Step 1: Run syntax, unit, and diff checks**

Run `bash -n` on both ops scripts, the focused Vitest files, and `git diff --check`.

- [ ] **Step 2: Commit only scoped files**

Create a focused commit on the isolated branch without staging `cli/node_modules` or unrelated primary-worktree changes.

- [ ] **Step 3: Deploy the committed source with `--pin`**

Run the hardened deploy script from the isolated worktree and require matching packaged/live `BUILD_ID`, PM2 online status, and healthy API.

- [ ] **Step 4: Run the live smoke script**

Run `./ops/smoke-thinking.sh --run` and require both provider-owned thinking assertions to pass.

