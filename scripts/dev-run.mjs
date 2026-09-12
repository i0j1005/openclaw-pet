// Runs the app for N seconds with debug logging (used for smoke tests):
//   node scripts/dev-run.mjs 20 [--screenshot /tmp/pet.png] [--capture /tmp/dir] [--shots 6] [--send "message"]
//                                 [--send-dry "message"] [--collapse-at 3]
// --capture writes pet.png + settings.png after 5 s; --shots N keeps capturing pet-1.png … pet-N.png every 3 s.
// --send submits ONE real quick-chat message through the pet window (this starts an agent turn in the
// owner's most recent OpenClaw session and costs tokens: use it deliberately, never in a loop).
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
const shotsIdx = process.argv.indexOf("--shots");
const shots = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
const sendIdx = process.argv.indexOf("--send");
const send = sendIdx > 0 ? process.argv[sendIdx + 1] : null;
// --send-dry "msg": same as --send but chat.send is replaced by a local fake reply (no tokens, no network).
const dryIdx = process.argv.indexOf("--send-dry");
const sendDry = dryIdx > 0 ? process.argv[dryIdx + 1] : null;
// --collapse-at N: click the bubble right before pet-N.png so the collapsed pill gets captured.
const collapseIdx = process.argv.indexOf("--collapse-at");
const collapseAt = collapseIdx > 0 ? process.argv[collapseIdx + 1] : null;
// --eval "js" / --eval-end "js": run JS in the pet page before the first / after the last capture (result is logged).
const evalIdx = process.argv.indexOf("--eval");
const evalJs = evalIdx > 0 ? process.argv[evalIdx + 1] : null;
const evalEndIdx = process.argv.indexOf("--eval-end");
const evalEndJs = evalEndIdx > 0 ? process.argv[evalEndIdx + 1] : null;

// A leftover instance from an interrupted run would hold the single-instance lock and make this run exit
// immediately, so stop any Electron main process that was started from this project first.
if (process.platform !== "win32") {
  try {
    const out = execFileSync("pgrep", ["-f", `${root}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`]).toString();
    for (const pid of out.split("\n").map((l) => Number(l.trim())).filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid)) {
      try {
        process.kill(pid, "SIGKILL");
        console.log(`[dev-run] stopped leftover Electron process ${pid}`);
      } catch {}
    }
  } catch {}
}

const child = spawn(electron, [root], {
  cwd: root,
  env: {
    ...process.env,
    OPENCLAW_PET_DEBUG: "1",
    ...(capture ? { OPENCLAW_PET_CAPTURE: capture } : {}),
    ...(shots ? { OPENCLAW_PET_CAPTURE_SHOTS: shots } : {}),
    ...(send ? { OPENCLAW_PET_TEST_MESSAGE: send } : {}),
    ...(sendDry ? { OPENCLAW_PET_TEST_MESSAGE: sendDry, OPENCLAW_PET_TEST_DRY: "1" } : {}),
    ...(collapseAt ? { OPENCLAW_PET_CAPTURE_COLLAPSE_AT: collapseAt } : {}),
    ...(evalJs ? { OPENCLAW_PET_CAPTURE_EVAL: evalJs } : {}),
    ...(evalEndJs ? { OPENCLAW_PET_CAPTURE_EVAL_END: evalEndJs } : {}),
    ...(process.argv.includes("--payloads") ? { OPENCLAW_PET_DEBUG_PAYLOADS: "1" } : {}),
  },
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
