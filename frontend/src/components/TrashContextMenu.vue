<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/vue';

/**
 * The right-click menu of the trash.
 *
 * Its own, and small: the explorer's menu is bound to the explorer's selection
 * and dialogs, and what a deleted item offers is different anyway — open, read,
 * restore, restore elsewhere, delete for good. The page says which entries
 * there are; this only shows them and says which one was chosen.
 *
 * Opened at the pointer, or where a long press landed, it stays inside the
 * window, and closes on a click outside, on Escape, on Tab, or once an entry is
 * chosen. It can be driven from the keyboard: the first entry takes the focus,
 * the arrows, Home and End move between entries, and Enter chooses.
 */

const props = defineProps({
  open: { type: Boolean, default: false },
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  /** Groups of entries, separated by a rule: `[[{ id, label, icon?, danger?, disabled? }]]`. */
  sections: { type: Array, default: () => [] },
  label: { type: String, default: '' },
});

const emit = defineEmits(['select', 'close']);

const referenceRef = ref(null);
const floatingRef = ref(null);
let focusBefore = null;

const { floatingStyles, update } = useFloating(referenceRef, floatingRef, {
  placement: 'right-start',
  strategy: 'fixed',
  middleware: [offset(4), flip(), shift({ padding: 8 })],
  whileElementsMounted: autoUpdate,
});

const visibleSections = computed(() =>
  props.sections.filter((section) => Array.isArray(section) && section.length > 0)
);

const menuItems = () =>
  floatingRef.value
    ? [...floatingRef.value.querySelectorAll('[role="menuitem"]:not([disabled])')]
    : [];

const close = () => emit('close');

const choose = (entry) => {
  if (entry.disabled) return;
  close();
  emit('select', entry.id);
};

const moveFocus = (step) => {
  const entries = menuItems();
  if (entries.length === 0) return;
  const current = entries.indexOf(document.activeElement);
  const next = current < 0 ? 0 : (current + step + entries.length) % entries.length;
  entries[next].focus();
};

const onKeydown = (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveFocus(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveFocus(-1);
  } else if (event.key === 'Home') {
    event.preventDefault();
    menuItems()[0]?.focus();
  } else if (event.key === 'End') {
    event.preventDefault();
    menuItems().at(-1)?.focus();
  } else if (event.key === 'Tab') {
    close();
  }
};

const onWindowPointerDown = (event) => {
  if (!props.open) return;
  if (floatingRef.value?.contains(event.target)) return;
  close();
};

const onWindowKeydown = (event) => {
  if (props.open && event.key === 'Escape') close();
};

const onWindowResize = () => {
  if (props.open) close();
};

watch(
  () => [props.open, props.x, props.y],
  async ([open]) => {
    if (!open) {
      // Back to where the keyboard was, if that is still on the page.
      if (focusBefore?.isConnected) focusBefore.focus?.();
      focusBefore = null;
      return;
    }
    focusBefore = focusBefore || document.activeElement;
    await nextTick();
    update?.();
    menuItems()[0]?.focus();
  },
  { immediate: true }
);

onMounted(() => {
  window.addEventListener('pointerdown', onWindowPointerDown, true);
  window.addEventListener('keydown', onWindowKeydown);
  window.addEventListener('resize', onWindowResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onWindowPointerDown, true);
  window.removeEventListener('keydown', onWindowKeydown);
  window.removeEventListener('resize', onWindowResize);
});
</script>

<template>
  <teleport to="body">
    <template v-if="open">
      <div
        ref="referenceRef"
        class="pointer-events-none fixed h-0 w-0"
        :style="{ left: `${x}px`, top: `${y}px` }"
      ></div>
      <div
        ref="floatingRef"
        role="menu"
        :aria-label="label"
        data-test="trash-context-menu"
        class="z-[1600] min-w-[220px] rounded-xl border border-zinc-200 bg-white/95 py-1 shadow-2xl backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95"
        :style="floatingStyles"
        @contextmenu.prevent
        @keydown="onKeydown"
      >
        <template v-for="(section, index) in visibleSections" :key="index">
          <div
            v-if="index > 0"
            role="separator"
            class="my-1 h-px bg-zinc-300/50 dark:bg-zinc-700/50"
          ></div>
          <button
            v-for="entry in section"
            :key="entry.id"
            type="button"
            role="menuitem"
            :data-menu-item="entry.id"
            :disabled="entry.disabled"
            :class="[
              'flex w-full items-center gap-3 px-3 py-2 text-left text-sm outline-none transition-colors hover:bg-zinc-100 focus-visible:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-800 dark:focus-visible:bg-zinc-800',
              entry.danger ? 'text-red-600 dark:text-red-400' : 'text-zinc-800 dark:text-zinc-100',
            ]"
            @click="choose(entry)"
          >
            <component
              :is="entry.icon"
              v-if="entry.icon"
              class="h-4 w-4 shrink-0 opacity-80"
              aria-hidden="true"
            />
            <span>{{ entry.label }}</span>
          </button>
        </template>
      </div>
    </template>
  </teleport>
</template>
