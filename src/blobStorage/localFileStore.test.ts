import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createFileLinkSigner } from './fileLinkToken.js';
import { FileStore } from './fileStore.js';
import {
  createLocalFileStore,
  LOCAL_FILE_RETENTION_MS,
  resolveStoredPath,
  sweepExpiredFiles,
} from './localFileStore.js';

describe('localFileStore', () => {
  const signer = createFileLinkSigner(Buffer.alloc(32, 1));
  let root: string;
  let store: FileStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-files-'));
    store = createLocalFileStore(
      { enabled: true, dir: root, publicUrl: 'https://mcp.example.com', presignTtlSeconds: 60 },
      signer,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('has no key prefix and the configured link lifetime', () => {
    expect(store.keyPrefix).toBe('');
    expect(store.linkTtlSeconds).toBe(60);
  });

  it('putAndLink stores the bytes and returns a GET link for that key', async () => {
    const link = await store.putAndLink({
      key: 'data-app-templates/t.zip',
      bytes: Buffer.from('zip'),
      contentType: 'application/zip',
    });
    expect(link).toMatch(/^https:\/\/mcp\.example\.com\/files\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const claims = signer.verify(link.split('/files/')[1], 'GET');
    expect(claims).toMatchObject({ k: 'data-app-templates/t.zip', m: 'GET', t: 'application/zip' });
    expect(readFileSync(join(root, 'data-app-templates', 't.zip'), 'utf8')).toBe('zip');
  });

  it('putAndLink overwrites an existing file at the same key', async () => {
    await store.putAndLink({ key: 'a/t.zip', bytes: Buffer.from('a'), contentType: 'x/y' });
    await store.putAndLink({ key: 'a/t.zip', bytes: Buffer.from('b'), contentType: 'x/y' });
    expect(readFileSync(join(root, 'a', 't.zip'), 'utf8')).toBe('b');
    expect(readdirSync(join(root, 'a'))).toEqual(['t.zip']);
  });

  it('createUploadLink signs a PUT with length and type and writes nothing', async () => {
    const link = await store.createUploadLink({
      key: 'w/x.twbx',
      contentType: 'application/octet-stream',
      contentLength: 3,
    });
    expect(signer.verify(link.split('/files/')[1], 'PUT')).toMatchObject({
      k: 'w/x.twbx',
      n: 3,
      t: 'application/octet-stream',
    });
    expect(existsSync(join(root, 'w'))).toBe(false);
  });

  it('readIfExists returns undefined for a missing key', async () => {
    await expect(store.readIfExists({ key: 'nope/x', maxBytes: 10 })).resolves.toBeUndefined();
  });

  it('readIfExists returns the stored bytes', async () => {
    await store.putAndLink({ key: 'a/b', bytes: Buffer.from('hi'), contentType: 'x/y' });
    await expect(store.readIfExists({ key: 'a/b', maxBytes: 10 })).resolves.toEqual(
      Buffer.from('hi'),
    );
  });

  it('readIfExists throws over maxBytes', async () => {
    await store.putAndLink({ key: 'a/b', bytes: Buffer.alloc(11), contentType: 'x/y' });
    await expect(store.readIfExists({ key: 'a/b', maxBytes: 10 })).rejects.toThrow(
      'Stored file exceeds the 10-byte limit.',
    );
  });

  it('remove deletes and a second remove is harmless', async () => {
    await store.putAndLink({ key: 'a/b', bytes: Buffer.from('x'), contentType: 'x/y' });
    await store.remove('a/b');
    await store.remove('a/b');
    await expect(store.readIfExists({ key: 'a/b', maxBytes: 10 })).resolves.toBeUndefined();
  });

  it.each(['../x', 'a/../../x', 'a//b', './a', 'a\\b', 'C:/x', '/abs', ''])(
    'resolveStoredPath rejects %j',
    (key) => {
      expect(() => resolveStoredPath(root, key)).toThrow('File key is not a safe relative path.');
    },
  );

  it('resolveStoredPath maps a key under the root', () => {
    expect(resolveStoredPath(root, 'a/b.twbx')).toBe(join(root, 'a', 'b.twbx'));
  });

  it('sweepExpiredFiles removes old files and empty folders, keeps new ones', async () => {
    await store.putAndLink({ key: 'old/a/f', bytes: Buffer.from('o'), contentType: 'x/y' });
    await store.putAndLink({ key: 'new/f', bytes: Buffer.from('n'), contentType: 'x/y' });
    const twoDaysAgo = new Date(Date.now() - 2 * LOCAL_FILE_RETENTION_MS);
    utimesSync(join(root, 'old', 'a', 'f'), twoDaysAgo, twoDaysAgo);

    await expect(sweepExpiredFiles(root, LOCAL_FILE_RETENTION_MS)).resolves.toBe(1);
    expect(existsSync(join(root, 'old'))).toBe(false);
    expect(existsSync(join(root, 'new', 'f'))).toBe(true);
    expect(existsSync(root)).toBe(true);
  });

  it('sweepExpiredFiles returns 0 for a missing root', async () => {
    await expect(sweepExpiredFiles(join(root, 'missing'), LOCAL_FILE_RETENTION_MS)).resolves.toBe(
      0,
    );
  });
});
