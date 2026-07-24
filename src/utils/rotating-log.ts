/**
 * Rotating file logger — size-based rotation with retention cap.
 *
 * On each write, checks the current file size. When it exceeds
 * `maxBytes`, the file is renamed to `<name>.1.log` (bumping any
 * existing `.1` → `.2`, etc.) and a fresh file is started.
 * Files beyond `maxFiles` are deleted.
 *
 * A startup sweep removes files older than `maxAgeMs` regardless
 * of the rotation count — a safety net for long-running processes
 * that rarely hit the size threshold.
 *
 * All operations are synchronous (appendFileSync / renameSync) to
 * match the existing logger patterns in OMP plugins.  Rotation
 * overhead is negligible: one statSync per write, a rename chain
 * only when the threshold is crossed.
 */

import { appendFileSync, statSync, renameSync, unlinkSync, readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";

export interface RotatingLogOptions {
  /** Full path to the active log file. */
  filePath: string;
  /** Max file size before rotation (default 5 MB). */
  maxBytes?: number;
  /** Max number of rotated files to keep (default 3). */
  maxFiles?: number;
  /** Max age in ms for any log file; older files are deleted on startup (default 30 days). */
  maxAgeMs?: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_MAX_FILES = 3;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class RotatingLog {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly maxAgeMs: number;
  private readonly baseName: string;
  private readonly dir: string;
  private readonly activeFileName: string;

  constructor(opts: RotatingLogOptions) {
    this.filePath = opts.filePath;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

    this.dir = dirname(this.filePath);
    this.activeFileName = basename(this.filePath);
    this.baseName = basename(this.filePath, ".log");
  }

  /**
   * Append a line to the log file, rotating if needed.
   * The line MUST include a trailing newline — this method
   * does not add one, so the caller controls line formatting.
   * Never throws — logging is best-effort.
   */
  write(line: string): void {
    try {
      this.maybeRotate();
      appendFileSync(this.filePath, line, "utf-8");
    } catch {
      // Logging must never throw.
    }
  }

  /**
   * Remove log files older than `maxAgeMs`.
   * Call once at startup.
   */
  cleanStale(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    try {
      for (const name of readdirSync(this.dir)) {
        // Skip the active log file — only clean rotated files.
        if (name === this.activeFileName) continue;
        if (!name.startsWith(this.baseName) || !name.endsWith(".log")) continue;
        const fullPath = join(this.dir, name);
        try {
          const stat = statSync(fullPath);
          if (stat.mtimeMs < cutoff) unlinkSync(fullPath);
        } catch {
          // File may have been removed between readdir and stat.
        }
      }
    } catch {
      // dir may not exist yet.
    }
  }

  /** Check file size and rotate if the threshold is exceeded. */
  private maybeRotate(): void {
    let size: number;
    try {
      size = statSync(this.filePath).size;
    } catch {
      // File doesn't exist yet — no rotation needed.
      return;
    }

    if (size < this.maxBytes) return;

    // Step 1: Delete the oldest rotation if it exists.
    const oldest = this.rotatedPath(this.maxFiles);
    try { unlinkSync(oldest); } catch { /* may not exist */ }

    // Step 2: Shift existing rotations up (.2 → .3, .1 → .2, …).
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const src = this.rotatedPath(i);
      const dst = this.rotatedPath(i + 1);
      try { renameSync(src, dst); } catch { /* may not exist */ }
    }

    // Step 3: Current file → .1
    try {
      renameSync(this.filePath, this.rotatedPath(1));
    } catch {
      // If rename fails, we just keep appending to the current file.
    }
  }

  private rotatedPath(index: number): string {
    return join(this.dir, `${this.baseName}.${index}.log`);
  }
}
