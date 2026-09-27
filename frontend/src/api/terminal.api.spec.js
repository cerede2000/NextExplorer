import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The terminal session request. The server issues a short-lived token for a
 * shell started in the folder the admin was looking at; a folder that does not
 * travel opens the shell somewhere else, which on a file server is the one
 * place a surprise costs the most.
 */

const { requestJson } = vi.hoisted(() => ({ requestJson: vi.fn(async () => ({})) }));

vi.mock('./http', async (importOriginal) => ({
  ...(await importOriginal()),
  requestJson,
}));

const api = await import('./terminal.api');

const call = () => {
  const [endpoint, options] = requestJson.mock.calls.at(-1);
  return {
    endpoint,
    method: options?.method,
    body: options?.body ? JSON.parse(options.body) : null,
  };
};

beforeEach(() => {
  requestJson.mockClear();
});

describe('the terminal API', () => {
  it('asks for a session started in the folder being viewed', async () => {
    await api.createTerminalSession('Projects/site');

    expect(call()).toEqual({
      endpoint: '/api/terminal/session',
      method: 'POST',
      body: { cwd: 'Projects/site' },
    });
  });

  it('asks for a session in the default place when no folder is given', async () => {
    await api.createTerminalSession();

    expect(call().body).toEqual({ cwd: '' });
  });
});
