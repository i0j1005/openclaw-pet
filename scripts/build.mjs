// Bundles the Electron main process, preload script and both renderers with esbuild.
// Everything (including `ws` and `json5`) is bundled, so the packaged app ships no node_modules.
import { build, context } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const appOnly = process.argv.includes("--app-only");
const production = process.argv.includes("--production");
const out = join(root, "dist");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

/** @type {import("esbuild").BuildOptions[]} */
const appTargets = [
  {
    entryPoints: [join(root, "src/main/index.ts")],
    outfile: join(out, "main/index.js"),
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron", "bufferutil", "utf-8-validate"],
  },
  {
    entryPoints: [join(root, "src/preload/index.ts")],
    outfile: join(out, "preload/index.js"),
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
  },
  {
    entryPoints: [join(root, "src/renderer/pet/pet.ts")],
    outfile: join(out, "renderer/pet/pet.js"),
    platform: "browser",
    format: "iife",
    target: "chrome130",
  },
  {
    entryPoints: [join(root, "src/renderer/settings/settings.ts")],
    outfile: join(out, "renderer/settings/settings.js"),
    platform: "browser",
    format: "iife",
    target: "chrome130",
  },
];

/** Test and diagnostic bundles are useful locally but never belong in the packaged application. */
const supportTargets = [
  {
    // `npm run probe`: connects like the app does and prints diagnostics (no chat.send).
    entryPoints: [join(root, "src/tools/probe.ts")],
    outfile: join(out, "tools/probe.js"),
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["bufferutil", "utf-8-validate"],
  },
  {
    // ESM copies of pure modules for `node --test`.
    entryPoints: [
      join(root, "src/main/openclaw/controller.ts"),
      join(root, "src/main/openclaw/reactions.ts"),
      join(root, "src/main/openclaw/discovery.ts"),
      join(root, "src/main/openclaw/device-identity.ts"),
    ],
    outdir: join(out, "tests"),
    platform: "node",
    format: "esm",
    target: "node22",
    // Let Node load the CommonJS packages directly. Bundling `ws` into an ESM test output leaves
    // dynamic built-in requires that cannot run inside an ES module.
    external: ["ws", "json5", "bufferutil", "utf-8-validate"],
  },
  {
    // Separate target: a different source folder would otherwise change the shared outbase.
    entryPoints: [join(root, "src/main/settings-store.ts")],
    outfile: join(out, "tests/settings-store.js"),
    platform: "node",
    format: "esm",
    target: "node22",
  },
  {
    entryPoints: [join(root, "src/main/characters.ts")],
    outfile: join(out, "tests/characters.js"),
    platform: "node",
    format: "esm",
    target: "node22",
  },
  {
    entryPoints: [join(root, "src/main/position.ts")],
    outfile: join(out, "tests/position.js"),
    platform: "node",
    format: "esm",
    target: "node22",
  },
];

const targets = appOnly ? appTargets : [...appTargets, ...supportTargets];

function copyStatic() {
  for (const page of ["pet", "settings"]) {
    mkdirSync(join(out, "renderer", page), { recursive: true });
    cpSync(join(root, "src/renderer", page, "index.html"), join(out, "renderer", page, "index.html"));
    cpSync(join(root, "src/renderer", page, `${page}.css`), join(out, "renderer", page, `${page}.css`));
  }
  cpSync(join(root, "src/renderer/shared.css"), join(out, "renderer/shared.css"));
}

const common = {
  bundle: true,
  sourcemap: production ? false : true,
  logLevel: "info",
  minify: production,
  legalComments: production ? "none" : "eof",
};

if (watch) {
  copyStatic();
  const ctxs = await Promise.all(targets.map((t) => context({ ...common, ...t })));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("watching…");
} else {
  await Promise.all(targets.map((t) => build({ ...common, ...t })));
  copyStatic();
  console.log("build complete");
}
