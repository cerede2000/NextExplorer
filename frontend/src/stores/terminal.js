import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useTerminalStore = defineStore('terminal', () => {
  const isOpen = ref(false);
  const launchPath = ref('');
  const launchInput = ref('');
  const launchKey = ref(0);

  const open = (cwd = '', initialInput = '') => {
    launchPath.value = typeof cwd === 'string' ? cwd : '';
    launchInput.value = typeof initialInput === 'string' ? initialInput : '';
    launchKey.value += 1;
    isOpen.value = true;
  };

  const close = () => {
    isOpen.value = false;
  };

  const toggle = (cwd = '', initialInput = '') => {
    if (isOpen.value) {
      close();
      return;
    }

    open(cwd, initialInput);
  };

  return {
    isOpen,
    launchPath,
    launchInput,
    launchKey,
    open,
    close,
    toggle,
  };
});
