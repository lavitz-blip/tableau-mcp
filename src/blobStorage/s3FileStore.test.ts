import { createS3FileStore } from './s3FileStore.js';

const mocks = vi.hoisted(() => ({
  uploadBufferToS3: vi.fn(),
  createPresignedPutUrlToS3: vi.fn(),
  downloadObjectFromS3IfExists: vi.fn(),
  deleteObjectFromS3: vi.fn(),
}));

vi.mock('../tools/web/s3Client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/web/s3Client.js')>()),
  ...mocks,
}));

describe('createS3FileStore', () => {
  const cfg = { bucket: 'b', region: 'us-east-1', keyPrefix: 'mcp/', presignTtlSeconds: 300 };
  const store = createS3FileStore(cfg);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes the key prefix and link lifetime', () => {
    expect(store.keyPrefix).toBe('mcp/');
    expect(store.linkTtlSeconds).toBe(300);
  });

  it('createUploadLink signs a PUT with the length and type', async () => {
    mocks.createPresignedPutUrlToS3.mockResolvedValue('https://s3/put');
    await expect(
      store.createUploadLink({ key: 'k', contentType: 'application/xml', contentLength: 5 }),
    ).resolves.toBe('https://s3/put');
    expect(mocks.createPresignedPutUrlToS3).toHaveBeenCalledWith({
      key: 'k',
      contentType: 'application/xml',
      contentLength: 5,
      bucket: 'b',
      region: 'us-east-1',
      presignTtlSeconds: 300,
    });
  });

  it('putAndLink uploads the bytes and returns the presigned GET link', async () => {
    mocks.uploadBufferToS3.mockResolvedValue('https://s3/get');
    const bytes = Buffer.from('zip');
    await expect(
      store.putAndLink({ key: 'k', bytes, contentType: 'application/zip' }),
    ).resolves.toBe('https://s3/get');
    expect(mocks.uploadBufferToS3).toHaveBeenCalledWith(bytes, {
      key: 'k',
      contentType: 'application/zip',
      bucket: 'b',
      region: 'us-east-1',
      presignTtlSeconds: 300,
    });
  });

  it('readIfExists downloads with the size cap', async () => {
    mocks.downloadObjectFromS3IfExists.mockResolvedValue(Buffer.from('x'));
    await expect(store.readIfExists({ key: 'k', maxBytes: 10 })).resolves.toEqual(Buffer.from('x'));
    expect(mocks.downloadObjectFromS3IfExists).toHaveBeenCalledWith({
      key: 'k',
      bucket: 'b',
      region: 'us-east-1',
      maxBytes: 10,
    });
  });

  it('remove deletes the object', async () => {
    mocks.deleteObjectFromS3.mockResolvedValue(undefined);
    await store.remove('k');
    expect(mocks.deleteObjectFromS3).toHaveBeenCalledWith({
      key: 'k',
      bucket: 'b',
      region: 'us-east-1',
    });
  });
});
