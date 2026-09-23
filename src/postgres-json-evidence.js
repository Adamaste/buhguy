const ENCODED_STRING_MARKER = '__receiptCollectorEncodedStringV1';
const ENCODED_OBJECT_MARKER = '__receiptCollectorEncodedObjectV1';
const ENCODING = 'utf16-code-units';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isEncodedStringObject(value) {
  return isPlainObject(value)
    && value[ENCODED_STRING_MARKER] === true
    && value.encoding === ENCODING
    && typeof value.value === 'string'
    && hasExactKeys(value, [ENCODED_STRING_MARKER, 'encoding', 'value']);
}

function isEncodedObjectObject(value) {
  return isPlainObject(value)
    && value[ENCODED_OBJECT_MARKER] === true
    && isPlainObject(value.value)
    && hasExactKeys(value, [ENCODED_OBJECT_MARKER, 'value']);
}

function needsStringEncoding(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0) return true;
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        index += 1;
        continue;
      }
      return true;
    }
    if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) return true;
  }
  return false;
}

function escapeUtf16CodeUnits(value) {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    output += `\\u${value.charCodeAt(index).toString(16).padStart(4, '0')}`;
  }
  return output;
}

function unescapeUtf16CodeUnits(value) {
  return value.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function encodeValue(value) {
  if (typeof value === 'string') {
    return needsStringEncoding(value)
      ? { [ENCODED_STRING_MARKER]: true, encoding: ENCODING, value: escapeUtf16CodeUnits(value) }
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => encodeValue(item));
  if (!isPlainObject(value)) return value;
  const encoded = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encodeValue(child)]));
  return isEncodedStringObject(encoded) || isEncodedObjectObject(encoded)
    ? { [ENCODED_OBJECT_MARKER]: true, value: encoded }
    : encoded;
}

function decodeValue(value) {
  if (Array.isArray(value)) return value.map((item) => decodeValue(item));
  if (!isPlainObject(value)) return value;
  if (isEncodedStringObject(value)) return unescapeUtf16CodeUnits(value.value);
  if (isEncodedObjectObject(value)) {
    return Object.fromEntries(Object.entries(value.value).map(([key, child]) => [key, decodeValue(child)]));
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decodeValue(child)]));
}

export function encodePostgresJsonEvidence(value) {
  return encodeValue(value);
}

export function decodePostgresJsonEvidence(value) {
  return decodeValue(value);
}
