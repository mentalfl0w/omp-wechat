/**
 * Cross-runtime compat layer — lets the same bundled artifact run under
 * both OMP (Bun binary) and Pi (Node.js via jiti).
 *
 * Deliberately does NOT shim `globalThis.Bun`: mutating the global would
 * confuse the host and other extensions that probe `typeof Bun` to detect
 * the runtime. Instead, each call site imports the narrow helper it needs,
 * and the helper branches on the actual runtime internally.
 */
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";

/** True when running under a Bun runtime (OMP binary, or bun CLI). */
export function isBun(): boolean {
  return typeof globalThis.Bun !== "undefined" && typeof globalThis.Bun.sleep === "function";
}

/** AbortError matching the rejection shape of `fetch` under Bun and Node. */
export function abortError(): Error {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

/**
 * Runtime-agnostic sleep — Bun.sleep under Bun, setTimeout under Node.
 * When `signal` aborts, the sleep settles immediately (rejects AbortError)
 * and its timer is cleared, so shutdown never waits out a 30s backoff.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    if (isBun()) {
      return (globalThis.Bun as unknown as { sleep(ms: number): Promise<void> }).sleep(ms);
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  }

  if (signal.aborted) return Promise.reject(abortError());
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let timer: Timer | undefined;
  const onAbort = () => {
    clearTimeout(timer);
    reject(abortError());
  };
  timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal.addEventListener("abort", onAbort, { once: true });
  return promise;
}

/**
 * Like setInterval, but the handle is `unref`'d. Extension background work
 * (standby failover, 6h cleanup) must never be the reason a short-lived host
 * command such as `omp models --json` cannot exit.
 */
export function setUnrefInterval(callback: () => void, ms: number): Timer {
  const timer = setInterval(callback, ms);
  timer.unref();
  return timer;
}

/** Result shape matching Bun.spawnSync's `{ exitCode, stdout, stderr }`. */
export interface SpawnSyncResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

export interface SpawnSyncOptions {
  cwd?: string;
  stdout?: "inherit" | "ignore" | "pipe";
  stderr?: "inherit" | "ignore" | "pipe";
}

/**
 * Runtime-agnostic synchronous subprocess spawn.
 * Bun.spawnSync(cmdArray, opts) ↔ node:child_process.spawnSync(cmd, args, opts).
 * Normalizes the result to Bun's `{ exitCode, stdout, stderr }` shape.
 */
export function spawnSync(cmd: string[], opts: SpawnSyncOptions = {}): SpawnSyncResult {
  if (isBun()) {
    const res = (globalThis.Bun as unknown as {
      spawnSync(
        cmd: string[],
        opts?: SpawnSyncOptions & { stderr?: string },
      ): { exitCode: number; stdout: Buffer | Uint8Array; stderr: Buffer | Uint8Array };
    }).spawnSync(cmd, opts as SpawnSyncOptions & { stderr?: string });
    return {
      exitCode: res.exitCode,
      stdout: Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(res.stdout ?? []),
      stderr: Buffer.isBuffer(res.stderr) ? res.stderr : Buffer.from(res.stderr ?? []),
    };
  }

  const [command, ...args] = cmd;
  const res = nodeSpawnSync(command, args, {
    cwd: opts.cwd,
    stdio: ["pipe", opts.stdout ?? "pipe", opts.stderr ?? "pipe"],
  });
  return {
    // status is null when spawn failed (error) or the process was killed by
    // a signal — callers treat non-zero as failure, so map both to 1.
    exitCode: res.status ?? (res.error || res.signal ? 1 : 0),
    stdout: res.stdout ?? Buffer.alloc(0),
    stderr: res.stderr ?? Buffer.alloc(0),
  };
}

export interface LockServer {
  stop(): void;
}

/**
 * Bind a singleton TCP listener on 127.0.0.1:port as a cross-process
 * mutex. Resolves on success, rejects if the port is already held —
 * matching Bun.serve's synchronous EADDRINUSE throw under Bun, and
 * node:net's async 'error' event under Node.
 */
export function listenPort(port: number): Promise<LockServer> {
  if (isBun()) {
    const server = (globalThis.Bun as unknown as {
      serve(opts: {
        port: number;
        hostname: string;
        fetch(): Response;
      }): { stop(closeActive?: boolean): void };
    }).serve({
      port,
      hostname: "127.0.0.1",
      fetch() {
        return new Response("ok");
      },
    });
    return Promise.resolve({ stop: () => server.stop(true) });
  }

  const { promise, resolve, reject } = Promise.withResolvers<LockServer>();
  const server = createNetServer((socket) => {
    socket.end("ok");
  });
  server.once("error", (err: NodeJS.ErrnoException) => {
    reject(err);
  });
  server.listen(port, "127.0.0.1", () => {
    resolve({
      stop: () => server.close(),
    });
  });
  return promise;
}
