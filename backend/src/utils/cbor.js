/**
 * Just enough CBOR to read what an authenticator sends.
 *
 * A passkey arrives as two CBOR objects and nothing else: the attestation
 * object, which is a map of three known keys, and the public key inside it,
 * which is a small map of integers and byte strings (a COSE key, RFC 9052).
 * Neither contains a tag, a float, a bignum or an indefinite length, and
 * CTAP2 forbids all four in what an authenticator returns — so this reads the
 * six major types those objects use and refuses everything else rather than
 * guessing.
 *
 * Refusing is the point. This parses bytes that arrive from outside before
 * anybody is signed in, so every length is checked against what is actually
 * there, the nesting is bounded, and trailing bytes after a complete value are
 * an error rather than something ignored.
 *
 * Non-minimal integer encodings are accepted. CTAP2 asks for canonical CBOR,
 * but nothing here compares raw encodings — a credential is matched on the
 * bytes it decodes to — so an authenticator that writes a short length the
 * long way is read rather than turned away from somebody's account.
 *
 * Maps decode to `Map`, not to objects: COSE labels are negative integers, and
 * an object would turn -1 and "-1" into the same key, and `__proto__` into
 * something worse.
 */

const MAX_DEPTH = 16;

class CborError extends Error {}

const need = (buffer, offset, length) => {
  if (length < 0 || offset + length > buffer.length) {
    throw new CborError('CBOR value runs past the end of the data.');
  }
};

/** The argument of a head byte: its value, and where the value ends. */
const readArgument = (buffer, offset, info) => {
  if (info < 24) return { value: info, next: offset };
  if (info === 24) {
    need(buffer, offset, 1);
    return { value: buffer.readUInt8(offset), next: offset + 1 };
  }
  if (info === 25) {
    need(buffer, offset, 2);
    return { value: buffer.readUInt16BE(offset), next: offset + 2 };
  }
  if (info === 26) {
    need(buffer, offset, 4);
    return { value: buffer.readUInt32BE(offset), next: offset + 4 };
  }
  if (info === 27) {
    need(buffer, offset, 8);
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CborError('CBOR integer is larger than this reads.');
    }
    return { value: Number(big), next: offset + 8 };
  }
  // 28-30 are unassigned; 31 is the indefinite length CTAP2 forbids.
  throw new CborError(`CBOR length form ${info} is not read here.`);
};

const readValue = (buffer, offset, depth) => {
  if (depth > MAX_DEPTH) throw new CborError('CBOR value is nested too deeply.');
  need(buffer, offset, 1);
  const head = buffer.readUInt8(offset);
  const major = head >> 5;
  const info = head & 0x1f;
  const { value: argument, next } = readArgument(buffer, offset + 1, info);

  switch (major) {
    case 0:
      return { value: argument, next };
    case 1:
      return { value: -1 - argument, next };
    case 2:
      need(buffer, next, argument);
      // A copy, not a view: the returned bytes outlive the request body, and a
      // slice of it would keep the whole thing alive and let it be changed.
      return { value: Buffer.from(buffer.subarray(next, next + argument)), next: next + argument };
    case 3: {
      need(buffer, next, argument);
      return {
        value: buffer.subarray(next, next + argument).toString('utf8'),
        next: next + argument,
      };
    }
    case 4: {
      const items = [];
      let cursor = next;
      for (let index = 0; index < argument; index += 1) {
        const item = readValue(buffer, cursor, depth + 1);
        items.push(item.value);
        cursor = item.next;
      }
      return { value: items, next: cursor };
    }
    case 5: {
      const map = new Map();
      let cursor = next;
      for (let index = 0; index < argument; index += 1) {
        const key = readValue(buffer, cursor, depth + 1);
        if (typeof key.value !== 'number' && typeof key.value !== 'string') {
          throw new CborError('CBOR map keys are integers or text here.');
        }
        const item = readValue(buffer, key.next, depth + 1);
        // A repeated key is a way of saying two things at once; the reader
        // that takes the first and the reader that takes the last disagree.
        if (map.has(key.value)) throw new CborError('CBOR map holds the same key twice.');
        map.set(key.value, item.value);
        cursor = item.next;
      }
      return { value: map, next: cursor };
    }
    case 7: {
      if (info === 20) return { value: false, next };
      if (info === 21) return { value: true, next };
      if (info === 22) return { value: null, next };
      if (info === 23) return { value: undefined, next };
      throw new CborError('CBOR simple value or float is not read here.');
    }
    default:
      throw new CborError(`CBOR major type ${major} is not read here.`);
  }
};

/** The first value, and the offset just after it. */
const decodeFirst = (buffer) => {
  if (!Buffer.isBuffer(buffer)) throw new CborError('CBOR needs bytes to read.');
  const { value, next } = readValue(buffer, 0, 0);
  return { value, bytesRead: next };
};

/** One value filling the whole input; anything after it is an error. */
const decode = (buffer) => {
  const { value, bytesRead } = decodeFirst(buffer);
  if (bytesRead !== buffer.length) {
    throw new CborError('CBOR data carries more than one value.');
  }
  return value;
};

module.exports = { decode, decodeFirst, CborError };
