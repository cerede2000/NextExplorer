<script setup>
import { computed } from 'vue';
import ApiText from './ApiText.vue';

/**
 * A schema of the description, as a short tree: each field with its type,
 * whether it is required, and what it is. A named shape is shown by its name
 * and opened on demand, so a page listing a hundred and sixty operations does
 * not print the same account object a hundred times.
 */
const props = defineProps({
  schema: { type: Object, required: true },
  resolve: { type: Function, required: true },
  depth: { type: Number, default: 0 },
});

const refName = (node) => (node?.$ref ? node.$ref.split('/').pop() : null);

const typeLabel = (node) => {
  if (!node) return '';
  const name = refName(node);
  if (name) return name;
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.enum) return node.enum.map((value) => JSON.stringify(value)).join(' | ');
  if (node.anyOf || node.oneOf) {
    return (node.anyOf || node.oneOf).map((branch) => typeLabel(branch) || 'object').join(' | ');
  }
  const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  const main = types.filter((type) => type !== 'null');
  let label = main.join(' | ') || (node.properties ? 'object' : node.allOf ? 'object' : 'any');
  if (main.includes('array') && node.items) label = `${typeLabel(node.items) || 'object'}[]`;
  if (node.format && node.format !== 'binary') label += ` (${node.format})`;
  if (node.format === 'binary') label = 'binary';
  if (types.includes('null')) label += ' | null';
  return label;
};

/** The properties of an object, allOf merged, with what the tree may open. */
const fields = computed(() => {
  const collect = (node, seen = new Set()) => {
    const resolved = props.resolve(node);
    const out = [];
    const required = new Set(resolved.required || []);
    for (const [name, property] of Object.entries(resolved.properties || {})) {
      out.push({ name, property, required: required.has(name) });
    }
    for (const branch of resolved.allOf || []) {
      const key = refName(branch);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      out.push(...collect(branch, seen));
    }
    return out;
  };
  const root = props.resolve(props.schema);
  const target =
    root.type === 'array' || (Array.isArray(root.type) && root.type.includes('array'))
      ? root.items
      : props.schema;
  return target ? collect(target) : [];
});

const variants = computed(() => {
  const root = props.resolve(props.schema);
  return root.oneOf || root.anyOf || null;
});

const nested = (property) => {
  const resolved = props.resolve(property);
  const inner =
    resolved.type === 'array' || (Array.isArray(resolved.type) && resolved.type.includes('array'))
      ? props.resolve(resolved.items || {})
      : resolved;
  return Boolean(inner.properties || inner.allOf || inner.oneOf);
};
</script>

<template>
  <div class="schema">
    <p class="schema-type">
      <code>{{ typeLabel(schema) }}</code>
      <span v-if="resolve(schema).description && depth === 0" class="schema-note">
        <ApiText :text="resolve(schema).description" />
      </span>
    </p>
    <ul v-if="variants && depth < 3" class="schema-variants">
      <li v-for="(variant, index) in variants" :key="index">
        <span class="schema-or">{{ index === 0 ? 'one of' : 'or' }}</span>
        <ApiSchema :schema="variant" :resolve="resolve" :depth="depth + 1" />
      </li>
    </ul>
    <ul v-if="fields.length" class="schema-fields">
      <li v-for="field in fields" :key="field.name">
        <div class="schema-field">
          <code class="schema-name"
            >{{ field.name }}<span v-if="field.required" title="Always there">*</span></code
          >
          <code class="schema-kind">{{ typeLabel(field.property) }}</code>
          <span v-if="resolve(field.property).description" class="schema-note">
            <ApiText :text="resolve(field.property).description" />
          </span>
        </div>
        <details v-if="nested(field.property) && depth < 3" class="schema-more">
          <summary>fields</summary>
          <ApiSchema :schema="field.property" :resolve="resolve" :depth="depth + 1" />
        </details>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.schema {
  font-size: 13px;
}
.schema-type {
  margin: 2px 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
}
.schema-fields,
.schema-variants {
  list-style: none;
  margin: 2px 0 2px 4px;
  padding-left: 12px;
  border-left: 1px solid var(--vp-c-divider);
}
.schema-fields li,
.schema-variants li {
  margin: 3px 0;
}
.schema-field {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: baseline;
}
.schema-name {
  background: none !important;
  padding: 0 !important;
  color: var(--vp-c-text-1) !important;
  font-weight: 600;
}
.schema-name span {
  color: var(--vp-c-danger-1, #b3261e);
}
.schema-kind {
  color: var(--vp-c-text-2);
  background: none !important;
  padding: 0 !important;
}
.schema-note {
  color: var(--vp-c-text-2);
  max-width: 60ch;
}
.schema-or {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--vp-c-text-3);
}
.schema-more summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--vp-c-brand-1);
}
.schema-more summary:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}
</style>
