import express from 'express';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';

import { createFileLinkSigner } from '../../blobStorage/fileLinkToken.js';
import { createLocalFileStore } from '../../blobStorage/localFileStore.js';
import { registerFileRoutes } from '../../server/fileRoutes.js';
import { deleteStagedUpload } from './stagedUpload.js';
import { MOCK_SITE_LUID, MOCK_USER_LUID } from './toolContext.mock.js';
import {
  requestStagedWorkbookUpload,
  resolveStagedWorkbookUpload,
} from './workbooks/stagedWorkbookUpload.js';

vi.mock('../../logging/logger.js');

// No mocks of the store or routes: the real local store, real HTTP PUT, real disk.
describe('staged uploads on the local file store', () => {
  const signer = createFileLinkSigner(Buffer.alloc(32, 5));
  const tenant = { siteLuid: MOCK_SITE_LUID, userLuid: MOCK_USER_LUID };
  let root: string;
  let app: express.Application;
  let store: ReturnType<typeof createLocalFileStore>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-staged-'));
    const cfg = {
      enabled: true,
      dir: root,
      publicUrl: 'https://mcp.example.com',
      presignTtlSeconds: 60,
    };
    store = createLocalFileStore(cfg, signer);
    app = express();
    registerFileRoutes(app, cfg, signer);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function stageWorkbook(as: typeof tenant): Promise<string> {
    const { workbookUploadId, uploadUrl, requiredHeaders } = await requestStagedWorkbookUpload({
      fileName: 'app.twbx',
      fileSizeBytes: 4,
      store,
      tenant: as,
    });
    await request(app)
      .put(new URL(uploadUrl).pathname)
      .set(requiredHeaders)
      .send(Buffer.from('twbx'))
      .expect(200);
    return workbookUploadId;
  }

  it('requests, uploads over HTTP, resolves, and deletes a workbook', async () => {
    const workbookUploadId = await stageWorkbook(tenant);
    const resolved = await resolveStagedWorkbookUpload({ workbookUploadId, store, tenant });
    expect(resolved.bytes.toString()).toBe('twbx');

    await deleteStagedUpload(resolved.stagedKey, store, 'test');
    await expect(resolveStagedWorkbookUpload({ workbookUploadId, store, tenant })).rejects.toThrow(
      'Workbook upload not found',
    );
  });

  it('does not resolve an upload staged by another user', async () => {
    const workbookUploadId = await stageWorkbook(tenant);
    const otherUser = { ...tenant, userLuid: '11111111-2222-4333-8444-555555555555' };
    await expect(
      resolveStagedWorkbookUpload({ workbookUploadId, store, tenant: otherUser }),
    ).rejects.toThrow('Workbook upload not found');
  });
});
