<script setup>
import { computed } from 'vue';
import ModalDialog from '@/components/ModalDialog.vue';
import { useOnlyOfficeTransferConfirm } from '@/composables/useOnlyOfficeTransferConfirm';

const { isOpen, activeItems, pendingAction, cancel, confirm } = useOnlyOfficeTransferConfirm();

const itemLabel = computed(() => {
  const names = activeItems.value
    .slice(0, 2)
    .map((item) => item.name)
    .join(', ');
  const remaining = activeItems.value.length - Math.min(activeItems.value.length, 2);
  return `${names}${remaining > 0 ? ` et ${remaining} autre(s)` : ''}`;
});
</script>

<template>
  <ModalDialog :model-value="isOpen" @update:model-value="(open) => !open && cancel()">
    <template #title>Fichier en cours d'édition</template>
    <p class="mb-4 text-base text-zinc-700 dark:text-zinc-200">
      {{ itemLabel }} {{ activeItems.length > 1 ? 'sont ouverts' : 'est ouvert' }} dans OnlyOffice.
    </p>
    <p class="mb-6 text-sm text-amber-800 dark:text-amber-200">
      {{ pendingAction }} peut perturber une sauvegarde en cours. Voulez-vous continuer ?
    </p>
    <div class="flex justify-end gap-3">
      <button
        type="button"
        class="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-700"
        @click="cancel"
      >
        Annuler
      </button>
      <button
        type="button"
        class="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-500 dark:bg-amber-500 dark:hover:bg-amber-400"
        @click="confirm"
      >
        Continuer
      </button>
    </div>
  </ModalDialog>
</template>
