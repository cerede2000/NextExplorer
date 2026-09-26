<script setup>
import { computed, onMounted, ref, nextTick } from 'vue';
import { withBase } from 'vitepress';
import SchemaView from './ApiSchema.vue';
import ApiText from './ApiText.vue';

/**
 * Every operation of the API, read from the description the site publishes.
 *
 * The description is held to the application by the backend's tests — every
 * mounted route in it, nothing else, every shape checked against real answers
 * — so this page lists what the server does rather than what somebody
 * remembered to write down.
 */

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

const ACCESS = {
  public: 'Anybody',
  account: 'Account or token',
  session: 'Session only',
  admin: 'Administrator',
  share: 'Link holder',
  shareVisitor: 'Link, opened',
  integration: 'Editor server',
};

const document = ref(null);
const failed = ref(false);
const filter = ref('');
const access = ref('');

onMounted(async () => {
  try {
    const response = await fetch(withBase('/openapi.json'));
    if (!response.ok) throw new Error(String(response.status));
    document.value = await response.json();
    await nextTick();
    const target = decodeURIComponent(window.location.hash.slice(1));
    const opened = target && window.document.getElementById(target);
    if (opened) {
      opened.open = true;
      opened.scrollIntoView();
    }
  } catch {
    failed.value = true;
  }
});

const operations = computed(() => {
  if (!document.value) return [];
  return Object.entries(document.value.paths).flatMap(([path, item]) =>
    METHODS.filter((method) => item[method]).map((method) => ({
      path,
      method,
      ...item[method],
    }))
  );
});

