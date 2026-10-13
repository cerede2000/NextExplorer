<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ModalDialog from '@/components/ModalDialog.vue';

/**
 * Name a new document before it exists.
 *
 * Everything else here creates a file first and renames it in the list, which
 * works because the file stays in view. A document created here opens straight
 * into an editor covering the whole window, so the rename box would be behind it
 * — the name has to be settled first.
 *
 * The extension is editable where the format has no template, which is what
 * `chooseExtension` says. The menu's three text entries were three of the fifty
 * extensions the editor opens, so anything else had to be made as a `.txt` and
 * renamed; an empty file is an empty file whatever it is called, so the
 * extension is a field. Where there *is* a template it is shown and fixed: the
 * bytes are an OOXML package or a PDF, and a name that disagrees with them is a
 * file no editor opens.
 */

const props = defineProps({
  modelValue: Boolean,
  /** 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'txt' | 'md' */
  format: { type: String, default: 'docx' },
  title: { type: String, default: '' },
  defaultName: { type: String, default: '' },
  /** Whether the extension is this reader's to type, or the format's to keep. */
  chooseExtension: Boolean,
});

const emit = defineEmits(['update:modelValue', 'create']);
const { t } = useI18n();

const isOpen = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
});

const name = ref('');
const extension = ref('');
const inputRef = ref(null);
const isSubmitting = ref(false);

const canSubmit = computed(() => name.value.trim().length > 0 && !isSubmitting.value);

/** What the document will be called, shown under the fields as it is typed. */
const willBeCalled = computed(() => {
  const base = name.value.trim() || props.defaultName;
  const asked = props.chooseExtension ? extension.value.trim().replace(/^\.+/, '') : props.format;
  if (!asked) return base;
  return base.toLowerCase().endsWith(`.${asked.toLowerCase()}`) ? base : `${base}.${asked}`;
});

/**
 * Hand the name back, saying whether the document is to be opened as well.
 *
 * `open` travels with the name rather than being the caller's own business: it
 * is the button that was pressed, and only this dialog knows which one that
 * was. Enter is the form's own submit, which is the opening one — the gesture
 * of somebody who typed a name and wants to start writing.
 */
const submit = async ({ open = true } = {}) => {
  if (!canSubmit.value) return;
  isSubmitting.value = true;
  try {
    emit('create', {
      format: props.format,
      name: name.value.trim(),
      // Only where it was this reader's to choose. Left out, the server keeps
      // the format's own — and an empty one here means no extension at all.
      ...(props.chooseExtension ? { extension: extension.value.trim() } : {}),
      open,
    });
    isOpen.value = false;
  } finally {
    isSubmitting.value = false;
  }
};

watch(
  () => props.modelValue,
  async (opened) => {
    if (!opened) return;
    name.value = props.defaultName;
    extension.value = props.format;
    await nextTick();
    // Selected rather than given a caret: the default name is a suggestion, and
    // typing over it is what most people do next.
    inputRef.value?.focus();
    inputRef.value?.select();
  }
);
</script>

<template>
  <ModalDialog v-model="isOpen">
    <template #title>{{ title }}</template>

    <form class="flex flex-col gap-4" @submit.prevent="submit({ open: true })">
      <div class="flex items-end gap-2">
        <label class="flex min-w-0 flex-1 flex-col gap-1">
          <span class="text-xs text-neutral-500 dark:text-neutral-400">
            {{ t('create.documentName') }}
          </span>
          <input
            ref="inputRef"
            v-model="name"
            type="text"
            class="min-w-0 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-neutral-600 dark:bg-zinc-800"
            :placeholder="defaultName"
          />
        </label>

        <!--
          The extension is a field where the format has no template, and a
          fixed label where it has one. Both sit on the name's baseline so the
          two read as one filename rather than as two questions.
        -->
        <label v-if="chooseExtension" class="flex w-28 shrink-0 flex-col gap-1">
          <span class="text-xs text-neutral-500 dark:text-neutral-400">
            {{ t('create.documentExtension') }}
          </span>
          <span class="flex items-center gap-1">
            <span class="shrink-0 text-sm text-neutral-500 dark:text-neutral-400">.</span>
            <!--
              No placeholder: the field arrives holding the format, and an empty
              one is a request rather than a gap — a greyed `txt` behind it would
              promise an extension the file is not going to get.
            -->
            <input
              v-model="extension"
              type="text"
              data-test="document-extension"
              spellcheck="false"
              autocapitalize="off"
              class="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-neutral-600 dark:bg-zinc-800"
            />
          </span>
        </label>
        <span v-else class="shrink-0 pb-2 text-sm text-neutral-500 dark:text-neutral-400">
          .{{ format }}
        </span>
      </div>

      <p
        class="truncate text-xs text-neutral-500 dark:text-neutral-400"
        data-test="document-will-be-called"
      >
        {{ willBeCalled }}
      </p>

      <!--
        Two ways out, because naming a document and writing it are two separate
        wants. One button did both and promised both, and the document it
        promised to open never appeared for a .txt, a .md or a .csv — so what it
        looked like it did was nothing but create. Now the choice is said out
        loud: leave it in the folder, or go and write it.
      -->
      <div class="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-zinc-800"
          @click="isOpen = false"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          data-test="create-only"
          class="rounded-md border border-blue-600 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-60 dark:border-blue-400 dark:text-blue-300 dark:hover:bg-blue-500/10"
          :disabled="!canSubmit"
          @click="submit({ open: false })"
        >
          {{ t('common.create') }}
        </button>
        <button
          type="submit"
          data-test="create-and-open"
          class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60"
          :disabled="!canSubmit"
        >
          {{ t('create.createAndOpen') }}
        </button>
      </div>
    </form>
  </ModalDialog>
</template>
