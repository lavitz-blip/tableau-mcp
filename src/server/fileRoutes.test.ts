import express from 'express';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import http from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';

import { createFileLinkSigner } from '../blobStorage/fileLinkToken.js';
import { createLocalFileStore } from '../blobStorage/localFileStore.js';
import { log } from '../logging/logger.js';
import { registerFileRoutes } from './fileRoutes.js';

vi.mock('../logging/logger.js');

const mocks = vi.hoisted(() => ({ linkFails: false }));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    link: (existing: string, target: string) =>
      mocks.linkFails
        ? Promise.reject(
            Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' }),
          )
        : actual.link(existing, target),
  };
});

const OCTET = 'application/octet-stream';
const KEY = 'w/s/u/id/workbook.twbx';

function listFiles(dir: string): Array<string> {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

describe('registerFileRoutes', () => {
  const signer = createFileLinkSigner(Buffer.alloc(32, 3));
  const nowSec = (): number => Math.floor(Date.now() / 1000);
  let root: string;
  let cfg: { enabled: boolean; dir: string; publicUrl: string; presignTtlSeconds: number };
  let app: express.Application;

  const putToken = (n: number, t = OCTET, key = KEY): string =>
    signer.sign({ k: key, m: 'PUT', e: nowSec() + 60, n, t });

  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), 'mcp-files-'));
    cfg = { enabled: true, dir: root, publicUrl: 'https://mcp.example.com', presignTtlSeconds: 60 };
    app = express();
    registerFileRoutes(app, cfg, signer);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('stores an upload sent with the signed length and type', async () => {
    await request(app)
      .put(`/files/${putToken(3)}`)
      .set('Content-Type', OCTET)
      .send(Buffer.from('abc'))
      .expect(200);
    expect(readFileSync(join(root, KEY), 'utf8')).toBe('abc');
    expect(listFiles(root)).toEqual(['workbook.twbx']);
  });

  it('verifies the token once, when the upload starts, so a slow upload is not expired at the end', async () => {
    const verify = vi.spyOn(signer, 'verify');
    await request(app)
      .put(`/files/${putToken(3)}`)
      .set('Content-Type', OCTET)
      .send(Buffer.from('abc'))
      .expect(200);
    expect(verify).toHaveBeenCalledTimes(1);
    verify.mockRestore();
  });

  it('answers 500 and logs the cause when the server cannot store the upload', async () => {
    mocks.linkFails = true;
    try {
      const res = await request(app)
        .put(`/files/${putToken(3)}`)
        .set('Content-Type', OCTET)
        .send(Buffer.from('abc'))
        .expect(500);
      expect(res.text).toBe('The server could not store the upload. Try again later.');
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('EPERM') }),
      );
      expect(listFiles(root)).toEqual([]);
    } finally {
      mocks.linkFails = false;
    }
  });

  it('rejects a second PUT with the same link and keeps the first file', async () => {
    const token = putToken(3);
    await request(app)
      .put(`/files/${token}`)
      .set('Content-Type', OCTET)
      .send(Buffer.from('abc'))
      .expect(200);
    const res = await request(app)
      .put(`/files/${token}`)
      .set('Content-Type', OCTET)
      .send(Buffer.from('xyz'))
      .expect(409);
    expect(res.text).toBe('This upload link was already used. Request a new upload.');
    expect(readFileSync(join(root, KEY), 'utf8')).toBe('abc');
  });

  it('rejects a body whose length differs from the signed length', async () => {
    const res = await request(app)
      .put(`/files/${putToken(5)}`)
      .set('Content-Type', OCTET)
      .send(Buffer.from('abc'))
      .expect(403);
    expect(res.text).toBe('Upload must send exactly the signed Content-Length and Content-Type.');
    expect(readdirSync(root)).toEqual([]);
  });

  it('rejects a body that ends short of Content-Length and leaves no file', async () => {
    const server = http.createServer(app).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'PUT',
        path: `/files/${putToken(5)}`,
        headers: { 'Content-Type': OCTET, 'Content-Length': '5' },
      });
      req.on('error', () => {});
      req.write('abc');
      await vi.waitFor(() => expect(existsSync(join(root, 'w'))).toBe(true));
      req.destroy();
      await vi.waitFor(() =>
        expect(log).toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringContaining('PUT rejected (400)') }),
        ),
      );
      expect(listFiles(root)).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rejects the wrong Content-Type', async () => {
    await request(app)
      .put(`/files/${putToken(3, 'application/xml')}`)
      .set('Content-Type', OCTET)
      .send(Buffer.from('abc'))
      .expect(403);
    expect(readdirSync(root)).toEqual([]);
  });

  it('rejects a GET token used for PUT', async () => {
    const token = signer.sign({ k: KEY, m: 'GET', e: nowSec() + 60 });
    const res = await request(app)
      .put(`/files/${token}`)
      .set('Content-Type', OCTET)
      .send(Buffer.from('abc'))
      .expect(403);
    expect(res.text).toBe('Upload link is invalid or expired. Request a new upload.');
  });

  it('rejects an expired PUT token', async () => {
    const token = signer.sign({ k: KEY, m: 'PUT', e: nowSec() - 1, n: 3, t: OCTET });
    await request(app)
      .put(`/files/${token}`)
      .set('Content-Type', OCTET)
      .send(Buffer.from('abc'))
      .expect(403);
    expect(readdirSync(root)).toEqual([]);
  });

  it('rejects a token signed by a previous process (restart)', async () => {
    const old = createFileLinkSigner(Buffer.alloc(32, 9));
    const res = await request(app)
      .put(`/files/${old.sign({ k: 'w/x', m: 'PUT', e: nowSec() + 60, n: 1, t: OCTET })}`)
      .set('Content-Type', OCTET)
      .send(Buffer.from('a'));
    expect(res.status).toBe(403);
    expect(res.text).toBe('Upload link is invalid or expired. Request a new upload.');
  });

  it('serves a stored file with its type and no-store', async () => {
    const link = await createLocalFileStore(cfg, signer).putAndLink({
      key: 't/z.zip',
      bytes: Buffer.from('zip'),
      contentType: 'application/zip',
    });
    const res = await request(app)
      .get(new URL(link).pathname)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Array<Buffer> = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toContain('application/zip');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Buffer.from(res.body).toString()).toBe('zip');
  });

  it('answers 404 for a valid GET link whose file is gone', async () => {
    const token = signer.sign({ k: 't/missing.zip', m: 'GET', e: nowSec() + 60, t: 'x/y' });
    const res = await request(app).get(`/files/${token}`).expect(404);
    expect(res.text).toBe('File not found. It may have expired.');
  });

  it('answers 403 for an expired GET link', async () => {
    const token = signer.sign({ k: 't/z.zip', m: 'GET', e: nowSec() - 1, t: 'x/y' });
    const res = await request(app).get(`/files/${token}`).expect(403);
    expect(res.text).toBe('Download link is invalid or expired.');
  });

  it('answers 403 for a PUT token used for GET', async () => {
    await request(app)
      .get(`/files/${putToken(3)}`)
      .expect(403);
  });
});
