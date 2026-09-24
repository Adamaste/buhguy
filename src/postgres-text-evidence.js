const TEXT_MARKER = '__receiptCollectorTextV1:';

function hasUnsafeUtf16(value) {
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

function utf16Hex(value) {
  let encoded = '';
  for (let index = 0; index < value.length; index += 1) encoded += value.charCodeAt(index).toString(16).padStart(4, '0');
  return encoded;
}

function fromUtf16Hex(value) {
  if (!/^(?:[0-9a-f]{4})*$/i.test(value)) return null;
  let decoded = '';
  for (let index = 0; index < value.length; index += 4) decoded += String.fromCharCode(Number.parseInt(value.slice(index, index + 4), 16));
  return decoded;
}

export function encodePostgresTextEvidence(value) {
  if (typeof value !== 'string') return value;
  // Reserve the marker prefix too, so a literal escaped-looking value cannot
  // be mistaken for our representation on a later read.
  return hasUnsafeUtf16(value) || value.startsWith(TEXT_MARKER) ? `${TEXT_MARKER}${utf16Hex(value)}` : value;
}

export function decodePostgresTextEvidence(value) {
  if (typeof value !== 'string' || !value.startsWith(TEXT_MARKER)) return value;
  const decoded = fromUtf16Hex(value.slice(TEXT_MARKER.length));
  if (decoded === null) return value;
  return decoded;
}