const shown = computed(() => {
  const words = filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return operations.value.filter((operation) => {
    if (access.value && operation['x-access'] !== access.value) return false;
    const haystack = [
      operation.method,
      operation.path,
      operation.summary,
      operation.operationId,
      ...(operation.tags || []),
    ]
      .join(' ')
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
});

const groups = computed(() => {
  if (!document.value) return [];
  return document.value.tags
    .map((tag) => ({
      ...tag,
      operations: shown.value.filter((operation) => operation.tags?.includes(tag.name)),
    }))
    .filter((group) => group.operations.length);
});

const counts = computed(() => {
  const byAccess = {};
  for (const operation of operations.value) {
    byAccess[operation['x-access']] = (byAccess[operation['x-access']] || 0) + 1;
  }
  return byAccess;
});

const resolve = (node) => {
  let current = node;
  while (current && current.$ref && document.value) {
    current = current.$ref
      .replace(/^#\//, '')
      .split('/')
      .reduce((here, part) => here?.[part], document.value);
  }
  return current || {};
};

const responsesOf = (operation) =>
  Object.entries(operation.responses || {}).map(([code, response]) => {
    const resolved = resolve(response);
    const [mediaType, media] = Object.entries(resolved.content || {})[0] || [];
    return {
      code,
      description: resolved.description,
      mediaType,
      schema: media?.schema,
      shared: Boolean(response.$ref),
    };
  });

const bodyOf = (operation) => {
  if (!operation.requestBody) return null;
  const [mediaType, media] = Object.entries(operation.requestBody.content || {})[0] || [];
  return { mediaType, schema: media?.schema, required: operation.requestBody.required };
};

const typeOfParameter = (parameter) => {
  const schema = parameter.schema || {};
  if (schema.enum) return schema.enum.join(' | ');
  return [schema.type, schema.format].filter(Boolean).join(' · ') || 'string';
};

const tone = (code) => (code.startsWith('2') || code.startsWith('3') ? 'ok' : 'refused');

const link = (operation) => `#${operation.operationId}`;
</script>

<template>
  <div class="api-explorer">
    <p v-if="failed" class="api-note">
      The description could not be loaded. It is also
      <a :href="withBase('/openapi.json')">a file you can open directly</a>.
    </p>
    <p v-else-if="!document" class="api-note">Loading the description…</p>

    <template v-else>
      <div class="api-toolbar">
        <label class="api-search">
          <span class="api-visually-hidden">Filter operations</span>
          <input
            v-model="filter"
            type="search"
            placeholder="Filter by path, summary or area — “share file”, “trash”…"
            autocomplete="off"
          />
        </label>
        <div class="api-chips" role="group" aria-label="Who may call it">
          <button type="button" :class="{ on: !access }" @click="access = ''">
            All <span>{{ operations.length }}</span>
          </button>
          <button
            v-for="(label, key) in ACCESS"
            :key="key"
            type="button"
            :class="['access-' + key, { on: access === key }]"
            @click="access = access === key ? '' : key"
          >
            {{ label }} <span>{{ counts[key] || 0 }}</span>
          </button>
        </div>
        <p class="api-summary">
          {{ shown.length }} of {{ operations.length }} operations ·
          <a :href="withBase('/openapi.json')" download>openapi.json</a> · OpenAPI
          {{ document.openapi }}
        </p>
      </div>

      <p v-if="!groups.length" class="api-note">Nothing matches.</p>

      <section v-for="group in groups" :key="group.name" class="api-group">
        <h2 :id="'area-' + group.name.toLowerCase().replace(/[^a-z]+/g, '-')">
          {{ group.name }}
          <small><ApiText :text="group.description" /></small>
        </h2>

        <details
          v-for="operation in group.operations"
          :id="operation.operationId"
          :key="operation.operationId"
          class="api-operation"
        >
          <summary>
            <span :class="['api-method', 'method-' + operation.method]">{{
              operation.method
            }}</span>
            <code class="api-path">{{ operation.path }}</code>
            <span class="api-title">{{ operation.summary }}</span>
            <span :class="['api-access', 'access-' + operation['x-access']]">
              {{ ACCESS[operation['x-access']] }}
            </span>
          </summary>

          <div class="api-body">
            <p v-if="operation.description" class="api-description">
              <ApiText :text="operation.description" />
            </p>
            <p class="api-id">
              <code>{{ operation.operationId }}</code>
              <a :href="link(operation)" aria-label="Link to this operation">#</a>
            </p>

            <template v-if="operation.parameters?.length">
              <h4>Parameters</h4>
              <div class="api-table">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>In</th>
                      <th>Type</th>
                      <th>What it is</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="parameter in operation.parameters"
                      :key="parameter.in + parameter.name"
                    >
                      <td>
                        <code>{{ parameter.name }}</code>
                        <span v-if="parameter.required" class="api-required" title="Required"
                          >*</span
                        >
                      </td>
                      <td>{{ parameter.in }}</td>
                      <td>
                        <code>{{ typeOfParameter(parameter) }}</code>
                      </td>
                      <td><ApiText :text="parameter.description" /></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </template>

            <template v-if="bodyOf(operation)">
              <h4>
                Body <code>{{ bodyOf(operation).mediaType }}</code>
                <span v-if="!bodyOf(operation).required" class="api-optional">optional</span>
              </h4>
              <SchemaView :schema="bodyOf(operation).schema" :resolve="resolve" />
            </template>

            <h4>Answers</h4>
            <ul class="api-responses">
              <li v-for="response in responsesOf(operation)" :key="response.code">
                <div class="api-response-head">
                  <span :class="['api-code', tone(response.code)]">{{ response.code }}</span>
                  <span><ApiText :text="response.description" /></span>
                  <code v-if="response.mediaType && !response.shared" class="api-media">{{
                    response.mediaType
                  }}</code>
                </div>
                <SchemaView
                  v-if="response.schema && !response.shared"
                  :schema="response.schema"
                  :resolve="resolve"
                />
              </li>
            </ul>
          </div>
        </details>
      </section>
    </template>
  </div>
</template>

<style scoped>
.api-explorer {
  --api-get: #1f7a4d;
  --api-post: #2458b3;
  --api-put: #8a5a00;
  --api-patch: #7a3fb0;
  --api-delete: #b3261e;
  --api-other: #5b5e66;
  margin-top: 16px;
}
.dark .api-explorer {
  --api-get: #5fd49a;
  --api-post: #7fa8ff;
  --api-put: #f2b64c;
  --api-patch: #c79cf2;
  --api-delete: #ff8a80;
  --api-other: #a3a7b0;
}
.api-toolbar {
  position: sticky;
  top: var(--vp-nav-height, 64px);
  z-index: 5;
  display: grid;
  gap: 10px;
  padding: 12px 0;
  background: var(--vp-c-bg);
  border-bottom: 1px solid var(--vp-c-divider);
}
.api-search input {
  width: 100%;
  padding: 9px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-size: 14px;
}
.api-search input:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 1px;
}
.api-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.api-chips button {
  padding: 3px 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  font-size: 12px;
  color: var(--vp-c-text-2);
  background: transparent;
}
.api-chips button span {
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
  margin-left: 2px;
}
.api-chips button.on {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-text-1);
  background: var(--vp-c-brand-soft);
}
.api-chips button:focus-visible,
.api-operation summary:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}
.api-summary,
.api-note {
  margin: 0;
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.api-group h2 {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
  margin-top: 36px;
  border-top: none;
}
.api-group h2 small {
  font-size: 13px;
  font-weight: 400;
  color: var(--vp-c-text-2);
}
.api-operation {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  margin: 8px 0;
  background: var(--vp-c-bg);
  /* Clear of the navigation bar and the sticky filter above it. */
  scroll-margin-top: calc(var(--vp-nav-height, 64px) + 150px);
}
.api-operation[open] {
  background: var(--vp-c-bg-soft);
}
.api-operation summary {
  display: grid;
  grid-template-columns: 64px minmax(0, auto) minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  cursor: pointer;
  list-style: none;
}
.api-operation summary::-webkit-details-marker {
  display: none;
}
.api-method {
  font: 700 11px/1 var(--vp-font-family-mono);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--api-other);
}
.method-get {
  color: var(--api-get);
}
.method-post {
  color: var(--api-post);
}
.method-put {
  color: var(--api-put);
}
.method-patch {
  color: var(--api-patch);
}
.method-delete {
  color: var(--api-delete);
}
.api-path {
  font-size: 13px;
  overflow-wrap: anywhere;
  background: none !important;
  padding: 0 !important;
  color: var(--vp-c-text-1);
}
.api-title {
  font-size: 13px;
  color: var(--vp-c-text-2);
  overflow-wrap: anywhere;
}
.api-access {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
  white-space: nowrap;
}
.api-access.access-admin {
  border-color: var(--api-delete);
  color: var(--api-delete);
}
.api-access.access-public,
.api-access.access-share {
  border-color: var(--api-get);
  color: var(--api-get);
}
.api-access.access-session {
  border-color: var(--api-patch);
  color: var(--api-patch);
}
.api-body {
  padding: 4px 16px 16px;
  border-top: 1px solid var(--vp-c-divider);
}
.api-body h4 {
  margin: 18px 0 6px;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--vp-c-text-2);
}
.api-body h4 code {
  text-transform: none;
  letter-spacing: 0;
  font-weight: 500;
}
.api-description {
  max-width: 68ch;
}
.api-id {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  margin: 8px 0 0;
}
.api-id a {
  text-decoration: none;
  color: var(--vp-c-text-3);
}
.api-table {
  overflow-x: auto;
}
.api-table table {
  margin: 0;
  font-size: 13px;
}
.api-required {
  color: var(--api-delete);
  margin-left: 2px;
}
.api-optional {
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  margin-left: 6px;
}
.api-responses {
  list-style: none;
  padding: 0;
  margin: 0;
}
.api-responses li {
  margin: 6px 0;
}
.api-response-head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
  font-size: 13px;
}
.api-code {
  font: 700 12px var(--vp-font-family-mono);
  font-variant-numeric: tabular-nums;
}
.api-code.ok {
  color: var(--api-get);
}
.api-code.refused {
  color: var(--api-delete);
}
.api-media {
  font-size: 11px;
}
.api-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
@media (max-width: 640px) {
  .api-operation summary {
    grid-template-columns: 52px minmax(0, 1fr);
  }
  .api-title,
  .api-access {
    grid-column: 2;
  }
  .api-access {
    justify-self: start;
  }
  .api-toolbar {
    position: static;
  }
}
@media (prefers-reduced-motion: reduce) {
  * {
    scroll-behavior: auto !important;
  }
}
</style>
