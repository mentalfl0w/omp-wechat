/**
 * Pi-host simulation test — loads the built dist artifact the way
 * @earendil-works/pi-coding-agent's extension loader does (jiti + alias
 * table), WITHOUT a Bun runtime.
 *
 * The artifact is copied into an ISOLATED temp directory so that
 * `import("@oh-my-pi/pi-coding-agent")` fails exactly as it does under
 * Pi (whose alias table has no @oh-my-pi/* entry), forcing the
 * @earendil-works fallback path. This reproduces the reported bug's
 * load environment faithfully.
 *
 * Checks:
 *   A. Extension loads, factory runs, /wechat registers, /wechat status
 *      works — fake HOME with NO credentials so the poll loop
 *      short-circuits at "not logged in" (no network, no hang), then
 *      session_shutdown clears its background work.
 *   B. Port-lock arbitration via the same lock helper the bridge uses:
 *      first holder wins an isolated ephemeral port, second attempt rejects.
 *
 * Run: node scripts/test-pi-load.mjs
 */
import { createJiti } from "jiti/static";
import { tmpdir, homedir } from "node:os";
import { createServer as createNetServer } from "node:net";
import { join, dirname } from "node:path";
import { mkdtempSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

/** Find a free loopback port without ever binding the user's live 19821. */
async function freeLoopbackPort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  return port;
}

// If a background handle survives the test, fail instead of hanging forever.
const watchdog = setTimeout(() => {
  console.error("FAIL: event loop still has work after teardown (issue #6 regression)");
  process.exit(1);
}, 30_000);
watchdog.unref();

const LOCK_PORT = await freeLoopbackPort();
process.env.OMP_WECHAT_LOCK_PORT = String(LOCK_PORT);

// ── Isolate BOTH the module-load dir and HOME ──
const simDir = mkdtempSync(join(tmpdir(), "pi-sim-"));
mkdirSync(join(simDir, "ext"), { recursive: true });
mkdirSync(join(simDir, "home", ".omp-wechat"), { recursive: true });
// Copy the artifact OUT of the repo so no node_modules is reachable by
// walking up — @oh-my-pi/* must genuinely fail to resolve here.
cpSync(join(repoRoot, "dist", "index.js"), join(simDir, "ext", "index.js"));
// NO credentials.json → getCredentials() throws → start() returns
// running:false without starting the poll loop. Command surface still
// registers, which is exactly the load-time contract.
process.env.HOME = join(simDir, "home");
if (homedir() !== process.env.HOME) {
  throw new Error(`FAIL: HOME isolation failed (homedir=${homedir()}); refusing to touch real credentials`);
}

// ── Replicate Pi's jiti alias table (loader.ts getAliases) ──
// @oh-my-pi/* deliberately ABSENT — exactly Pi's table. Only the specifier
// the built artifact actually imports is needed.
const aliases = {
  // @oh-my-pi/pi-coding-agent declares main: ./src/index.ts (no exports map),
  // so resolve the entry file by path — jiti loads TS fine.
  "@earendil-works/pi-coding-agent": join(
    repoRoot,
    "node_modules",
    "@oh-my-pi",
    "pi-coding-agent",
    "src",
    "index.ts",
  ),
};

const jiti = createJiti(import.meta.url, { moduleCache: false, alias: aliases });

// ── A. Load the built artifact and drive the extension surface ──
const mod = await jiti.import(join(simDir, "ext", "index.js"), { default: true });
const factory = mod.default ?? mod;
if (typeof factory !== "function") {
  throw new Error(`FAIL: dist export is not a factory function (${typeof factory})`);
}
console.log("PASS: dist/index.js loaded via jiti (isolated, @oh-my-pi unresolvable)");

const commands = new Map();
const handlers = new Map();
const api = {
  pi: undefined, // Pi does not inject self-ref
  on: (event, handler) => handlers.set(event, handler),
  registerCommand: (name, def) => commands.set(name, def),
  setLabel: undefined,
};
await factory(api);
if (!commands.has("wechat")) {
  throw new Error("FAIL: /wechat command not registered");
}
console.log("PASS: /wechat command registered");

// /wechat status must work without credentials or a running loop
const statusCtx = {
  ui: { notify: () => {} },
  cwd: repoRoot,
};
await commands.get("wechat").handler("status", statusCtx);
console.log("PASS: /wechat status handler ran");

// The host emits session_shutdown for short-lived commands; the extension
// must clear its standby retry timer so the host can exit.
const onShutdown = handlers.get("session_shutdown");
if (typeof onShutdown !== "function") {
  throw new Error("FAIL: extension did not register session_shutdown");
}
await onShutdown({ type: "session_shutdown" }, { ui: { notify: () => {} } });
console.log("PASS: session_shutdown cleared extension background work");

// ── B. Port-lock arbitration (same helper the bridge uses) ──
const { listenPort } = await jiti.import(
  join(repoRoot, "src", "utils", "runtime-compat.ts"),
  { default: false },
);
const first = await listenPort(LOCK_PORT);
console.log(`PASS: first lock holder bound isolated port ${LOCK_PORT}`);
let secondRejected = false;
try {
  const second = await listenPort(LOCK_PORT);
  second.stop();
} catch {
  secondRejected = true;
}
if (!secondRejected) throw new Error("FAIL: port contention not detected");
console.log("PASS: second lock attempt rejected (contention detected)");
first.stop();

// ── C. No Bun global required anywhere ──
if (typeof globalThis.Bun !== "undefined") {
  console.log("WARN: Bun global is defined in this Node process");
} else {
  console.log("PASS: ran entirely without a Bun global");
}

// Cleanup
rmSync(simDir, { recursive: true, force: true });
console.log("\nALL TESTS PASSED");
// On success the script never calls process.exit(): a short-lived host command
// must be able to exit once its own work is done. Extension timers are unref'd
// (and cleared on session_shutdown); the unref'd watchdog above only fires if
// a lingering handle keeps the loop alive, i.e. issue #6 regressed.
