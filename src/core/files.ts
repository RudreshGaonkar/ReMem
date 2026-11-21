import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { setTimeout as delay } from 'timers/promises';

export function atomicWrite(file: string, content: string | Buffer, mode = 0o600, assertOwner?: () => void): void {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode });
    assertOwner?.();
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function fileVersion(file: string): string {
  const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!stat) return '';
  if (!stat.isFile()) throw new Error('Expected a regular file: ' + file);
  return [stat.ino, stat.ctimeNs, stat.size].join(':');
}

async function lockVersion(file: string): Promise<string> {
  try {
    const stat = await fs.promises.lstat(file, { bigint: true });
    if (!stat.isFile()) throw new Error('Expected a regular lock file: ' + file);
    return [stat.ino, stat.ctimeNs, stat.size].join(':');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

async function readLock(lock: string) {
  try {
    const handle = await fs.promises.open(lock, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile()) throw new Error('Expected a regular lock file: ' + lock);
      const content = stat.size <= 4096n ? await handle.readFile('utf8') : '';
      // Older releases stored only the PID.
      let pid: unknown;
      let token: unknown;
      try {
        const metadata = JSON.parse(content);
        pid = typeof metadata === 'number' ? metadata : metadata?.pid;
        token = metadata?.token;
      } catch {
        // Ownership of a malformed legacy lock cannot be established.
      }
      return {
        token,
        version: [stat.ino, stat.ctimeNs, stat.size].join(':'),
        pid: typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff ? pid : undefined,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function isStaleLock(owner: NonNullable<Awaited<ReturnType<typeof readLock>>>): boolean {
  if (owner.pid !== undefined) {
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      // EPERM means the process exists but belongs to a different user.
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    }
  }
  return false;
}

async function createLock(lock: string, token = randomUUID()): Promise<boolean> {
  const temporary = lock + '.' + token + '.tmp';
  try {
    await fs.promises.writeFile(temporary, JSON.stringify({ pid: process.pid, timestamp: Date.now(), token }), { flag: 'wx', mode: 0o600 });
    await fs.promises.link(temporary, lock);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

async function unlinkLockVersion(lock: string, version: string): Promise<boolean> {
  if ((await lockVersion(lock)) !== version) return false;
  try {
    await fs.promises.unlink(lock);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function retireLock(lock: string, version: string, depth = 0): Promise<void> {
  // Each generation has its own guard, including when a reclaimer dies.
  if (depth >= 8) return;
  const key = createHash('sha256').update(lock + '\0' + version).digest('hex');
  const guard = path.join(path.dirname(lock), '.cuttlehawk-reclaim-' + key + '.lock');
  if (!(await createLock(guard))) {
    const owner = await readLock(guard);
    if (!owner || !isStaleLock(owner)) return;
    await retireLock(guard, owner.version, depth + 1);
    if (!(await createLock(guard))) return;
  }
  const guardVersion = await lockVersion(guard);
  try {
    await unlinkLockVersion(lock, version);
  } finally {
    await unlinkLockVersion(guard, guardVersion);
  }
}

async function tryLock(file: string) {
  const lock = file + '.lock';
  const previous = await readLock(lock);
  if (previous) {
    if (isStaleLock(previous)) await retireLock(lock, previous.version);
    else return undefined;
  }
  const token = randomUUID();
  if (!(await createLock(lock, token))) return undefined;
  const version = await lockVersion(lock);
  return {
    release: () => retireLock(lock, version),
    assertOwner: async () => {
      const owner = await readLock(lock);
      if (owner?.version !== version || owner.pid !== process.pid || owner.token !== token) {
        throw new Error('Lost ownership of ' + lock);
      }
    },
  };
}

function lockTimeout(file: string): Error {
  return new Error('Timed out waiting for ' + file + '.lock');
}

export async function withAsyncFileLock<T>(
  file: string,
  action: (assertOwner: () => Promise<void>) => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const deadline = performance.now() + 15_000;
  do {
    signal?.throwIfAborted();
    const lock = await tryLock(file);
    if (lock) {
      try {
        signal?.throwIfAborted();
        return await action(lock.assertOwner);
      } finally {
        await lock.release();
      }
    }
    await delay(15 + Math.random() * 25, undefined, { signal });
  } while (performance.now() < deadline);
  throw lockTimeout(file);
}

/** Resolve existing paths without following links outside the workspace. */
export function isWorkspacePath(root: string, file: string): boolean {
  root = path.resolve(root);
  file = path.resolve(file);
  const inside = (candidate: string) => {
    const relative = path.relative(root, candidate);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  if (!inside(file)) return false;
  for (let current = file; current !== root; current = path.dirname(current)) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
  }
  return true;
}

export const MAX_INDEXED_FILE_BYTES = 1024 * 1024;

/** Read at most one byte beyond the limit, including if the file grows after stat. */
export async function readWorkspaceText(file: string): Promise<string | undefined> {
  const stat = await fs.promises.stat(file).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!stat?.isFile() || stat.size > MAX_INDEXED_FILE_BYTES) return undefined;
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    const limit = MAX_INDEXED_FILE_BYTES + 1;
    let buffer = Buffer.allocUnsafe(Math.min(limit, Math.max(4096, stat.size + 1)));
    let offset = 0;
    while (offset < limit) {
      if (offset === buffer.length) {
        const expanded = Buffer.allocUnsafe(Math.min(limit, buffer.length * 2));
        buffer.copy(expanded);
        buffer = expanded;
      }
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const bytes = buffer.subarray(0, offset);
    return offset <= MAX_INDEXED_FILE_BYTES && !bytes.includes(0) ? bytes.toString('utf8') : undefined;
  } finally {
    await handle.close();
  }
}

export async function publishAtomic(file: string, content: string | Buffer, assertOwner: () => Promise<void>, mode = 0o600): Promise<void> {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.promises.writeFile(temporary, content, { flag: 'wx', mode });
    await assertOwner();
    await fs.promises.rename(temporary, file);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}
