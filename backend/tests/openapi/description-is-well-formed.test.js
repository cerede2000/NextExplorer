import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildOpenApi } = require('../../src/openapi');

/**
 * The rules of OpenAPI 3.1 a hand-written description breaks first, checked
 * without a validator to install: a reference to nothing, a path parameter
 * declared and not in the path or the other way round, two operations with
 * one id, a tag or a security scheme named and never defined.
 *
 * A generated client fails on every one of these, usually with a message
 * about something else.
 */

const document = buildOpenApi();
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

const operations = Object.entries(document.paths).flatMap(([template, item]) =>
  METHODS.filter((method) => item[method]).map((method) => ({
    template,
    method,
    operation: item[method],
  }))
);

const references = (node, found = []) => {
  if (Array.isArray(node)) node.forEach((entry) => references(entry, found));
  else if (node && typeof node === 'object') {
    if (typeof node.$ref === 'string') found.push(node.$ref);
    Object.values(node).forEach((value) => references(value, found));
  }
  return found;
};

describe('the description, as a document', () => {
  it('is OpenAPI 3.1 with the parts a reader needs', () => {
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.title).toBeTruthy();
    expect(document.info.version).toBeTruthy();
    expect(operations.length).toBeGreaterThan(150);
  });

  it('refers only to what it defines', () => {
    const unresolved = references(document).filter((ref) => {
      const target = ref
        .replace(/^#\//, '')
        .split('/')
        .reduce((node, part) => node?.[part], document);
      return !ref.startsWith('#/') || target === undefined;
    });
    expect(unresolved).toEqual([]);
  });

  it('declares each path parameter exactly where the path has one', () => {
    const problems = [];
    for (const { template, method, operation } of operations) {
      const inPath = [...template.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
      const declared = (operation.parameters || [])
        .filter((parameter) => parameter.in === 'path')
        .map((parameter) => {
          if (parameter.required !== true)
            problems.push(`${method} ${template}: ${parameter.name} not required`);
          return parameter.name;
        })
        .sort();
      if (JSON.stringify(inPath) !== JSON.stringify(declared)) {
        problems.push(`${method} ${template}: path has ${inPath}, declared ${declared}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('gives every operation its own id, a known tag and at least one response', () => {
    const tags = new Set(document.tags.map((tag) => tag.name));
    const ids = new Map();
    const problems = [];
    for (const { template, method, operation } of operations) {
      const where = `${method} ${template}`;
      if (!operation.operationId) problems.push(`${where}: no operationId`);
      if (ids.has(operation.operationId)) {
        problems.push(
          `${where}: operationId ${operation.operationId} also on ${ids.get(operation.operationId)}`
        );
      }
      ids.set(operation.operationId, where);
      for (const tag of operation.tags || [])
        if (!tags.has(tag)) problems.push(`${where}: tag ${tag} undefined`);
      if (!operation.tags?.length) problems.push(`${where}: no tag`);
      if (!Object.keys(operation.responses || {}).length) problems.push(`${where}: no response`);
      for (const code of Object.keys(operation.responses || {})) {
        if (!/^[1-5]\d\d$|^default$/.test(code)) problems.push(`${where}: response ${code}`);
      }
      if (!operation.summary) problems.push(`${where}: no summary`);
    }
    expect(problems).toEqual([]);
  });

  it('names only security schemes it defines', () => {
    const schemes = new Set(Object.keys(document.components.securitySchemes));
    const named = [document.security, ...operations.map(({ operation }) => operation.security)]
      .filter(Boolean)
      .flatMap((requirements) => requirements.flatMap((requirement) => Object.keys(requirement)));
    expect(named.filter((name) => !schemes.has(name))).toEqual([]);
  });

  it('has no tag without an operation', () => {
    const used = new Set(operations.flatMap(({ operation }) => operation.tags));
    expect(document.tags.map((tag) => tag.name).filter((name) => !used.has(name))).toEqual([]);
  });
});
