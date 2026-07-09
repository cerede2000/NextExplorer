import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useTerminalStore = defineStore('terminal', () => {
  const isOpen = ref(false);
  const launchPath = ref('');

  const open = (cwd = '') => {
    launchPath.value = typeof cwd === 'string' ? cwd : '';
    isOpen.value = true;
  };

  const close = () => {
    isOpen.value = false;
  };

  const toggle = (cwd = '') => {
    if (isOpen.value) {
      close();
      return;
    }

    open(cwd);
  };

  return {
    isOpen,
    launchPath,
    open,
    close,
    toggle,
  };
});
