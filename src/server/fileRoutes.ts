import { randomUUID } from 'crypto';
import express, { Request, Response } from 'express';
import { createWriteStream } from 'fs';
import { link, mkdir, open, rm, stat } from 'fs/promises';
import { dirname, posix } from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

import {
  FileLinkClaims,
  FileLinkMethod,
  FileLinkSigner,
  getFileLinkSigner,
} from '../blobStorage/fileLinkToken.js';
import { LocalFileStoreConfig, resolveStoredPath } from '../blobStorage/localFileStore.js';
import { log } from '../logging/logger.js';

const MESSAGES = {
  badUploadLink: 'Upload link is invalid or expired. Request a new upload.',
  badUploadHeaders: 'Upload must send exactly the signed Content-Length and Content-Type.',
  alreadyUsed: 'This upload link was already used. Request a new upload.',
  lengthMismatch: 'Upload body length did not match Content-Length.',
  badDownloadLink: 'Download link is invalid or expired.',
  notFound: 'File not found. It may have expired.',
} as const;

type UploadOutcome = 'stored' | 'exists' | 'length-mismatch';

/**
 * Serves the local file store's signed links. The token is the credential (like an S3 presigned
 * URL), so these routes sit outside OAuth and before the body parsers.
 */
export function registerFileRoutes(
  app: express.Application,
  config: LocalFileStoreConfig,
  signer: FileLinkSigner = getFileLinkSigner(),
): void {
  app.put('/files/:token', (req, res) => handleUpload(req, res, config.dir, signer));
  app.get('/files/:token', (req, res) => handleDownload(req, res, config.dir, signer));
}

async function handleUpload(
  req: Request,
  res: Response,
  root: string,
  signer: FileLinkSigner,
): Promise<void> {
  // Verified once, at the start: an upload that begins inside the TTL may finish after it.
  const claims = verifyOr403(req, res, signer, 'PUT', MESSAGES.badUploadLink);
  if (!claims) {
    return;
  }
  if (!hasSignedHeaders(req, claims)) {
    reject(res, 403, MESSAGES.badUploadHeaders, claims);
    return;
  }
  const path = resolveStoredPath(root, claims.k);
  const outcome = await writeUploadOnce(req, path, claims.n ?? 0);
  respondToUpload(res, outcome, claims);
}

function respondToUpload(res: Response, outcome: UploadOutcome, claims: FileLinkClaims): void {
  if (outcome === 'exists') {
    reject(res, 409, MESSAGES.alreadyUsed, claims);
  } else if (outcome === 'length-mismatch') {
    reject(res, 400, MESSAGES.lengthMismatch, claims);
  } else {
    logRequest('Upload stored', claims);
    res.status(200).end();
  }
}

async function handleDownload(
  req: Request,
  res: Response,
  root: string,
  signer: FileLinkSigner,
): Promise<void> {
  const claims = verifyOr403(req, res, signer, 'GET', MESSAGES.badDownloadLink);
  if (claims) {
    await sendStoredFile(res, resolveStoredPath(root, claims.k), claims);
  }
}

function verifyOr403(
  req: Request,
  res: Response,
  signer: FileLinkSigner,
  method: FileLinkMethod,
  message: string,
): FileLinkClaims | undefined {
  const claims = signer.verify(String(req.params.token), method);
  if (!claims) {
    reject(res, 403, message);
  }
  return claims;
}

function hasSignedHeaders(req: Request, claims: FileLinkClaims): boolean {
  return (
    req.headers['content-length'] === String(claims.n) && req.headers['content-type'] === claims.t
  );
}

/** Streams the body to a temp file, then hard-links it into place so only one upload can win. */
async function writeUploadOnce(
  req: Request,
  path: string,
  expectedBytes: number,
): Promise<UploadOutcome> {
  // Checked up front too, so a retried 5 GB upload isn't streamed just to get a 409.
  if (await exists(path)) {
    return 'exists';
  }
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    const received = await streamToFile(req, partial, expectedBytes);
    return received === expectedBytes ? await linkIntoPlace(partial, path) : 'length-mismatch';
  } catch {
    return 'length-mismatch';
  } finally {
    await rm(partial, { force: true });
  }
}

async function streamToFile(req: Request, path: string, maxBytes: number): Promise<number> {
  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      callback(
        received > maxBytes ? new Error('Upload body exceeds the signed length.') : null,
        chunk,
      );
    },
  });
  await pipeline(req, counter, createWriteStream(path));
  return received;
}

async function linkIntoPlace(partial: string, path: string): Promise<UploadOutcome> {
  try {
    await link(partial, path);
    return 'stored';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return 'exists';
    }
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function sendStoredFile(res: Response, path: string, claims: FileLinkClaims): Promise<void> {
  const handle = await open(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  if (!handle) {
    reject(res, 404, MESSAGES.notFound, claims);
    return;
  }
  const { size } = await handle.stat();
  res.status(200).set({
    'Content-Type': claims.t ?? 'application/octet-stream',
    'Content-Length': String(size),
    'Cache-Control': 'no-store',
  });
  logRequest('Download served', claims);
  await pipeline(handle.createReadStream(), res);
}

function reject(res: Response, status: number, message: string, claims?: FileLinkClaims): void {
  logRequest(`${res.req.method} rejected (${status})`, claims, 'warning');
  if (!res.headersSent && !res.writableEnded && !res.req.destroyed) {
    res.status(status).type('text/plain').send(message);
  }
}

// Logs the key's folder only, never the token: the token is the credential.
function logRequest(
  message: string,
  claims: FileLinkClaims | undefined,
  level: 'info' | 'warning' = 'info',
): void {
  const folder = claims ? posix.dirname(claims.k) : 'unknown';
  log({ message: `${message}: ${folder}`, level, logger: 'file-routes' });
}
