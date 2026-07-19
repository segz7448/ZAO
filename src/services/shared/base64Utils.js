/**
 * ZAO - Shared Base64 Utilities
 *
 * Hermes (React Native's default JS engine) does not guarantee atob/btoa
 * as globals the way a browser does, and several tool modules
 * (githubTool.js, pdfTool.js, and future Office tools) all need
 * base64 <-> text/bytes conversion for API payloads and binary file I/O.
 * This is one dependency-free implementation shared across all of them,
 * rather than three+ copies of the same encode/decode logic drifting out
 * of sync over time.
 */

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Encodes a UTF-8 JS string to base64 - for text content (source code,
 * JSON, etc.) going into an API payload or a text file.
 */
export function utf8ToBase64(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.codePointAt(i);
    if (code > 0xffff) i++; // surrogate pair consumed two UTF-16 units
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return bytesToBase64(bytes);
}

/**
 * Decodes base64 to a UTF-8 JS string - the inverse of utf8ToBase64,
 * for reading text content back out of an API response or file.
 */
export function base64ToUtf8(b64) {
  const bytes = base64ToBytes(b64);
  let result = '';
  let i = 0;
  while (i < bytes.length) {
    const b1 = bytes[i++];
    if (b1 < 0x80) {
      result += String.fromCharCode(b1);
    } else if (b1 < 0xe0) {
      const b2 = bytes[i++];
      result += String.fromCharCode(((b1 & 0x1f) << 6) | (b2 & 0x3f));
    } else if (b1 < 0xf0) {
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      result += String.fromCharCode(((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
    } else {
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      const b4 = bytes[i++];
      let code = ((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f);
      code -= 0x10000;
      result += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    }
  }
  return result;
}

/**
 * Encodes raw bytes (array or Uint8Array) to base64 - for binary content
 * (images, zips, PDFs) rather than text.
 */
export function bytesToBase64(bytes) {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i];
    const b2 = i + 1 < bytes.length ? bytes[i + 1] : null;
    const b3 = i + 2 < bytes.length ? bytes[i + 2] : null;

    result += B64_CHARS[b1 >> 2];
    result += B64_CHARS[((b1 & 0x03) << 4) | (b2 !== null ? b2 >> 4 : 0)];
    result += b2 !== null ? B64_CHARS[((b2 & 0x0f) << 2) | (b3 !== null ? b3 >> 6 : 0)] : '=';
    result += b3 !== null ? B64_CHARS[b3 & 0x3f] : '=';
  }
  return result;
}

/**
 * Decodes base64 to raw bytes (Uint8Array) - for binary content
 * (images, zips, PDFs) rather than text.
 */
export function base64ToBytes(b64) {
  const cleaned = b64.replace(/[\n\r]/g, '');
  const lookup = {};
  for (let i = 0; i < B64_CHARS.length; i++) lookup[B64_CHARS[i]] = i;

  const bytes = [];
  for (let i = 0; i < cleaned.length; i += 4) {
    const c1 = lookup[cleaned[i]] ?? 0;
    const c2 = lookup[cleaned[i + 1]] ?? 0;
    const c3 = cleaned[i + 2] !== '=' ? lookup[cleaned[i + 2]] : undefined;
    const c4 = cleaned[i + 3] !== '=' ? lookup[cleaned[i + 3]] : undefined;

    bytes.push((c1 << 2) | (c2 >> 4));
    if (c3 !== undefined) bytes.push(((c2 & 0x0f) << 4) | (c3 >> 2));
    if (c4 !== undefined) bytes.push(((c3 & 0x03) << 6) | c4);
  }
  return new Uint8Array(bytes);
}
