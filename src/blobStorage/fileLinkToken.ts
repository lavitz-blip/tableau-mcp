import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { z } from 'zod';

export type FileLinkMethod = 'GET' | 'PUT';

export type FileLinkClaims = { k: string; m: FileLinkMethod; e: number; n?: number; t?: string };

export type FileLinkSigner = {
  sign(claims: FileLinkClaims): string;
  verify(token: string, method: FileLinkMethod, nowMs?: number): FileLinkClaims | undefined;
};

const claimsSchema = z
  .object({
    k: z.string().min(1),
    m: z.enum(['GET', 'PUT']),
    e: z.number().int(),
    n: z.number().int().nonnegative().optional(),
    t: z.string().optional(),
  })
  .strict();

export function createFileLinkSigner(secret: Buffer): FileLinkSigner {
  const mac = (payload: string): Buffer => createHmac('sha256', secret).update(payload).digest();
  return {
    sign: (claims) => {
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      return `${payload}.${mac(payload).toString('base64url')}`;
    },
    verify: (token, method, nowMs = Date.now()) => {
      const claims = parseToken(token, mac);
      return isClaimsUsable(claims, method, nowMs) ? claims : undefined;
    },
  };
}

function parseToken(token: string, mac: (payload: string) => Buffer): unknown {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return undefined;
  }
  const [payload, signature] = parts;
  const expected = mac(payload);
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

function isClaimsUsable(
  claims: unknown,
  method: FileLinkMethod,
  nowMs: number,
): claims is FileLinkClaims {
  const parsed = claimsSchema.safeParse(claims);
  return parsed.success && parsed.data.m === method && parsed.data.e * 1000 > nowMs;
}

let processSigner: FileLinkSigner | undefined;

// ponytail: per-process secret; restart voids links (they live FILE_TTL s). Shared secret if we ever run several instances.
export function getFileLinkSigner(): FileLinkSigner {
  processSigner ??= createFileLinkSigner(randomBytes(32));
  return processSigner;
}
