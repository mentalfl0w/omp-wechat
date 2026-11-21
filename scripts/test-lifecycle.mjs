/**
 * Lifecycle regression test for GitHub issue #6:
 * `omp models --json` printed its output but never exited because extension
 * background resources (standby retry timer, in-flight long poll, lock
 * listener, cleanup timer) outlived the host command.
 *
 * Runs the real WeChatBridge against a mock iLink server, with an isolated
 * HOME and an ephemeral singleton-lock port (OMP_WECHAT_LOCK_PORT) so the
 * user's live service — its port lock and credentials — is never touched.
 * Verifies:
 *   A. Lock-held standby: start() reports not running and stop() is a no-op.
 *   B. Active owner: stop() aborts the in-flight long poll promptly and
 *      releases the singleton port.
 *   C. start()/stop() serialization: an immediate stop during start leaves no
 *      lock behind, and a restart after stop works (takeover preserved).
 *   D. Abortable backoff sleep settles immediately instead of waiting 30s.
 *   E. Extension factory: a standby load does not poll and shutdown keeps
 *      another process's lock; an active load stops promptly on
 *      session_shutdown and releases the lock.
 *
 * The script intentionally does NOT call process.exit() on success: if a
 * timer/fetch/listener still holds the event loop, the unref'd watchdog
 * fires and the test fails — that is exactly the regression this guards.
 *
 * Run: node scripts/test-lifecycle.mjs
 */
import { createJiti } from "jiti/static";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

/** Bind a free loopback port and keep holding it (async server close is fine). */
async function reserveLoopbackPort(port = 0) {
  const server = createNetServer((socket) => socket.end("ok"));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

const watchdog = setTimeout(() => {
  console.error("FAIL: event loop still has work after teardown (issue #6 regression)");
  process.exit(1);
}, 20_000);
watchdog.unref();

const simHome = mkdtempSync(join(tmpdir(), "omp-wechat-lifecycle-"));
process.env.HOME = simHome;
if (homedir() !== simHome) {
  throw new Error(`FAIL: HOME isolation failed (homedir=${homedir()}); refusing to touch real credentials`);
}
mkdirSync(join(simHome, ".omp-wechat"), { recursive: true });

// Hold a free port as this test's external lock holder, and point the bridge
// at it before importing the module that reads the override.
const lockHolder = await reserveLoopbackPort();
const LOCK_PORT = lockHolder.address().port;
process.env.OMP_WECHAT_LOCK_PORT = String(LOCK_PORT);

function assert(cond, message) {
  if (!cond) throw new Error(`FAIL: ${message}`);
}

/** Hold getupdates requests open to simulate a live long poll. */
const heldResponses = new Set();
let getUpdatesSeen = 0;
const mock = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    if (req.url?.includes("getupdates")) {
      getUpdatesSeen += 1;
      heldResponses.add(res);
      res.on("close", () => heldResponses.delete(res));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ret: 0 }));
  });
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const mockPort = mock.address().port;

writeFileSync(
  join(simHome, ".omp-wechat", "credentials.json"),
  JSON.stringify({ token: "test-token", baseUrl: `http://127.0.0.1:${mockPort}/` }),
);

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { WeChatBridge } = await jiti.import(join(repoRoot, "src", "bridge.ts"));
const { listenPort, sleep } = await jiti.import(
  join(repoRoot, "src", "utils", "runtime-compat.ts"),
);

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`FAIL: timeout — ${message}`);
}

// ── A. Standby while another process holds the singleton lock ──
const standbyBridge = new WeChatBridge();
const standby = await standbyBridge.start();
assert(!standby.running, "standby start() must report not running");
assert(
  standby.lastError === "another instance running",
  `standby lastError should name the lock holder (got ${standby.lastError})`,
);
await standbyBridge.stop();
// The standby bridge must not release someone else's lock.
let stillHeld = true;
try {
  (await listenPort(LOCK_PORT)).stop();
  stillHeld = false;
} catch {
  // expected: this test's holder still owns the reserved port
}
assert(stillHeld, "standby stop() must not release the external lock holder");
await closeServer(lockHolder);
console.log("PASS: standby start/stop leaves the external lock intact");

// ── B. Active owner: stop aborts the in-flight long poll, releases lock ──
const bridge = new WeChatBridge();
const running = await bridge.start();
assert(running.running, "start() must acquire the free lock");
await waitFor(() => getUpdatesSeen > 0, 3_000, "bridge never issued a getupdates long poll");

const stopStartedAt = Date.now();
await bridge.stop(2_000);
const stopElapsed = Date.now() - stopStartedAt;
assert(stopElapsed < 1_500, `stop() took ${stopElapsed}ms — long poll/backoff was not aborted`);

