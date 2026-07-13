import { onMounted, ref } from 'vue';
import { useFeaturesStore } from '@/stores/features';

export function useConfigErrorGate() {
  const features = useFeaturesStore();
  const configError = ref(null); // { mode: 'mismatch'|'error', expectedOrigin, requestOrigin }

  const dismissConfigWarning = () => {
    if (configError.value?.mode === 'mismatch') {
      configError.value = null;
    }
  };

  onMounted(async () => {
    const requestOrigin = window.location.origin;
    try {
      await features.ensureLoaded();
      const expectedOrigin = features.publicOrigin || '';
      // Accept the public origin AND any configured internal origins (e.g. a LAN
      // IP). Only warn when the current origin matches none of them.
      const acceptedOrigins =
        Array.isArray(features.publicOrigins) && features.publicOrigins.length
          ? features.publicOrigins
          : expectedOrigin
            ? [expectedOrigin]
            : [];
      if (acceptedOrigins.length && !acceptedOrigins.includes(requestOrigin)) {
        configError.value = { mode: 'mismatch', expectedOrigin, requestOrigin };
      }
    } catch (_) {
      configError.value = { mode: 'error', expectedOrigin: '', requestOrigin };
    }
  });

  return { configError, dismissConfigWarning };
}
