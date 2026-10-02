import { onUnmounted, ref, watch } from 'vue';
import { useTabsStore } from '@/stores/tabs';

/**
 * Where each pane is on the screen, in pixels, said by the pane itself.
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
 * sidebar is a width they chose, and the strip is there or it is not. The pane
 * knows all of that, because the layout has already laid it out.
 *
 * Said by the pane and not asked for by the surface, which is the correction
 * that matters here. The surfaces used to go looking for `[data-pane-tab]`
 * elements when the panes changed — and on a window that *opens* split, they
 * looked before the page existed, found nothing, and nothing ever looked again:
 * every document and every shell covered the whole window, over the screen
 * beside it, for as long as the page lived. A pane cannot exist without
 * reporting, so there is no longer a moment to miss.
 */
const boxes = ref({});

/** In the shape they are read in, which is four CSS lengths. */
const measure = (element) => {
  const box = element.getBoundingClientRect();
  // A pane with no area is a pane that is not laid out yet, mid-swap or
  // mid-mount: what it had stands, rather than a nought-by-nought box that some
  // editors never measure their way out of.
  if (box.width <= 0 || box.height <= 0) return null;
  return {
    top: `${box.top}px`,
    left: `${box.left}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
  };
};

const unchanged = (before, now) =>
  Boolean(before) &&
  before.top === now.top &&
  before.left === now.left &&
  before.width === now.width &&
  before.height === now.height;

/**
 * A pane saying where it is: when it is laid out, and whenever it moves or is
 * resized.
 *
 * @param {import('vue').Ref<string>} tabId the tab this pane is holding
 * @param {import('vue').Ref<HTMLElement|null>} element the pane itself
 */
export const useReportsPaneBox = (tabId, element) => {
  const tabsStore = useTabsStore();
  let observer = null;

  const tell = () => {
    const node = element.value;
    if (!node) return;
    const box = measure(node);
    if (!box) return;
    const id = tabId.value;
    if (!id || unchanged(boxes.value[id], box)) return;
    boxes.value = { ...boxes.value, [id]: box };
  };

  watch(
    element,
    (node) => {
      observer?.disconnect();
      observer = null;
      if (!node) return;
      tell();
      if (typeof ResizeObserver !== 'function') return;
      observer = new ResizeObserver(tell);
      observer.observe(node);
    },
    { immediate: true, flush: 'post' }
  );

  // The same element can be given another tab — that is what swapping the halves
  // of a pair is — and the box then belongs to the tab it holds now.
  watch(tabId, tell, { flush: 'post' });

  // A pane can be moved without being resized, and a resize observer says nothing
  // about that.
  if (typeof window !== 'undefined') window.addEventListener('resize', tell);

  onUnmounted(() => {
    observer?.disconnect();
    observer = null;
    if (typeof window !== 'undefined') window.removeEventListener('resize', tell);
    // Only what has left the screen is forgotten. Mid-swap this element is
    // replaced by another one holding the same tab, and a box dropped for that
    // frame leaves a document with nowhere to be — the whole window is the only
    // placement left to it, and it stays there.
    const id = tabId.value;
    if (!id || tabsStore.panes.includes(id)) return;
    const next = { ...boxes.value };
    delete next[id];
    boxes.value = next;
  });
};

/**
 * Where the panes are, for whatever is drawn over them.
 *
 * `boxFor` answers null for a tab that has no pane: a surface for a tab in no
 * pane is hidden anyway, and a box invented for it would be a box to move it
 * back from later.
 */
export const usePaneBoxes = () => ({
  boxes,
  boxFor: (id) => boxes.value[id] || null,
});