const probe = await listenPort(LOCK_PORT);
probe.stop();
console.log(`PASS: active stop() released the lock and aborted the poll in ${stopElapsed}ms`);

// stop() is idempotent and must stay fast.
await bridge.stop(2_000);

// ── C. start()/stop() serialization + restart/takeover ──
const raceBridge = new WeChatBridge();
const [raceState] = await Promise.all([raceBridge.start(), raceBridge.stop()]);
assert(
  !raceState.running,
  "a start() racing stop() must not report a running bridge",
);
const freeAfterRace = await listenPort(LOCK_PORT);
freeAfterRace.stop();
console.log("PASS: start()/stop() race released the lock");

const stopInFlight = raceBridge.stop(1_000);
const duringStop = await raceBridge.start();
await stopInFlight;
assert(
  !duringStop.running,
  "a start() issued during shutdown must not resurrect the bridge",
);
const restarted = await raceBridge.start();
assert(restarted.running, "restart after stop has settled must re-acquire the lock");
await raceBridge.stop(1_000);
console.log("PASS: start during shutdown is refused; restart after stop works");

// ── D. Backoff sleep aborts promptly ──
const controller = new AbortController();
setTimeout(() => controller.abort(), 25);
const sleepStartedAt = Date.now();
let sleepAborted = false;
try {
  await sleep(30_000, controller.signal);
} catch (err) {
  sleepAborted = err instanceof Error && err.name === "AbortError";
}
const sleepElapsed = Date.now() - sleepStartedAt;
assert(sleepAborted, "abortable sleep must reject with AbortError");
assert(sleepElapsed < 1_000, `abortable sleep waited ${sleepElapsed}ms`);
console.log(`PASS: 30s backoff sleep aborted in ${sleepElapsed}ms`);

// ── E. Extension factory lifecycle (the `omp models --json` shape) ──
// A standby load (lock held) must not poll and must leave the holder's lock
// alone on session_shutdown; an active load must stop its poll and release
// the lock within the host's 2s shutdown budget.
const factoryModule = await jiti.import(join(repoRoot, "src", "index.ts"), { default: true });
const factory = factoryModule.default ?? factoryModule;
assert(typeof factory === "function", "index.ts must export the extension factory");

function makeHost() {
  const handlers = new Map();
  const commands = new Map();
  return {
    handlers,
    commands,
    api: {
      on: (event, handler) => handlers.set(event, handler),
      registerCommand: (name, def) => commands.set(name, def),
      setLabel: () => {},
    },
  };
}

const standbyHost = makeHost();
const holder = await reserveLoopbackPort(LOCK_PORT);
const pollsBeforeStandby = getUpdatesSeen;
await factory(standbyHost.api);
assert(standbyHost.commands.has("wechat"), "extension must register the /wechat command");
await sleep(100);
assert(
  getUpdatesSeen === pollsBeforeStandby,
  "standby extension must not start a long poll while the lock is held",
);
const standbyShutdown = standbyHost.handlers.get("session_shutdown");
assert(typeof standbyShutdown === "function", "extension must register a session_shutdown handler");
await standbyShutdown({ type: "session_shutdown" }, { ui: { notify: () => {} } });
let lockStillHeld = true;
try {
  (await listenPort(LOCK_PORT)).stop();
  lockStillHeld = false;
} catch {
  // expected: shutdown must not release another process's lock
}
assert(lockStillHeld, "standby extension shutdown must not release the external lock");
await closeServer(holder);
console.log("PASS: standby extension does not poll; shutdown leaves the external lock intact");

const activeHost = makeHost();
await factory(activeHost.api);
await waitFor(
  () => getUpdatesSeen > pollsBeforeStandby,
  3_000,
  "extension never started its long poll",
);
const activeShutdown = activeHost.handlers.get("session_shutdown");
assert(typeof activeShutdown === "function", "active extension must register session_shutdown");
const shutdownStartedAt = Date.now();
await activeShutdown({ type: "session_shutdown" }, { ui: { notify: () => {} } });
const shutdownElapsed = Date.now() - shutdownStartedAt;
assert(shutdownElapsed < 1_500, `extension shutdown took ${shutdownElapsed}ms`);
const released = await listenPort(LOCK_PORT);
released.stop();
console.log(`PASS: active extension shutdown released the lock in ${shutdownElapsed}ms`);

// ── Teardown ──
for (const res of heldResponses) res.destroy();
heldResponses.clear();
mock.closeAllConnections();
await new Promise((resolve) => mock.close(resolve));
rmSync(simHome, { recursive: true, force: true });
// The watchdog is left armed (and unref'd): it cannot delay a clean exit,
// but it fails the run if any handle above failed to release the loop.
console.log("\nALL LIFECYCLE TESTS PASSED (event loop drained without process.exit)");
