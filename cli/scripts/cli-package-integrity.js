"use strict";

const fs = require("fs");
const path = require("path");

/** Runtime modules that a packaged Next standalone server must be able to require. */
const REQUIRED_STANDALONE_MODULES = Object.freeze([
  "next",
  "react",
  "react-dom",
  "@swc/helpers",
]);

/**
 * Longest common absolute path prefix for two filesystem paths.
 * Used to choose an outputFileTracingRoot that still contains external/symlinked deps.
 */
function commonPathRoot(a, b) {
  const left = path.resolve(String(a || ""));
  const right = path.resolve(String(b || ""));
  if (!left || !right) return path.resolve(".");
  if (process.platform === "win32") {
    if (left.slice(0, 2).toLowerCase() !== right.slice(0, 2).toLowerCase()) {
      return path.parse(left).root || left;
    }
  }
  const leftParts = left.split(path.sep).filter(Boolean);
  const rightParts = right.split(path.sep).filter(Boolean);
  const shared = [];
  const n = Math.min(leftParts.length, rightParts.length);
  for (let i = 0; i < n; i++) {
    const lp = process.platform === "win32" ? leftParts[i].toLowerCase() : leftParts[i];
    const rp = process.platform === "win32" ? rightParts[i].toLowerCase() : rightParts[i];
    if (lp !== rp) break;
    shared.push(leftParts[i]);
  }
  if (shared.length === 0) {
    return process.platform === "win32" ? path.parse(left).root || left : path.sep;
  }
  return process.platform === "win32"
    ? path.resolve(shared[0] + path.sep + shared.slice(1).join(path.sep))
    : path.sep + shared.join(path.sep);
}

/**
 * Resolve the real node_modules directory that Node uses for this project.
 * Prefer the realpath of project/node_modules; fall back to the package that
 * owns `next` so worktrees with per-package symlinks still expand the root.
 */
function resolveNodeModulesRoot(projectRoot, requireResolve = require.resolve) {
  const project = path.resolve(projectRoot);
  const localNm = path.join(project, "node_modules");
  try {
    const nextPkg = requireResolve("next/package.json", { paths: [project] });
    // .../node_modules/next/package.json → node_modules. Resolving a package
    // first also follows per-package symlinks in lightweight worktrees.
    return path.dirname(path.dirname(fs.realpathSync(nextPkg)));
  } catch {
    if (fs.existsSync(localNm)) {
      try {
        return fs.realpathSync(localNm);
      } catch {
        // fall through
      }
    }
    return localNm;
  }
}

/**
 * Choose outputFileTracingRoot so Next file tracing can see real dependency files.
 *
 * For a normal checkout, this is usually the project parent (workspace mode).
 * For a worktree whose node_modules entries symlink into another checkout, it
 * expands to the common ancestor of the project and the real node_modules root.
 */
function computeTracingRoot({
  projectRoot,
  nodeModulesRoot,
  mode = "workspace",
  envTracingRoot,
} = {}) {
  if (envTracingRoot && String(envTracingRoot).trim()) {
    return path.resolve(String(envTracingRoot).trim());
  }
  const project = path.resolve(projectRoot || ".");
  if (mode !== "workspace") return project;
  const workspaceParent = path.resolve(project, "..");
  if (!nodeModulesRoot) return workspaceParent;
  let realNm = nodeModulesRoot;
  try {
    if (fs.existsSync(nodeModulesRoot)) realNm = fs.realpathSync(nodeModulesRoot);
  } catch {
    // keep original
  }
  // Prefer the real path of a representative package (next) when node_modules
  // itself is a real directory full of external package symlinks.
  try {
    const nextInside = path.join(realNm, "next");
    if (fs.existsSync(nextInside)) {
      realNm = path.dirname(fs.realpathSync(nextInside));
    }
  } catch {
    // keep original
  }
  // Workspace mode historically traces from the project parent. Expand only
  // as far as needed to also contain the real dependency directory.
  return commonPathRoot(workspaceParent, realNm);
}

function modulePathInBundle(bundleAppDir, moduleName) {
  return path.join(path.resolve(bundleAppDir), "node_modules", ...String(moduleName).split("/"));
}

function listMissingStandaloneModules(bundleAppDir, required = REQUIRED_STANDALONE_MODULES) {
  const missing = [];
  for (const name of required) {
    if (!fs.existsSync(modulePathInBundle(bundleAppDir, name))) missing.push(name);
  }
  return missing;
}

/**
 * Hard-fail packaging when the standalone bundle cannot load critical runtime modules.
 * This catches the silent worktree packaging failure that previously produced a
 * process that printed the tray banner and never opened a listener.
 */
function assertStandaloneRuntimeModules(bundleAppDir, required = REQUIRED_STANDALONE_MODULES) {
  const missing = listMissingStandaloneModules(bundleAppDir, required);
  if (missing.length === 0) return { ok: true, missing: [] };
  const msg =
    "CLI package is missing required standalone runtime modules: " +
    missing.join(", ") +
    ". This usually means outputFileTracingRoot did not include the real node_modules " +
    "(common with worktree/symlink installs).";
  const err = new Error(msg);
  err.code = "CLI_PACKAGE_INCOMPLETE";
  err.missing = missing;
  throw err;
}

/**
 * Locate the densest traced node_modules tree under a Next standalone root.
 * Expanded tracing roots place the app under a deep relative path while the
 * actual traced packages land under a sibling path that mirrors the real
 * dependency checkout (e.g. standalone/9router/node_modules).
 */
function findBestTracedNodeModules(standaloneRoot, required = REQUIRED_STANDALONE_MODULES) {
  const root = path.resolve(standaloneRoot || "");
  if (!root || !fs.existsSync(root)) return null;
  let best = null;
  let bestScore = -1;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules") {
        const nm = path.join(current, entry.name);
        let score = 0;
        let fileHits = 0;
        for (const name of required) {
          const candidate = path.join(nm, ...String(name).split("/"));
          if (fs.existsSync(candidate)) score += 10;
        }
        // Prefer real package trees over directories that only contain external
        // package symlinks (common leftover from worktree package-link installs).
        try {
          for (const child of fs.readdirSync(nm, { withFileTypes: true })) {
            const childPath = path.join(nm, child.name);
            try {
              if (child.isSymbolicLink()) {
                // external symlink: low value
                score += 0;
              } else if (child.isDirectory()) {
                score += 1;
                // cheap file presence probe
                if (fs.existsSync(path.join(childPath, "package.json"))) fileHits += 1;
              }
            } catch {}
          }
        } catch {}
        score += Math.min(fileHits, 50);
        if (score > bestScore) {
          bestScore = score;
          best = nm;
        }
        // do not recurse into node_modules
        continue;
      }
      if (entry.name === ".next" || entry.name === ".next-cli-build") continue;
      stack.push(path.join(current, entry.name));
    }
  }
  return bestScore >= 10 ? best : null;
}

module.exports = {
  REQUIRED_STANDALONE_MODULES,
  commonPathRoot,
  resolveNodeModulesRoot,
  computeTracingRoot,
  modulePathInBundle,
  listMissingStandaloneModules,
  assertStandaloneRuntimeModules,
  findBestTracedNodeModules,
};
