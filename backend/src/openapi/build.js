/**
 * The few shapes every part of the description is written with.
 *
 * Plain objects, no dependency and no configuration read: the description is
 * the same for every instance of a release, and the documentation site builds
 * it with nothing installed but Node.
 */

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

const obj = (properties, required = [], extra = {}) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  ...extra,
});

const arrayOf = (items, extra = {}) => ({ type: 'array', items, ...extra });

const str = (description, extra = {}) => ({
  type: 'string',
  ...(description ? { description } : {}),
  ...extra,
});
const num = (description, extra = {}) => ({
  type: 'number',
  ...(description ? { description } : {}),
  ...extra,
});
const int = (description, extra = {}) => ({
  type: 'integer',
  ...(description ? { description } : {}),
  ...extra,
});
const bool = (description, extra = {}) => ({
  type: 'boolean',
  ...(description ? { description } : {}),
  ...extra,
});
const dateTime = (description) => str(description, { format: 'date-time' });

/** A value that may also be null. */
const nullable = (schema) => {
  if (schema.$ref) return { anyOf: [schema, { type: 'null' }] };
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return { ...schema, type: [...types.filter(Boolean), 'null'] };
};

const json = (schema, description = 'Done.') => ({
  description,
  content: { 'application/json': { schema } },
});

const noContent = (description = 'Done; nothing to say.') => ({ description });

const stream = (mediaType, description) => ({
  description,
  content: { [mediaType]: { schema: { type: 'string', format: 'binary' } } },
});

const errors = (...codes) =>
  Object.fromEntries(
    codes.map((code) => [String(code), { $ref: `#/components/responses/E${code}` }])
  );

const pathParam = (name, description, schema = { type: 'string' }) => ({
  name,
  in: 'path',
  required: true,
  description,
  schema,
});

/**
 * A path inside a space — `Documents/2026/report.pdf`, `personal/notes`,
 * `share/<token>/…` — sent as the rest of the URL. The slashes may be sent as
 * they are or encoded; both reach the same file.
 */
const splatParam = (description = 'The path, slashes included; empty for the top.') => ({
  name: 'path',
  in: 'path',
  required: true,
  description,
  schema: { type: 'string' },
  allowReserved: true,
});

const query = (name, description, schema = { type: 'string' }, required = false) => ({
  name,
  in: 'query',
  required,
  description,
  schema,
});

const header = (name, description, schema = { type: 'string' }, required = false) => ({
  name,
  in: 'header',
  required,
  description,
  schema,
});

const body = (schema, { required = true, description } = {}) => ({
  required,
  ...(description ? { description } : {}),
  content: { 'application/json': { schema } },
});

/**
 * Who may call an operation, said twice: once as OpenAPI security, which a
 * generated client acts on, and once as `x-access`, which says it in words the
 * reference page shows.
 *
 * - `public`: nobody has to be signed in.
 * - `account`: a session or an API token; a read-only token reaches only reads.
 * - `session`: a session and never a token — the account itself, and the
 *   integrations' own editor pages.
 * - `admin`: an administrator's session; a token never, whoever holds it.
 * - `share`: somebody holding the link, with nothing else.
 * - `shareVisitor`: somebody holding the link and the guest session opening it
 *   earned — the password, when it has one — or a signed-in account it was
 *   shared with.
 * - `integration`: an editor's server calling back, with the signed token the
 *   route checks for itself.
 */
const SECURITY = {
  public: [],
  account: [{ session: [] }, { apiToken: [] }],
  session: [{ session: [] }],
  admin: [{ session: [] }],
  share: [{}],
  shareVisitor: [{ guestSession: [] }, { session: [] }],
  integration: [],
};

/**
 * One operation.
 *
 * @param {object} spec
 * @param {string} spec.id           operationId
 * @param {string} spec.summary
 * @param {string} [spec.description]
 * @param {string} spec.tag
 * @param {keyof SECURITY} spec.access
 * @param {Array} [spec.params]
 * @param {object} [spec.body]
 * @param {object} spec.responses
 */
const op = ({ id, summary, description, tag, access, params, body: requestBody, responses }) => ({
  operationId: id,
  summary,
  ...(description ? { description } : {}),
  tags: [tag],
  security: SECURITY[access],
  'x-access': access,
  ...(params && params.length ? { parameters: params } : {}),
  ...(requestBody ? { requestBody } : {}),
  responses,
});

module.exports = {
  ref,
  obj,
  arrayOf,
  str,
  num,
  int,
  bool,
  dateTime,
  nullable,
  json,
  noContent,
  stream,
  errors,
  pathParam,
  splatParam,
  query,
  header,
  body,
  op,
  SECURITY,
};
