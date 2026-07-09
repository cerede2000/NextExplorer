import { requestJson } from './http';

// Issue a short-lived terminal session token (admin only)
export async function createTerminalSession(cwd = '') {
  return requestJson('/api/terminal/session', {
    method: 'POST',
    body: JSON.stringify({ cwd }),
  });
}
