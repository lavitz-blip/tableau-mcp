import { randomUUID } from 'crypto';
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'fs/promises';
import { dirname, join, resolve, sep } from 'path';

import { Config } from '../config.js';
import { log } from '../logging/logger.js';
import { FileLinkClaims, FileLinkSigner, getFileLinkSigner } from './fileLinkToken.js';
import { FileStore } from './fileStore.js';

export type LocalFileStoreConfig = Config['localFileStore'];

export const LOCAL_FILE_RETENTION_MS = 86_400_000;
export const LOCAL_FILE_SWEEP_INTERVAL_MS = 3_600_000;

export function createLocalFileStore(
  config: LocalFileStoreConfig,
  signer: FileLinkSigner = getFileLinkSigner(),
): FileStore {
  const { dir, publicUrl, presignTtlSeconds } = config;
  const link = (claims: Omit<FileLinkClaims, 'e'>): string =>
    buildFileLink(publicUrl, signer.sign({ ...claims, e: expiryEpochSeconds(presignTtlSeconds) }));
  return {
    keyPrefix: '',
    linkTtlSeconds: presignTtlSeconds,
    putAndLink: async ({ key, bytes, contentType }) => {
      await writeFileAtomically(resolveStoredPath(dir, key), bytes);
      return link({ k: key, m: 'GET', t: contentType });
    },
    createUploadLink: async ({ key, contentType, contentLength }) => {
      resolveStoredPath(dir, key);
      return link({ k: key, m: 'PUT', n: contentLength, t: contentType });
    },
    readIfExists: ({ key, maxBytes }) => readStoredFile(resolveStoredPath(dir, key), maxBytes),
    remove: (key) => rm(resolveStoredPath(dir, key), { force: true }),
  };
}

/** Maps a store key to a path under root, rejecting anything that could escape it. */
export function resolveStoredPath(root: string, key: string): string {
  const segments = key.split('/');
  const unsafe = segments.some(
    (s) => s === '' || s === '.' || s === '..' || s.includes('\\') || s.includes(':'),
  );
  const rootPath = resolve(root);
  const path = resolve(rootPath, ...segments);
  if (unsafe || !path.startsWith(rootPath + sep)) {
    throw new Error('File key is not a safe relative path.');
  }
  return path;
}

export function buildFileLink(publicUrl: string, token: string): string {
  return `${publicUrl}/files/${token}`;
}

function expiryEpochSeconds(ttlSeconds: number): number {
  return Math.floor(Date.now() / 1000) + ttlSeconds;
}

// Write then rename, so a reader never sees a half-written file.
async function writeFileAtomically(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, bytes);
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
}

async function readStoredFile(path: string, maxBytes: number): Promise<Buffer | undefined> {
  const size = await statSizeIfExists(path);
  if (size === undefined) {
    return undefined;
  }
  if (size > maxBytes) {
    throw new Error(`Stored file exceeds the ${maxBytes}-byte limit.`);
  }
  return readFile(path);
}

async function statSizeIfExists(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** Deletes files older than maxAgeMs and the folders they leave empty. Returns the files deleted. */
export async function sweepExpiredFiles(
  root: string,
  maxAgeMs: number,
  nowMs = Date.now(),
): Promise<number> {
  try {
    return await sweepFolder(root, nowMs - maxAgeMs, false);
  } catch (error) {
    if (isNotFound(error)) {
      return 0;
    }
    throw error;
  }
}

async function sweepFolder(
  folder: string,
  cutoffMs: number,
  removeIfEmpty: boolean,
): Promise<number> {
  let deleted = 0;
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    deleted += entry.isDirectory()
      ? await sweepFolder(path, cutoffMs, true)
      : await deleteFileIfOlder(path, cutoffMs);
  }
  if (removeIfEmpty && (await readdir(folder)).length === 0) {
    await rmdir(folder);
  }
  return deleted;
}

async function deleteFileIfOlder(path: string, cutoffMs: number): Promise<number> {
  if ((await stat(path)).mtimeMs >= cutoffMs) {
    return 0;
  }
  await rm(path, { force: true });
  return 1;
}

/** Sweeps now and every LOCAL_FILE_SWEEP_INTERVAL_MS; the timer doesn't keep the process alive. */
export function startLocalFileSweeper(config: LocalFileStoreConfig): NodeJS.Timeout {
  const sweep = (): void => void runSweep(config.dir);
  sweep();
  return setInterval(sweep, LOCAL_FILE_SWEEP_INTERVAL_MS).unref();
}

async function runSweep(root: string): Promise<void> {
  try {
    const deleted = await sweepExpiredFiles(root, LOCAL_FILE_RETENTION_MS);
    log({
      message: `Local file store sweep deleted ${deleted} file(s).`,
      level: 'debug',
      logger: 'file-store',
    });
  } catch (error) {
    log({
      message: `Local file store sweep failed: ${String(error)}`,
      level: 'warning',
      logger: 'file-store',
    });
  }
}
