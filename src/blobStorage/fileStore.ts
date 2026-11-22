import { Config } from '../config.js';
import { createLocalFileStore } from './localFileStore.js';
import { createS3FileStore } from './s3FileStore.js';

/** Where staged files live: an S3 bucket or this MCP's own disk. Links carry their own authorization. */
export type FileStore = {
  keyPrefix: string;
  linkTtlSeconds: number;
  putAndLink(args: { key: string; bytes: Buffer; contentType: string }): Promise<string>;
  createUploadLink(args: {
    key: string;
    contentType: string;
    contentLength: number;
  }): Promise<string>;
  readIfExists(args: { key: string; maxBytes: number }): Promise<Buffer | undefined>;
  remove(key: string): Promise<void>;
};

export function getFileStore(
  config: Pick<Config, 'bucketS3' | 'localFileStore'>,
): FileStore | undefined {
  if (config.bucketS3.enabled) {
    return createS3FileStore(config.bucketS3);
  }
  if (config.localFileStore.enabled) {
    return createLocalFileStore(config.localFileStore);
  }
  return undefined;
}
