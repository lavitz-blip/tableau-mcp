import { getFileStore } from './fileStore.js';

const bucketS3 = {
  enabled: false,
  bucket: '',
  region: '',
  keyPrefix: 'mcp/',
  presignTtlSeconds: 60,
};
const localFileStore = { enabled: false, dir: '', publicUrl: '', presignTtlSeconds: 60 };

describe('getFileStore', () => {
  it('returns undefined when no store is configured', () => {
    expect(getFileStore({ bucketS3, localFileStore })).toBeUndefined();
  });

  it('returns the S3 store when MCP_S3_BUCKET is set', () => {
    const store = getFileStore({
      bucketS3: { ...bucketS3, enabled: true, bucket: 'b' },
      localFileStore,
    });
    expect(store?.keyPrefix).toBe('mcp/');
  });

  it('returns the local store when MCP_LOCAL_FILE_STORE_DIR is set', () => {
    const store = getFileStore({
      bucketS3,
      localFileStore: {
        enabled: true,
        dir: '/tmp/mcp-files',
        publicUrl: 'https://mcp.example.com',
        presignTtlSeconds: 60,
      },
    });
    expect(store?.keyPrefix).toBe('');
  });
});
