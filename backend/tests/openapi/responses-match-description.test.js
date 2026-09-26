import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestEnv } from '../helpers/env-test-utils.js';
import { createValidator } from '../helpers/json-schema.js';
import { tour, TOUR_ENVIRONMENT } from './tour.js';

/**
 * What the API really answers, held to what its description says it answers.
 *
 * The walk goes through the application as a client would — signing in,
 * making and moving files, sharing, deleting, bringing back, the integrations
 * — and every answer it receives has to be one the description lists for
 * that operation, with a body that fits the schema listed for it. The shapes
 * were written from these answers; this is what stops them from being true
 * only on the day they were written.
 *
 * An answer that depends on the machine — 7-Zip missing, so archives answer
 * `503` — is fine as long as the description admits it.
 */

let envContext;
let exchanges;
let document;
let validate;

beforeAll(async () => {
  envContext = await setupTestEnv({ tag: 'openapi-responses-', env: TOUR_ENVIRONMENT });
  const { createApp } = envContext.requireFresh('src/app');
  const app = await createApp({ skipOidc: true, skipStaticFiles: true });
  ({ exchanges } = await tour(app, {
    volume: envContext.volumeDir,
    requireFresh: envContext.requireFresh,
  }));
  document = envContext.requireFresh('src/openapi').buildOpenApi();
  validate = createValidator(document);
}, 60000);

afterAll(async () => {
  await envContext?.cleanup();
});

const operationOf = (key) => {
  const [method, template] = key.split(' ');
  return document.paths[template]?.[method.toLowerCase()];
};

const resolveResponse = (response) => {
  if (!response?.$ref) return response;
  return response.$ref
    .replace(/^#\//, '')
    .split('/')
    .reduce((node, part) => node?.[part], document);
};

describe('the walk through the API', () => {
  // All of it, so that a walk which silently stopped early fails here rather
  // than passing everything below on a handful of calls — and so that an
  // operation added to the description is added to the walk as well, where its
  // answers are held to what it says.
  it('went through every operation described', () => {
    const exercised = new Set(exchanges.map((exchange) => exchange.operation));
    const skipped = Object.entries(document.paths).flatMap(([template, operations]) =>
      Object.keys(operations)
        .map((method) => `${method.toUpperCase()} ${template}`)
        .filter((key) => !exercised.has(key))
    );
    expect(skipped).toEqual([]);
  });

  it('only called operations the description has', () => {
    const unknown = exchanges.filter((exchange) => !operationOf(exchange.operation));
    expect(unknown.map((exchange) => exchange.operation)).toEqual([]);
  });

  it('got back only statuses the description lists', () => {
    const undescribed = exchanges
      .filter((exchange) => {
        const responses = operationOf(exchange.operation)?.responses || {};
        return !(String(exchange.status) in responses) && !('default' in responses);
      })
      .map((exchange) => `${exchange.operation} → ${exchange.status}`);
    expect(undescribed).toEqual([]);
  });

  it('got back bodies that fit the schemas described', () => {
    const problems = [];

    for (const exchange of exchanges) {
      const response = resolveResponse(
        operationOf(exchange.operation)?.responses?.[String(exchange.status)]
      );
      if (!response) continue;
      const content = response.content || {};

      if (exchange.type === 'application/json') {
        const schema = content['application/json']?.schema;
        if (!schema) {
          problems.push(
            `${exchange.operation} ${exchange.status}: JSON, and the description says ${Object.keys(content).join(', ') || 'no body'}`
          );
          continue;
        }
        for (const problem of validate(schema, exchange.body)) {
          problems.push(`${exchange.operation} ${exchange.status}: ${problem}`);
        }
      } else if (exchange.type === 'application/x-ndjson') {
        const schema = content['application/x-ndjson']?.schema;
        if (!schema) {
          problems.push(
            `${exchange.operation} ${exchange.status}: a stream the description does not mention`
          );
          continue;
        }
        const lines = String(exchange.text || '')
          .split('\n')
          .filter(Boolean);
        for (const line of lines) {
          for (const problem of validate(schema, JSON.parse(line))) {
            problems.push(`${exchange.operation} ${exchange.status}: ${problem}`);
          }
        }
      }
    }

    expect(problems).toEqual([]);
  });
});
