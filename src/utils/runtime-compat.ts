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

/** Runtime-agnostic sleep — Bun.sleep under Bun, setTimeout under Node. */
export function sleep(ms: number): Promise<void> {
  if (isBun()) {
    return (globalThis.Bun as unknown as { sleep(ms: number): Promise<void> }).sleep(ms);
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
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
