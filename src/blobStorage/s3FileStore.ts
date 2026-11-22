import {
  BucketS3Config,
  createPresignedPutUrlToS3,
  deleteObjectFromS3,
  downloadObjectFromS3IfExists,
  uploadBufferToS3,
} from '../tools/web/s3Client.js';
import { FileStore } from './fileStore.js';

export function createS3FileStore(config: BucketS3Config): FileStore {
  const { bucket, region, presignTtlSeconds } = config;
  return {
    keyPrefix: config.keyPrefix,
    linkTtlSeconds: presignTtlSeconds,
    putAndLink: ({ key, bytes, contentType }) =>
      uploadBufferToS3(bytes, { key, contentType, bucket, region, presignTtlSeconds }),
    createUploadLink: ({ key, contentType, contentLength }) =>
      createPresignedPutUrlToS3({
        key,
        contentType,
        contentLength,
        bucket,
        region,
        presignTtlSeconds,
      }),
    readIfExists: ({ key, maxBytes }) =>
      downloadObjectFromS3IfExists({ key, bucket, region, maxBytes }),
    remove: (key) => deleteObjectFromS3({ key, bucket, region }),
  };
}
