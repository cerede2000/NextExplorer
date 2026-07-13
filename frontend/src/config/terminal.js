import { computed } from 'vue';
import { useFeaturesStore } from '@/stores/features';

const normalizeExtension = (extension = '') =>
  String(extension || '')
    .trim()
    .toLowerCase()
    .replace(/^\./, '');

const terminalExtensionsSet = computed(() => {
  const featuresStore = useFeaturesStore();
  const runtimeExtensions = Array.isArray(featuresStore.terminalExtensions)
    ? featuresStore.terminalExtensions
    : [];
  return new Set(runtimeExtensions.map(normalizeExtension).filter(Boolean));
});

const isTerminalExtension = (extension = '') => {
  const normalized = normalizeExtension(extension);
  if (!normalized) return false;
  return terminalExtensionsSet.value.has(normalized);
};

export { isTerminalExtension };
