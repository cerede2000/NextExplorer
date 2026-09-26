/**
 * Enough of JSON Schema to hold a response to the API's description.
 *
 * The subset the description is written in, and nothing more: `$ref` into the
 * document's components, `type` (with `null` in a list for a value that may be
 * absent), `properties`, `required`, `items`, `enum`, `const`, `allOf`,
 * `anyOf`, `oneOf`. A keyword outside it is an error rather than something
 * quietly passed, so the description cannot grow a rule this does not check.
 *
 * Objects are closed unless they say `additionalProperties: true`: a field the
 * server sends and the description does not mention is drift as much as a
 * field it renamed, and a generated client would not know it exists.
 */

const IGNORED = new Set([
  'description',
  'format',
  'examples',
  'default',
  'deprecated',
  'minimum',
  'maximum',
  'minLength',
  'title',
]);
const UNDERSTOOD = new Set([
  '$ref',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'allOf',
  'anyOf',
  'oneOf',
]);

const typeOf = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
};

const matchesType = (expected, value) => {
  const actual = typeOf(value);
  return expected === actual || (expected === 'number' && actual === 'integer');
};

/**
 * @param {object} document  the OpenAPI document, for `$ref`
 * @returns {(schema: object, value: unknown) => string[]}  problems, empty when it holds
 */
const createValidator = (document) => {
  const resolve = (schema) => {
    let current = schema;
    const seen = new Set();
    while (current && current.$ref) {
      if (seen.has(current.$ref)) throw new Error(`circular ${current.$ref}`);
      seen.add(current.$ref);
      const parts = current.$ref.replace(/^#\//, '').split('/');
      current = parts.reduce((node, part) => node?.[part], document);
      if (!current) throw new Error(`unresolved ${[...seen].pop()}`);
    }
    return current;
  };

  /** The properties an `allOf` names between its branches, for closing it. */
  const namedIn = (schema) => {
    const resolved = resolve(schema);
    const names = new Set(Object.keys(resolved.properties || {}));
    let open = resolved.additionalProperties === true;
    for (const branch of resolved.allOf || []) {
      const inner = namedIn(branch);
      inner.names.forEach((name) => names.add(name));
      open = open || inner.open;
    }
    return { names, open };
  };

  const check = (schema, value, where, { closed = true } = {}) => {
    const resolved = resolve(schema);
    const problems = [];

    for (const keyword of Object.keys(resolved)) {
      if (!UNDERSTOOD.has(keyword) && !IGNORED.has(keyword)) {
        problems.push(
          `${where}: the description uses \`${keyword}\`, which this check does not know`
        );
      }
    }

    if ('const' in resolved && value !== resolved.const) {
      problems.push(`${where}: ${JSON.stringify(value)} is not ${JSON.stringify(resolved.const)}`);
    }
    if (resolved.enum && !resolved.enum.includes(value)) {
      problems.push(
        `${where}: ${JSON.stringify(value)} is not one of ${JSON.stringify(resolved.enum)}`
      );
    }
    if (resolved.type) {
      const types = Array.isArray(resolved.type) ? resolved.type : [resolved.type];
      if (!types.some((type) => matchesType(type, value))) {
        problems.push(
          `${where}: ${typeOf(value)} where the description says ${types.join(' or ')}`
        );
        return problems;
      }
    }

    if (resolved.allOf) {
      for (const branch of resolved.allOf)
        problems.push(...check(branch, value, where, { closed: false }));
      if (closed && typeOf(value) === 'object') {
        const { names, open } = namedIn(resolved);
        if (!open) {
          for (const key of Object.keys(value)) {
            if (!names.has(key)) problems.push(`${where}.${key}: sent, and not in the description`);
          }
        }
      }
    }
    if (resolved.anyOf) {
      const passing = resolved.anyOf.filter((branch) => check(branch, value, where).length === 0);
      if (!passing.length) problems.push(`${where}: matches none of anyOf`);
    }
    if (resolved.oneOf) {
      const passing = resolved.oneOf.filter((branch) => check(branch, value, where).length === 0);
      if (passing.length !== 1)
        problems.push(`${where}: matches ${passing.length} of oneOf, not one`);
    }

    if (typeOf(value) === 'object' && (resolved.properties || resolved.required)) {
      for (const name of resolved.required || []) {
        if (!(name in value)) problems.push(`${where}.${name}: required and absent`);
      }
      for (const [name, property] of Object.entries(resolved.properties || {})) {
        if (name in value) problems.push(...check(property, value[name], `${where}.${name}`));
      }
      if (closed && !resolved.allOf && resolved.additionalProperties !== true) {
        for (const key of Object.keys(value)) {
          if (!(key in (resolved.properties || {}))) {
            problems.push(`${where}.${key}: sent, and not in the description`);
          }
        }
      }
    }

    if (typeOf(value) === 'array' && resolved.items) {
      value.forEach((entry, index) =>
        problems.push(...check(resolved.items, entry, `${where}[${index}]`))
      );
    }

    return problems;
  };

  return (schema, value) => check(schema, value, '$');
};

module.exports = { createValidator };
