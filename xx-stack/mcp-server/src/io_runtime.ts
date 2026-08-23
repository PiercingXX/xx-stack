import { open, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The filesystem entry points `atomicWriteTextFile` uses, injectable so a test
 * can assert the durability sequence itself (write → fsync → close → rename →
 * directory fsync). Nothing but a test should pass this — production callers
 * take the default.
 */
export interface AtomicWriteIo {
  open: (path: string, flags: string) => Promise<FileHandle>;
  rename: (from: string, to: string) => Promise<void>;
}

const DEFAULT_ATOMIC_WRITE_IO: AtomicWriteIo = { open, rename };

/**
 * `fsync` on a directory is a POSIX courtesy, not a universal one. Windows has
 * no notion of it, some FUSE and network filesystems reject it, and a few
 * refuse to open a directory for reading at all. None of those is a write
 * failure — the rename already succeeded and the file's own data is already
 * synced — so these codes degrade to "less durable than we asked for" instead
 * of failing the caller's store write. Anything outside this set is a real
 * error and still propagates.
 */
const DIRECTORY_FSYNC_TOLERATED_CODES = new Set([
  "EPERM",
  "EINVAL",
  "EISDIR",
  "EACCES",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EBADF",
]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Best-effort directory fsync. Persists the *directory entry* created by the
 * rename; without it the file contents can survive a crash while the name that
 * reaches them does not.
 */
async function fsyncDirectoryBestEffort(directory: string, io: AtomicWriteIo): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await io.open(directory, "r");
  } catch (error) {
    if (DIRECTORY_FSYNC_TOLERATED_CODES.has(errorCode(error) ?? "")) return;
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!DIRECTORY_FSYNC_TOLERATED_CODES.has(errorCode(error) ?? "")) throw error;
  } finally {
    await handle.close();
  }
}

/**
 * Write `content` to `path` atomically and durably.
 *
 * Atomic rename gives a reader **visibility** — it never observes a half-written
 * document. It does not give **durability**. ext4's auto-fsync-on-rename
 * heuristic usually flushes the replaced file's data, but that is a filesystem
 * courtesy rather than a guarantee (it is off under `data=writeback`, and other
 * filesystems make no such promise), and it never covers the directory entry.
 * This function is the sole writer for the supervisor store, the task store and
 * the memory snapshot metadata, and MANUAL §11 rates store truncation CRITICAL
 * (MCP-1) — the same asset, a different trigger.
 *
 * **The honest trade:** the two fsyncs below add real latency to every store
 * write — an actual disk flush, not a page-cache copy, on paths that run on
 * every task mutation and every supervisor tick. Measured on the real store
 * location (`~/.config`, ext4 on NVMe, 100 writes of a 17.7 KiB document):
 * **0.168 ms/write → 4.088 ms/write**, roughly 24x. On tmpfs it is free
 * (0.118 → 0.116 ms), because there fsync has nothing to flush — so a run
 * benchmarked in /tmp will not show this cost at all.
 *
 * What that buys is narrow: it only matters when the machine loses power or
 * panics in the window between the rename and the kernel's own writeback. That
 * is a rare event with an expensive consequence (a truncated or vanished
 * store), and the ~4 ms is paid on every write whether or not the event ever
 * happens. This is a deliberate choice to make the common case slower so the
 * rare case is not silent data loss — not a free improvement.
 */
/**
 * Best-effort removal of a temp file a failed write left behind. The write may
 * have failed before creating anything (an injected `io` never touches disk) or
 * the file may already be gone, so any unlink failure is ignored — the point is
 * only that a `.tmp-*` orphan does not accumulate next to the real store.
 */
async function removeTempFileBestEffort(tempPath: string): Promise<void> {
  try {
    await unlink(tempPath);
  } catch {
    // Nothing to clean up, or someone else removed it — either is fine.
  }
}

export async function atomicWriteTextFile(
  path: string,
  content: string,
  io: AtomicWriteIo = DEFAULT_ATOMIC_WRITE_IO
): Promise<void> {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const handle = await io.open(tempPath, "w");
  try {
    try {
      await handle.writeFile(content, "utf-8");
      // Flush the temp file's data before it is given the real name: a rename
      // that publishes a name pointing at unflushed blocks is exactly the
      // truncation this is meant to prevent.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await io.rename(tempPath, path);
  } catch (error) {
    await removeTempFileBestEffort(tempPath);
    throw error;
  }
  await fsyncDirectoryBestEffort(dirname(path), io);
}
