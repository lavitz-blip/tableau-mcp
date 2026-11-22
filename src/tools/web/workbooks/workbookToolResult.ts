import { randomUUID } from 'node:crypto';

import { CallToolResult } from '@modelcontextprotocol/server';
import { mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Ok, Result } from 'ts-results-es';

import { getFileStore } from '../../../blobStorage/fileStore.js';
import { getTenantLuids, TenantIdentitySource } from '../../../blobStorage/tenantKey.js';
import { Config } from '../../../config.js';
import { McpToolError } from '../../../errors/mcpToolError.js';
import { getFeatureGate } from '../../../features/init.js';
import { log } from '../../../logging/logger.js';
import { getExceptionMessage } from '../../../utils/getExceptionMessage.js';
import { buildTenantS3Key } from '../s3Client.js';

export type WorkbookToolResult =
  | { kind: 'url'; url: string; mimeType: string; filename: string }
  | { kind: 'path'; path: string; mimeType: string; filename: string };

export async function buildWorkbookToolResult({
  content,
  mimeType,
  filename,
  resourceId,
  config,
  toolName,
  keyPrefixSegment,
  tenant,
}: {
  content: Buffer;
  mimeType: string;
  filename: string;
  resourceId: string;
  config: Config;
  toolName: string;
  keyPrefixSegment: string;
  tenant: TenantIdentitySource;
}): Promise<Result<WorkbookToolResult, McpToolError>> {
  const store = getFileStore(config);
  if (!store || !(await getFeatureGate().isFeatureEnabled('workbook-file-mode'))) {
    return new Ok(await persistWorkbookToTempPath({ content, mimeType, filename }));
  }

  // Resolved outside the try so a missing tenant fails closed instead of falling back.
  const tenantLuids = getTenantLuids(tenant);
  if (tenantLuids.isErr()) {
    return tenantLuids;
  }

  try {
    const ext = mimeType === 'application/xml' ? 'twb' : 'twbx';
    const key = buildTenantS3Key(
      store.keyPrefix,
      tenantLuids.value,
      keyPrefixSegment,
      `${resourceId}/${randomUUID()}.${ext}`,
    );
    const url = await store.putAndLink({ key, bytes: content, contentType: mimeType });
    return new Ok({ kind: 'url', url, mimeType, filename });
  } catch (error) {
    log({
      message: `${toolName}: file store workbook upload failed, falling back to temp-file output: ${getExceptionMessage(
        error,
      )}`,
      level: 'warning',
      logger: 'tool',
    });
    return new Ok(await persistWorkbookToTempPath({ content, mimeType, filename }));
  }
}

export function workbookToolResultToCallToolResult(result: WorkbookToolResult): CallToolResult {
  if (result.kind === 'path') {
    return {
      isError: false,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            path: result.path,
            filename: result.filename,
            mimeType: result.mimeType,
          }),
        },
      ],
    };
  }

  return {
    isError: false,
    content: [
      {
        type: 'resource_link',
        uri: result.url,
        name: result.filename,
        mimeType: result.mimeType,
        description:
          'Downloaded Tableau workbook content in the file store. This is a short-lived signed URL.',
      },
    ],
  };
}

async function persistWorkbookToTempPath({
  content,
  mimeType,
  filename,
}: {
  content: Buffer;
  mimeType: string;
  filename: string;
}): Promise<WorkbookToolResult> {
  const extension = mimeType === 'application/xml' ? 'twb' : 'twbx';
  const tempDir = join(tmpdir(), 'tableau-mcp-workbooks');
  await mkdir(tempDir, { recursive: true });
  const outputPath = join(tempDir, `${randomUUID()}-${sanitizeFileName(filename, extension)}`);
  await writeFile(outputPath, content);
  return { kind: 'path', path: outputPath, mimeType, filename };
}

function sanitizeFileName(filename: string, fallbackExtension: 'twb' | 'twbx'): string {
  const cleaned = filename.replace(/[^A-Za-z0-9._ -]/g, '_').trim();
  if (!cleaned) {
    return `workbook.${fallbackExtension}`;
  }
  return cleaned;
}
