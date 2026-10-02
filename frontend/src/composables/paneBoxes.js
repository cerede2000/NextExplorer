import { onUnmounted, ref, watch } from 'vue';
import { useTabsStore } from '@/stores/tabs';

/**
 * Where each pane is on the screen, in pixels.
 *
 * For the two things that are drawn *outside* the page and have to sit on top of
 * it anyway: a document in its viewer, and a shell. Both live above every layout
 * so that they survive their tab going behind another — which is right, and is
 * also why neither of them can be positioned by nesting. With one pane they
 * filled the content area and that was the whole answer. With two, "the content
 * area" is two boxes, and a surface that keeps covering both covers its
 * neighbour.
 *
 * Measured rather than computed: the divider is somewhere the reader put it, the
 * sidebar is a width they chose, and the strip is there or it is not. The panes
 * themselves know all of that because the layout already laid them out.
 */
export const usePaneBoxes = () => {
  const tabsStore = useTabsStore();
  const boxes = ref({});

  let observer = null;

  const measure = () => {
    const next = {};
    for (const element of document.querySelectorAll('[data-pane-tab]')) {
      const id = element.getAttribute('data-pane-tab');
      if (!id) continue;
      const box = element.getBoundingClientRect();
      // A pane with no area is a pane that is not laid out yet; saying nothing
      // leaves whoever asks to fall back rather than drawing a nought-by-nought
      // iframe that some editors never measure again.
      if (box.width <= 0 || box.height <= 0) continue;
      next[id] = {
        top: `${box.top}px`,
        left: `${box.left}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
      };
    }
    boxes.value = next;
  };

  const watchPanes = () => {
    observer?.disconnect();
    if (typeof ResizeObserver !== 'function') return;
    observer = new ResizeObserver(measure);
    for (const element of document.querySelectorAll('[data-pane-tab]')) {
      observer.observe(element);
    }
  };

  const refresh = () => {
    watchPanes();
    measure();
  };

  // Which panes exist changes with the pair the reader is in, and the elements
  // are replaced when it does — so the observer is pointed at the new ones.
  watch(() => tabsStore.panes.join('|'), refresh, { immediate: true, flush: 'post' });

  if (typeof window !== 'undefined') window.addEventListener('resize', measure);

  onUnmounted(() => {
    observer?.disconnect();
    observer = null;
    if (typeof window !== 'undefined') window.removeEventListener('resize', measure);
  });

  /**
   * The box for a tab, or null when it is not on screen.
   *
   * Null rather than a guess: a surface for a tab in no pane is hidden anyway,
   * and a box invented for it would be a box to move it back from later.
   */
  const boxFor = (id) => boxes.value[id] || null;

  return { boxes, boxFor, refresh };
};
