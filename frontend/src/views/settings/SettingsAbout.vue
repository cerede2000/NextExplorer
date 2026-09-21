<script setup>
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFeaturesStore } from '@/stores/features';
import { useAuthStore } from '@/stores/auth';
import { fetchCapabilities } from '@/api';

const { t } = useI18n();
const featuresStore = useFeaturesStore();
const auth = useAuthStore();

const isAdmin = computed(
  () => Array.isArray(auth.currentUser?.roles) && auth.currentUser.roles.includes('admin')
);

/**
 * The optional tools this instance has, and the version each one says it is,
 * for an administrator who does not read logs — the same report the server
 * writes when it starts (#9). Loaded for administrators only: the route
 * refuses everybody else, and a section that could only ever fail has no
 * business on their page.
 */
const tools = ref([]);

const statusOf = (tool) => {
  if (tool.used === false) return 'unused';
  return tool.available ? 'installed' : 'missing';
};

const STATUS_CLASSES = {
  installed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  missing: 'bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200',
  unused: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
};

const commitShort = computed(() => {
  const commit = featuresStore.gitCommit;
  return commit ? commit.slice(0, 7) : '';
});

const commitUrl = computed(() => {
  const repo = featuresStore.repoUrl;
  const commit = featuresStore.gitCommit;
  return repo && commit ? `${repo}/commit/${commit}` : '';
});

onMounted(async () => {
  try {
    await featuresStore.ensureLoaded();
  } catch (_) {
    // Non-fatal; version info is optional
  }
  if (!isAdmin.value) return;
  try {
    const answer = await fetchCapabilities();
    tools.value = Array.isArray(answer?.capabilities) ? answer.capabilities : [];
  } catch (_) {
    // Non-fatal; the version above is what this page is for.
  }
});
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div>
      <h2 class="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        {{ t('titles.about') }}
      </h2>
      <p class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
        {{ t('settings.about.subtitle') }}
      </p>
    </div>

    <!-- Content -->
    <div
      class="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden"
    >
      <div class="divide-y divide-zinc-200 dark:divide-zinc-800">
        <div class="flex items-center justify-between px-6 py-4">
          <div>
            <div class="font-medium text-zinc-900 dark:text-zinc-100">
              {{ t('settings.about.appVersion') }}
            </div>
            <div class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
              {{ t('settings.about.appVersionHelp') }}
            </div>
          </div>
          <div
            class="rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-3 py-1.5 text-sm font-mono text-zinc-900 dark:text-zinc-100"
          >
            <span>v{{ featuresStore.version }}</span>
          </div>
        </div>

        <div class="flex items-center justify-between px-6 py-4">
          <div>
            <div class="font-medium text-zinc-900 dark:text-zinc-100">
              {{ t('settings.about.gitCommit') }}
            </div>
            <div class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
              {{ t('settings.about.gitCommitHelp') }}
            </div>
          </div>
          <div
            class="rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-3 py-1.5 text-sm font-mono text-zinc-900 dark:text-zinc-100"
          >
            <template v-if="commitShort">
              <a
                v-if="commitUrl"
                :href="commitUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 underline decoration-dotted underline-offset-4"
              >
                {{ commitShort }}
              </a>
              <span v-else class="text-zinc-900 dark:text-zinc-100">{{ commitShort }}</span>
            </template>
            <span v-else class="text-zinc-500 dark:text-zinc-400">{{ t('common.unknown') }}</span>
          </div>
        </div>

        <div class="flex items-center justify-between px-6 py-4">
          <div>
            <div class="font-medium text-zinc-900 dark:text-zinc-100">
              {{ t('settings.about.branch') }}
            </div>
            <div class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
              {{ t('settings.about.branchHelp') }}
            </div>
          </div>
          <div
            class="rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-3 py-1.5 text-sm font-mono text-zinc-900 dark:text-zinc-100"
          >
            <span v-if="featuresStore.gitBranch" class="text-zinc-900 dark:text-zinc-100">{{
              featuresStore.gitBranch
            }}</span>
            <span v-else class="text-zinc-500 dark:text-zinc-400">{{ t('common.unknown') }}</span>
          </div>
        </div>
      </div>
    </div>

    <section v-if="tools.length" class="space-y-3" data-testid="about-tools">
      <div>
        <h3 class="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          {{ t('settings.about.tools.title') }}
        </h3>
        <p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          {{ t('settings.about.tools.subtitle') }}
        </p>
      </div>
      <div
        class="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
      >
        <ul class="divide-y divide-zinc-200 dark:divide-zinc-800">
          <li
            v-for="tool in tools"
            :key="tool.name"
            class="flex items-start justify-between gap-4 px-6 py-4"
            :data-testid="`about-tool-${tool.name}`"
          >
            <div class="min-w-0">
              <div class="font-mono text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {{ tool.name }}
                <span
                  v-if="tool.version"
                  class="ml-1.5 font-normal text-zinc-500 dark:text-zinc-400"
                  :data-testid="`about-tool-version-${tool.name}`"
                  >{{ tool.version }}</span
                >
              </div>
              <div class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                {{ t(`settings.about.tools.gives.${tool.enables}`) }}
              </div>
              <div
                v-if="statusOf(tool) === 'missing'"
                class="mt-2 text-xs text-zinc-600 dark:text-zinc-300"
              >
                {{ t('settings.about.tools.package') }}
                <code class="rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-800">{{
                  tool.install
                }}</code>
              </div>
              <div
                v-else-if="tool.missingFormats && tool.missingFormats.length"
                class="mt-2 text-xs text-amber-800 dark:text-amber-200"
                data-testid="about-tool-missing-formats"
              >
                {{
                  t('settings.about.tools.cannotOpen', { formats: tool.missingFormats.join(', ') })
                }}
                <template v-if="tool.installMissing">
                  — {{ t('settings.about.tools.package') }}
                  <code class="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono">{{
                    tool.installMissing
                  }}</code>
                </template>
              </div>
            </div>
            <span
              class="shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium"
              :class="STATUS_CLASSES[statusOf(tool)]"
              :data-testid="`about-tool-status-${tool.name}`"
            >
              {{ t(`settings.about.tools.${statusOf(tool)}`) }}
            </span>
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>
