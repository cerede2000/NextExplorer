import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The ONLYOFFICE plugin decides two things the editor component cannot.
 *
 * Which documents it opens. When both office editors are configured, each of
 * them claiming the same file would leave the choice to registration order, so
 * exactly one of them has to answer: the one the user prefers.
 *
 * And what happens on the way out. The close hook is the last chance to save
 * what was typed since the last automatic save. It has to name the file as it
 * is called now — it may have been renamed from the editor's title bar — must
 * not hold the preview open behind a slow Document Server, and must release the
 * editing session whether the save went through or not, or the document stays
 * marked as being edited.
 */

const requestOnlyOfficeForceSave = vi.fn();
const closeOnlyOfficeSession = vi.fn();
const features = { onlyofficeEnabled: true, collaboraEnabled: false };
const settings = { officeEditorPreference: 'onlyoffice' };

vi.mock('@/api', () => ({
  requestOnlyOfficeForceSave: (...args) => requestOnlyOfficeForceSave(...args),
  closeOnlyOfficeSession: (...args) => closeOnlyOfficeSession(...args),
}));
vi.mock('@/stores/features', () => ({ useFeaturesStore: () => features }));
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => settings }));

import { onlyofficePreviewPlugin } from './onlyofficePreview';
import { collaboraPreviewPlugin } from '@/plugins/collabora/collaboraPreview';

