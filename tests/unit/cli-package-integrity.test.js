import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const helper = require("../../cli/scripts/cli-package-integrity.js");

describe("cli-package-integrity", () => {
  it("expands tracing root to cover externally-symlinked node_modules", () => {
    const projectRoot = "/home/ubuntu/.config/superpowers/worktrees/9router/fix-stream-observability-false-success";
    // Representative real module path from a worktree whose packages symlink into the main checkout.
    const nodeModulesRoot = "/home/ubuntu/9router/node_modules";
    const root = helper.computeTracingRoot({
      projectRoot,
      nodeModulesRoot,
      mode: "workspace",
    });
    expect(root).toBe("/home/ubuntu");
  });

  it("keeps workspace parent when deps already live under it", () => {
    const projectRoot = "/home/ubuntu/9router";
    const nodeModulesRoot = "/home/ubuntu/9router/node_modules";
    const root = helper.computeTracingRoot({
      projectRoot,
      nodeModulesRoot,
      mode: "workspace",
    });
    expect(root).toBe("/home/ubuntu");
  });

  it("uses project root when workspace mode is disabled", () => {
    const projectRoot = "/tmp/proj";
    const root = helper.computeTracingRoot({
      projectRoot,
      nodeModulesRoot: "/tmp/other/node_modules",
      mode: "project",
    });
    expect(root).toBe(path.resolve(projectRoot));
  });

  it("honors explicit env override", () => {
    const root = helper.computeTracingRoot({
      projectRoot: "/tmp/proj",
      nodeModulesRoot: "/tmp/other/node_modules",
      mode: "workspace",
      envTracingRoot: "/custom/root",
    });
    expect(root).toBe(path.resolve("/custom/root"));
  });

  it("detects incomplete standalone packages missing react runtime modules", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cli-integrity-"));
    try {
      const nm = path.join(tempDir, "node_modules");
      fs.mkdirSync(path.join(nm, "next"), { recursive: true });
      fs.writeFileSync(path.join(nm, "next", "package.json"), "{}");
      const missing = helper.listMissingStandaloneModules(tempDir);
      expect(missing).toEqual(expect.arrayContaining(["react", "react-dom", "@swc/helpers"]));
      expect(missing).not.toContain("next");
      expect(() => helper.assertStandaloneRuntimeModules(tempDir)).toThrow(/missing required standalone runtime modules/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts a complete standalone package", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cli-integrity-ok-"));
    try {
      for (const name of helper.REQUIRED_STANDALONE_MODULES) {
        const dir = path.join(tempDir, "node_modules", ...name.split("/"));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "package.json"), "{}");
      }
      expect(helper.listMissingStandaloneModules(tempDir)).toEqual([]);
      expect(helper.assertStandaloneRuntimeModules(tempDir)).toEqual({ ok: true, missing: [] });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves node_modules root via next package when entries are external symlinks", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cli-nm-root-"));
    try {
      const external = path.join(tempDir, "external", "node_modules", "next");
      fs.mkdirSync(external, { recursive: true });
      fs.writeFileSync(path.join(external, "package.json"), '{"name":"next"}');
      const project = path.join(tempDir, "project");
      fs.mkdirSync(path.join(project, "node_modules"), { recursive: true });
      fs.symlinkSync(external, path.join(project, "node_modules", "next"));
      const requireResolve = (request, opts) => {
        if (request === "next/package.json") {
          return path.join(external, "package.json");
        }
        return require.resolve(request, opts);
      };
      const nmRoot = helper.resolveNodeModulesRoot(project, requireResolve);
      expect(nmRoot).toBe(path.dirname(external));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("prefers densest traced node_modules over sparse package-symlink trees", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-traced-nm-"));
    try {
      const sparse = path.join(tempDir, ".config", "proj", "node_modules");
      fs.mkdirSync(sparse, { recursive: true });
      fs.symlinkSync("/tmp/outside-next", path.join(sparse, "next"));
      const dense = path.join(tempDir, "9router", "node_modules");
      for (const name of helper.REQUIRED_STANDALONE_MODULES) {
        const dir = path.join(dense, ...name.split("/"));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "package.json"), "{}");
      }
      const found = helper.findBestTracedNodeModules(tempDir);
      expect(found).toBe(dense);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
