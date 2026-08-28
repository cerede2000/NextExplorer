import { beforeEach, describe, expect, it, vi } from 'vitest';

const push = vi.fn();
const previewOpen = vi.fn(() => true);
let userSettings = {};

vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back: vi.fn(), forward: vi.fn() }),
  useRoute: () => ({ params: { path: 'Notes' } }),
}));

vi.mock('@/utils', () => ({ withViewTransition: (fn) => fn }));

vi.mock('@/plugins/preview/manager', () => ({
  usePreviewManager: () => ({ open: (...args) => previewOpen(...args) }),
}));

vi.mock('@/stores/appSettings', () => ({
  useAppSettings: () => ({
    get userSettings() {
      return userSettings;
    },
  }),
}));

vi.mock('@/config/editor', () => ({
  isEditableExtension: (ext) => ['md', 'markdown', 'txt'].includes(ext),
}));

import { useNavigation } from './navigation';

const markdown = { kind: 'md', name: 'notes.md', path: 'Notes' };

describe('opening a markdown file', () => {
  beforeEach(() => {
    push.mockClear();
    previewOpen.mockClear();
    previewOpen.mockReturnValue(true);
    userSettings = {};
  });

  // The default is unchanged: preview first, with an Edit button in it.
  it('shows the preview by default', () => {
    useNavigation().openItem(markdown);

    expect(previewOpen).toHaveBeenCalledWith(markdown);
    expect(push).not.toHaveBeenCalled();
  });

  it('goes straight to the editor when the preference is set', () => {
    userSettings = { markdownOpensInEditor: true };

    useNavigation().openItem(markdown);

    expect(previewOpen).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith({ path: '/editor/Notes/notes.md' });
  });

  it('treats a .markdown file the same way', () => {
    userSettings = { markdownOpensInEditor: true };

    useNavigation().openItem({ kind: 'markdown', name: 'notes.markdown', path: 'Notes' });

    expect(previewOpen).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith({ path: '/editor/Notes/notes.markdown' });
  });

  // The preference is about markdown, which is the only kind of file with both
  // a preview and an editor. An image has nowhere else to go.
  it('leaves other files on preview-first', () => {
    userSettings = { markdownOpensInEditor: true };
    const image = { kind: 'png', name: 'photo.png', path: 'Notes' };

    useNavigation().openItem(image);

    expect(previewOpen).toHaveBeenCalledWith(image);
    expect(push).not.toHaveBeenCalled();
  });

  // A folder is navigation, not a document: the preference must not touch it.
  it('still opens folders as folders', () => {
    userSettings = { markdownOpensInEditor: true };

    useNavigation().openItem({ kind: 'directory', name: 'Archive', path: 'Notes' });

    expect(previewOpen).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith({ name: 'FolderView', params: { path: 'Notes/Archive' } });
  });

  // Where no preview plugin matches, the editor was already the destination —
  // the preference changes nothing for those.
  it('falls through to the editor when nothing can preview the file', () => {
    previewOpen.mockReturnValue(false);

    useNavigation().openItem({ kind: 'txt', name: 'notes.txt', path: 'Notes' });

    expect(push).toHaveBeenCalledWith({ path: '/editor/Notes/notes.txt' });
  });
});
