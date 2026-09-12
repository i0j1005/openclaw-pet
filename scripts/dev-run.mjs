// Runs the app for N seconds with debug logging (used for smoke tests):
//   node scripts/dev-run.mjs 20 [--screenshot /tmp/pet.png]
import { spawn, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const electron = require("electron"); // resolves to the binary path
const seconds = Number(process.argv[2] ?? "15");
const shotIdx = process.argv.indexOf("--screenshot");
const shot = shotIdx > 0 ? process.argv[shotIdx + 1] : null;
const capIdx = process.argv.indexOf("--capture");
const capture = capIdx > 0 ? process.argv[capIdx + 1] : null;

const child = spawn(electron, [root], {
  cwd: root,
  env: { ...process.env, OPENCLAW_PET_DEBUG: "1", ...(capture ? { OPENCLAW_PET_CAPTURE: capture } : {}) },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => process.stdout.write(d));
child.stderr.on("data", (d) => process.stdout.write(d));

if (shot && process.platform === "darwin") {
  setTimeout(() => {
    try {
      execFileSync("screencapture", ["-x", shot]);
      console.log(`[dev-run] screenshot saved to ${shot}`);
    } catch (err) {
      console.log(`[dev-run] screenshot failed: ${err.message}`);
    }
  }, Math.min(seconds * 1000 - 2000, 9000));
}

// Memory sample shortly before shutdown (macOS/Linux only).
if (process.platform !== "win32") {
  setTimeout(() => {
    try {
      // Only this project's Electron binary (avoids counting other Electron apps on the machine).
      const out = execFileSync("sh", ["-c", `ps -axo rss=,command= | grep "node_modules/electron/dist" | grep -v grep`]).toString();
      let total = 0;
      for (const line of out.trim().split("\n")) {
        const kb = Number(line.trim().split(/\s+/)[0]);
        if (Number.isFinite(kb)) total += kb;
      }
      console.log(`[dev-run] resident memory across Electron processes: ${(total / 1024).toFixed(0)} MB`);
    } catch (err) {
      console.log(`[dev-run] memory sample failed: ${err.message}`);
    }
  }, Math.max(1000, seconds * 1000 - 2500));
}

setTimeout(() => {
  console.log(`[dev-run] stopping after ${seconds}s`);
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 3000);
}, seconds * 1000);

child.on("exit", (code) => {
  console.log(`[dev-run] electron exited with ${code}`);
  process.exit(0);
});
