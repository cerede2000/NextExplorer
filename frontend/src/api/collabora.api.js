import { requestJson, normalizePath } from './http';

/** `versionId` opens an earlier version of the file, to be read. */
export async function fetchCollaboraConfig(path, mode = 'edit', { versionId } = {}) {
  const normalizedPath = normalizePath(path || '');
  if (!normalizedPath) throw new Error('Path is required.');

  return requestJson('/api/collabora/config', {
    method: 'POST',
    body: JSON.stringify({ path: normalizedPath, mode, ...(versionId ? { versionId } : {}) }),
  });
}
