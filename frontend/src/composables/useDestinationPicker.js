import { ref } from 'vue';

/**
 * Shared state for the "Move to" / "Copy to" dialog.
 *
 * The dialog outlives the menu that asks for it — a context menu closes the
 * moment something is clicked — so it is mounted once with the layout and
 * opened from anywhere through this. Singleton for the same reason the favorite
 * editor is one: two of these on screen would be two answers to one question.
 */

let instance = null;

export function useDestinationPicker() {
  if (instance) return instance;

  const isOpen = ref(false);
  const mode = ref('move');
  const items = ref([]);
  const initialPath = ref('');
  let resolveChoice = null;

  /**
   * Ask where to put things.
   *
   * @returns {Promise<string|null>} The chosen folder, or null if the person
   *   closed the dialog — which callers must treat as "do nothing", not as an
   *   error and not as the root folder.
   */
  const pick = ({ mode: requestedMode = 'move', items: requestedItems = [], from = '' } = {}) => {
    // A second request replaces the first rather than queueing behind it; the
    // earlier caller is told nothing was chosen.
    resolveChoice?.(null);

    mode.value = requestedMode === 'copy' ? 'copy' : 'move';
    items.value = Array.isArray(requestedItems) ? requestedItems : [];
    initialPath.value = from || '';
    isOpen.value = true;

    return new Promise((resolve) => {
      resolveChoice = resolve;
    });
  };

  const choose = (path) => {
    const resolver = resolveChoice;
    resolveChoice = null;
    isOpen.value = false;
    resolver?.(path || null);
  };

  /** Closing without choosing has to settle the promise too. */
  const dismiss = () => {
    const resolver = resolveChoice;
    resolveChoice = null;
    resolver?.(null);
  };

  instance = { isOpen, mode, items, initialPath, pick, choose, dismiss };
  return instance;
}
