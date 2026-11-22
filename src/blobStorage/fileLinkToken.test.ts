import { createFileLinkSigner } from './fileLinkToken.js';

describe('fileLinkToken', () => {
  const signer = createFileLinkSigner(Buffer.alloc(32, 7));
  const claims = {
    k: 'workbook-uploads/a/b/c/workbook.twbx',
    m: 'PUT' as const,
    e: 2_000_000_000,
    n: 10,
    t: 'application/octet-stream',
  };

  it('round-trips claims', () => {
    expect(signer.verify(signer.sign(claims), 'PUT', 1_000)).toEqual(claims);
  });

  it('rejects the wrong method', () => {
    expect(signer.verify(signer.sign(claims), 'GET', 1_000)).toBeUndefined();
  });

  it('rejects an expired token', () => {
    expect(signer.verify(signer.sign(claims), 'PUT', 2_000_000_000_000)).toBeUndefined();
  });

  it('rejects a tampered payload', () => {
    const [, sig] = signer.sign(claims).split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, n: 99 })).toString('base64url');
    expect(signer.verify(`${forged}.${sig}`, 'PUT', 1_000)).toBeUndefined();
  });

  it('rejects a signature whose unused trailing bits were changed', () => {
    const [payload, sig] = signer.sign(claims).split('.');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet[alphabet.indexOf(sig.at(-1)!) ^ 1];
    expect(signer.verify(`${payload}.${sig.slice(0, -1)}${last}`, 'PUT', 1_000)).toBeUndefined();
  });

  it('rejects a token from another secret (restart)', () => {
    const other = createFileLinkSigner(Buffer.alloc(32, 8));
    expect(signer.verify(other.sign(claims), 'PUT', 1_000)).toBeUndefined();
  });

  it.each(['', 'abc', 'a.b.c', '.', 'x.'])('rejects malformed token %j', (token) => {
    expect(signer.verify(token, 'PUT', 1_000)).toBeUndefined();
  });

  it('produces URL-safe tokens', () => {
    expect(signer.sign(claims)).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});
