<script setup>
import { computed } from 'vue';
import { onKeyStroke } from '@vueuse/core';
import { TransitionRoot, TransitionChild } from '@headlessui/vue';
import {
  ExclamationTriangleIcon,
  XMarkIcon,
  ArrowTopRightOnSquareIcon,
  LifebuoyIcon,
} from '@heroicons/vue/24/outline';

const props = defineProps({
  expectedOrigin: {
    type: String,
    default: '',
  },
  requestOrigin: {
    type: String,
    default: '',
  },
});

const emit = defineEmits(['dismiss']);

const corsDocsUrl = 'https://github.com/vikramsoni2/nextExplorer/blob/main/docs/reference/cors.md';

const configuredUrl = computed(() => {
  if (!props.expectedOrigin) {
    return '';
  }

  try {
    return new URL(
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
      props.expectedOrigin
    ).toString();
  } catch (_) {
    return props.expectedOrigin;
  }
});

const dismiss = () => emit('dismiss');

onKeyStroke('Escape', dismiss);
</script>

<template>
  <Teleport to="body">
    <TransitionRoot appear :show="true" as="template">
      <div class="relative z-[90]" role="dialog" aria-modal="true" aria-labelledby="config-warning-title">
        <TransitionChild
          as="template"
          enter="ease-out duration-200"
          enter-from="opacity-0"
          enter-to="opacity-100"
          leave="ease-in duration-150"
          leave-from="opacity-100"
          leave-to="opacity-0"
        >
          <div class="fixed inset-0 bg-black/30 backdrop-blur-xs dark:bg-black/50" @click="dismiss" />
        </TransitionChild>

        <div class="fixed inset-0 overflow-y-auto px-4 py-6 sm:px-6 sm:py-10">
          <div class="flex min-h-full items-center justify-center">
            <TransitionChild
              as="template"
              enter="ease-out duration-200"
              enter-from="translate-y-4 opacity-0 sm:translate-y-0 sm:scale-95"
              enter-to="translate-y-0 opacity-100 sm:scale-100"
              leave="ease-in duration-150"
              leave-from="translate-y-0 opacity-100 sm:scale-100"
              leave-to="translate-y-4 opacity-0 sm:translate-y-0 sm:scale-95"
            >
              <div
                class="relative w-full max-w-2xl overflow-hidden rounded-2xl border border-neutral-200/80 bg-white/95 shadow-2xl ring-1 ring-black/10 backdrop-blur-md dark:border-white/10 dark:bg-zinc-900/90 dark:ring-white/10"
              >
                <div class="border-b border-neutral-200/80 px-5 py-4 dark:border-white/10 sm:px-6">
                  <div class="flex items-start gap-4">
                    <div
                      class="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-amber-100 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-400/20"
                    >
                      <ExclamationTriangleIcon class="h-6 w-6" />
                    </div>

                    <div class="min-w-0 flex-1">
                      <div
                        class="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-300"
                      >
                        Configuration warning
                      </div>
                      <h2
                        id="config-warning-title"
                        class="mt-3 text-lg font-semibold tracking-tight text-neutral-900 dark:text-neutral-100 sm:text-xl"
                      >
                        `PUBLIC_URL` does not match this domain
                      </h2>
                      <p class="mt-2 max-w-xl text-sm leading-6 text-neutral-600 dark:text-neutral-300">
                        You can keep using the app, but sign-in, cookies, sharing links, and callback-based
                        flows may be unreliable until the public URL matches the domain you opened.
                      </p>
                    </div>

                    <button
                      type="button"
                      class="inline-flex rounded-lg p-1.5 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-neutral-200"
                      :aria-label="$t('common.dismissWarning')"
                      @click="dismiss"
                    >
                      <XMarkIcon class="h-5 w-5" />
                    </button>
                  </div>
                </div>

                <div class="space-y-4 px-5 py-5 sm:px-6">
                  <div class="grid gap-3 sm:grid-cols-2">
                    <div
                      class="rounded-xl border border-neutral-200 bg-neutral-50/80 p-4 dark:border-white/10 dark:bg-white/[0.03]"
                    >
                      <div class="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-400">
                        Opened from
                      </div>
                      <div class="mt-2 font-mono text-[13px] break-all text-neutral-900 dark:text-neutral-100">
                        {{ props.requestOrigin }}
                      </div>
                    </div>

                    <div
                      class="rounded-xl border border-amber-200 bg-amber-50/80 p-4 dark:border-amber-400/20 dark:bg-amber-500/10"
                    >
                      <div class="text-xs font-semibold uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">
                        Server expects
                      </div>
                      <div class="mt-2 font-mono text-[13px] break-all text-amber-950 dark:text-amber-100">
                        {{ props.expectedOrigin }}
                      </div>
                    </div>
                  </div>

                  <div
                    class="rounded-xl border border-neutral-200 bg-neutral-50/80 p-4 text-sm text-neutral-600 dark:border-white/10 dark:bg-white/[0.03] dark:text-neutral-300"
                  >
                    <div class="font-medium text-neutral-900 dark:text-neutral-100">Admin fix</div>
                    <p class="mt-1 leading-6">
                      If this domain is intended, update
                      <span class="font-mono text-[13px]">PUBLIC_URL={{ props.requestOrigin }}</span>
                      on the server and restart the app.
                    </p>
                  </div>
                </div>

                <div
                  class="flex flex-col-reverse gap-3 border-t border-neutral-200/80 bg-neutral-50/80 px-5 py-4 dark:border-white/10 dark:bg-white/[0.03] sm:flex-row sm:items-center sm:justify-between sm:px-6"
                >
                  <a
                    :href="corsDocsUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-2 text-sm font-medium text-neutral-600 transition hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
                  >
                    <LifebuoyIcon class="h-4 w-4" />
                    Read configuration docs
                  </a>

                  <div class="flex flex-col gap-3 sm:flex-row">
                    <a
                      v-if="configuredUrl"
                      :href="configuredUrl"
                      class="inline-flex items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-sm font-medium text-neutral-800 transition hover:bg-neutral-100 dark:border-white/10 dark:bg-white/5 dark:text-neutral-100 dark:hover:bg-white/10"
                    >
                      <ArrowTopRightOnSquareIcon class="h-4 w-4" />
                      Open configured URL
                    </a>
                    <button
                      type="button"
                      class="inline-flex items-center justify-center rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-amber-500 active:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-400"
                      @click="dismiss"
                    >
                      Continue anyway
                    </button>
                  </div>
                </div>
              </div>
            </TransitionChild>
          </div>
        </div>
      </div>
    </TransitionRoot>
  </Teleport>
</template>