beforeEach(() => {
  Object.assign(features, { onlyofficeEnabled: true, collaboraEnabled: false });
  settings.officeEditorPreference = 'onlyoffice';
  requestOnlyOfficeForceSave.mockReset();
  requestOnlyOfficeForceSave.mockResolvedValue({ queued: true });
  closeOnlyOfficeSession.mockReset();
  closeOnlyOfficeSession.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('which documents ONLYOFFICE opens', () => {
  it('opens the formats the server lists, whatever the case of the extension', () => {
    const plugin = onlyofficePreviewPlugin(['docx', 'xlsx']);

    expect(plugin.match({ extension: 'DOCX' })).toBe(true);
    expect(plugin.match({ extension: 'xlsx' })).toBe(true);
    // Known to ONLYOFFICE, but not offered by this server.
    expect(plugin.match({ extension: 'pptx' })).toBe(false);
    expect(plugin.match({ extension: '' })).toBe(false);
  });

  it('falls back to the office formats when the server lists none', () => {
    for (const extensions of [undefined, []]) {
      const plugin = onlyofficePreviewPlugin(extensions);

      for (const extension of ['docx', 'doc', 'odt', 'rtf', 'xlsx', 'ods', 'csv', 'pptx', 'odp']) {
        expect(plugin.match({ extension })).toBe(true);
      }
      // Plain text is left to the text editor, and a PDF to the PDF viewer.
      expect(plugin.match({ extension: 'txt' })).toBe(false);
      expect(plugin.match({ extension: 'pdf' })).toBe(false);
    }
  });

  it('opens its formats whatever the preference when it is the only editor configured', () => {
    settings.officeEditorPreference = 'collabora';

    expect(onlyofficePreviewPlugin().match({ extension: 'docx' })).toBe(true);
  });

  it('shares documents with Collabora so that exactly one editor claims each, the one preferred', () => {
    Object.assign(features, { onlyofficeEnabled: true, collaboraEnabled: true });
    const onlyoffice = onlyofficePreviewPlugin();
    const collabora = collaboraPreviewPlugin();

    for (const preference of ['onlyoffice', 'collabora', undefined]) {
      settings.officeEditorPreference = preference;
      const claims = {
        onlyoffice: onlyoffice.match({ extension: 'docx' }),
        collabora: collabora.match({ extension: 'docx' }),
      };

      // No preference recorded yet keeps ONLYOFFICE, as before Collabora existed.
      expect(claims).toEqual({
        onlyoffice: preference !== 'collabora',
        collabora: preference === 'collabora',
      });
    }
  });
});

describe('closing ONLYOFFICE', () => {
  const RENAMED = 'Docs/Report final.docx';

  const contextFor = (previewState) => ({ filePath: 'Docs/report.docx', previewState });

  it('saves and releases the session under the name the document has now', async () => {
    const requestForceSave = vi.fn(() => Promise.resolve({ queued: true }));
    const context = contextFor({
      forceSaveSessionId: 'session-1',
      documentPath: RENAMED,
      requestForceSave,
    });

    await onlyofficePreviewPlugin().onBeforeClose(context);

    // The editor's own request, so that it cancels the pending automatic save
    // and is never sent alongside one already in flight.
    expect(requestForceSave).toHaveBeenCalledWith({ reason: 'close' });
    expect(requestOnlyOfficeForceSave).not.toHaveBeenCalled();
    expect(closeOnlyOfficeSession).toHaveBeenCalledWith(RENAMED, { sessionId: 'session-1' });
  });

  it('asks the server itself, under the current name, when the editor offers no save of its own', async () => {
    const context = contextFor({ forceSaveSessionId: 'session-1', documentPath: RENAMED });

    await onlyofficePreviewPlugin().onBeforeClose(context);

    expect(requestOnlyOfficeForceSave).toHaveBeenCalledWith(RENAMED, {
      sessionId: 'session-1',
      reason: 'close',
    });
    expect(closeOnlyOfficeSession).toHaveBeenCalledWith(RENAMED, { sessionId: 'session-1' });
  });

  it('names the file the preview was opened on when the document was never renamed', async () => {
    await onlyofficePreviewPlugin().onBeforeClose(contextFor({ forceSaveSessionId: 'session-1' }));

    expect(requestOnlyOfficeForceSave).toHaveBeenCalledWith('Docs/report.docx', {
      sessionId: 'session-1',
      reason: 'close',
    });
    expect(closeOnlyOfficeSession).toHaveBeenCalledWith('Docs/report.docx', {
      sessionId: 'session-1',
    });
  });

  it('waits for a save that hangs no longer than its grace period, then releases the session', async () => {
    vi.useFakeTimers();
    const context = contextFor({
      forceSaveSessionId: 'session-1',
      documentPath: RENAMED,
      requestForceSave: () => new Promise(() => {}),
    });

    let closed = false;
    void onlyofficePreviewPlugin()
      .onBeforeClose(context)
      .then(() => {
        closed = true;
      });

    await vi.advanceTimersByTimeAsync(449);
    expect(closed).toBe(false);
    expect(closeOnlyOfficeSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(closed).toBe(true);
    expect(closeOnlyOfficeSession).toHaveBeenCalledWith(RENAMED, { sessionId: 'session-1' });
  });

  it('lets the preview close as soon as the save is accepted, without sitting out the grace period', async () => {
    vi.useFakeTimers();
    const context = contextFor({
      forceSaveSessionId: 'session-1',
      requestForceSave: () => Promise.resolve({ queued: true }),
    });

    // No timer is advanced: only the accepted save can settle the hook.
    await expect(onlyofficePreviewPlugin().onBeforeClose(context)).resolves.toBeUndefined();
    expect(closeOnlyOfficeSession).toHaveBeenCalledTimes(1);
  });

  it('releases the session even when the save fails, and still lets the preview close', async () => {
    const context = contextFor({
      forceSaveSessionId: 'session-1',
      requestForceSave: vi.fn().mockRejectedValue(new Error('Document Server unreachable')),
    });

    await expect(onlyofficePreviewPlugin().onBeforeClose(context)).resolves.toBeUndefined();
    expect(context.previewState.requestForceSave).toHaveBeenCalled();
    expect(closeOnlyOfficeSession).toHaveBeenCalledWith('Docs/report.docx', {
      sessionId: 'session-1',
    });
  });

  it('does not surface a session that could not be released', async () => {
    closeOnlyOfficeSession.mockRejectedValue(new Error('offline'));
    const context = contextFor({ forceSaveSessionId: 'session-1' });

    await expect(onlyofficePreviewPlugin().onBeforeClose(context)).resolves.toBeUndefined();
    expect(closeOnlyOfficeSession).toHaveBeenCalledTimes(1);
  });

  it('sends nothing for a preview that never had an editing session', async () => {
    const plugin = onlyofficePreviewPlugin();

    await plugin.onBeforeClose(contextFor({}));
    await plugin.onBeforeClose({ previewState: { forceSaveSessionId: 'session-1' } });

    expect(requestOnlyOfficeForceSave).not.toHaveBeenCalled();
    expect(closeOnlyOfficeSession).not.toHaveBeenCalled();
  });
});
