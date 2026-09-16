<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps({
  appname: { type: String, default: 'Explorer' },
  logoUrl: { type: String, default: '/logo.svg' },
});

const { t } = useI18n();

const logoSrc = computed(() => {
  const candidate = typeof props.logoUrl === 'string' ? props.logoUrl.trim() : '';
  return candidate || '/logo.svg';
});

// The one piece of the header a screen reader has to be told, and it was the
// English word "logo" whatever language the rest of the page was in.
const logoAlt = computed(() => t('common.logoAlt', { name: props.appname }));
</script>

<template>
  <router-link to="/" class="flex items-center gap-2 text-2xl font-bold">
    <img :src="logoSrc" class="h-10" :alt="logoAlt" />

    {{ props.appname }}
  </router-link>
</template>
