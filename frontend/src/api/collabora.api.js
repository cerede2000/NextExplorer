import { requestJson, normalizePath } from './http';
import { shareScoped } from './shareScope';

/** `versionId` opens an earlier version of the file, to be read. */
export async function fetchCollaboraConfig(path, mode = 'edit', { versionId } = {}) {
  const normalizedPath = normalizePath(path || '');
  if (!normalizedPath) throw new Error('Path is required.');

  return requestJson(shareScoped('/api/collabora/config', normalizedPath), {
    method: 'POST',
    body: JSON.stringify({ path: normalizedPath, mode, ...(versionId ? { versionId } : {}) }),
  });
}
