#!/usr/bin/env node
// One command to run your own copy of the tracker: checks Node, installs what is missing, starts it,
// and opens the browser once it answers. Written in plain CommonJS on purpose: it has to run (and
// explain itself) on a Node that is too old for the tracker, before anything is installed.
//
//   ./start.sh            (Mac / Linux)        start.cmd   (Windows)       npm run launch
//   --check      look at Node and the install, change nothing, start nothing
//   --no-open    don't open the browser (also: DELTA_NO_OPEN=1)

"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const WIN = process.platform === "win32";

/** "22.18" or ">=22.18.0" or "v24.9.0" -> [22, 18, 0]. Anything unreadable gives null. */
function parseVersion(text) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** True when `have` is at least `need` (both "major.minor.patch" text). */
function atLeast(have, need) {
  const a = parseVersion(have);
  const b = parseVersion(need);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/** The Node version the project asks for, read from package.json so it is written down in one place. */
function requiredNode() {
  try { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).engines.node; } catch { return ">=22.18"; }
}

/** node_modules is missing, or package-lock.json has changed since the last install (for example after `git pull`). */
function needsInstall() {
  const installed = path.join(root, "node_modules", ".package-lock.json");
  try { return fs.statSync(path.join(root, "package-lock.json")).mtimeMs > fs.statSync(installed).mtimeMs; } catch { return true; }
}

function say(text = "") { console.log(text); }
function fail(lines) { console.error(["", ...lines, ""].join("\n")); process.exit(1); }

/** Resolves with the parsed /api/health reply, or null when nothing answers there. */
function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(body) }); } catch { resolve({ status: res.statusCode, body: null }); } });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

/** Is something listening on the port at all (it may not be the tracker)? */
function listening(port) {
  return new Promise((resolve) => {
    const net = require("node:net");
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
}

function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : WIN ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch { /* the address is printed anyway */ }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const need = requiredNode();

  if (!atLeast(process.versions.node, need)) {
    fail([
      `This needs Node ${need.replace(/^>=/, "")} or newer, and you have ${process.versions.node}.`,
      "Install the current LTS version from https://nodejs.org, then open a new terminal window and run this again.",
    ]);
  }

  const port = Number(process.env.TRACKER_PORT) || 3001;
  const url = `http://localhost:${port}`;
  const wantOpen = !args.has("--no-open") && !process.env.DELTA_NO_OPEN;

  if (args.has("--check")) {
    say(`Node ${process.versions.node}: fine (needs ${need}).`);
    say(needsInstall() ? "Packages: not installed yet (the first run will install them)." : "Packages: installed.");
    say(`Address: ${url}`);
    return;
  }

  // already running (a second double-click)? Just open it rather than fighting over the port.
  const already = await health(port);
  if (already?.status === 200 && already.body?.ok === true) {
    say(`The tracker is already running at ${url}.`);
    if (wantOpen) openBrowser(url);
    return;
  }
  if (await listening(port)) {
    fail([
      `Something else is already using port ${port}, and it isn't the tracker.`,
      `Use a different port:  TRACKER_PORT=3010 ./start.sh   (Windows: set TRACKER_PORT=3010 first)`,
    ]);
  }

  if (needsInstall()) {
    say("Installing what the tracker needs (first run only, about a minute)...");
    const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit", shell: WIN });
    if (r.status !== 0) {
      fail([
        "The install didn't finish, so the tracker can't start.",
        "Check your internet connection and run this again. If it keeps failing, copy the message above when you ask for help.",
      ]);
    }
  }

  say("Starting the tracker...");
  const child = spawn(process.execPath, ["src/main.ts"], { cwd: root, stdio: "inherit" });
  const stop = () => child.kill("SIGINT");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let exited = false;
  child.on("exit", (code, signal) => { exited = true; process.exit(code ?? (signal ? 0 : 1)); });

  // open the browser once it answers (not before: an empty "can't connect" page is a bad first impression)
  for (let i = 0; i < 60 && !exited; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const up = await health(port);
    if (up?.status === 200 && up.body?.ok === true) {
      say("");
      say(`  Delta is running at ${url}`);
      say("  First time? Choose \"Create account\" (the account stays on this computer).");
      say("  Leave this window open while you use it. Press Ctrl+C to stop.");
      say("");
      if (wantOpen) openBrowser(url);
      return;
    }
  }
}

if (require.main === module) main().catch((e) => fail([`Couldn't start: ${e?.message ?? e}`]));

module.exports = { parseVersion, atLeast };
