const INLINE_SAFE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

type AttachmentDisposition = "inline" | "attachment";

type AttachmentHeaders = {
  readonly contentType: string;
  readonly contentDisposition: string;
  readonly contentSecurityPolicy: string | null;
};

function declaredMediaType(declaredMime: string): string {
  const trimmed = declaredMime.trim().toLowerCase();
  const separator = trimmed.indexOf(";");
  if (separator === -1) return trimmed;
  return trimmed.slice(0, separator).trim();
}

function isInlineSafeType(declaredMime: string): boolean {
  return INLINE_SAFE_TYPES.has(declaredMediaType(declaredMime));
}

export function rfc6266ContentDisposition(
  disposition: AttachmentDisposition,
  filename: string,
): string {
  const ascii = asciiFilename(filename);
  const encoded = encodeRfc5987(filename);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function attachmentHeaders(declaredMime: string, filename: string): AttachmentHeaders {
  if (isInlineSafeType(declaredMime)) {
    return {
      contentType: declaredMediaType(declaredMime),
      contentDisposition: rfc6266ContentDisposition("inline", filename),
      contentSecurityPolicy: "sandbox",
    };
  }
  return {
    contentType: "application/octet-stream",
    contentDisposition: rfc6266ContentDisposition("attachment", filename),
    contentSecurityPolicy: null,
  };
}

type AttachmentResponseHeaders = {
  readonly "content-type": string;
  readonly "content-disposition": string;
  readonly "x-content-type-options": "nosniff";
  readonly "content-security-policy"?: string;
};

export function attachmentResponseHeaders(
  declaredMime: string,
  filename: string,
): AttachmentResponseHeaders {
  const headers = attachmentHeaders(declaredMime, filename);
  if (headers.contentSecurityPolicy === null) {
    return {
      "content-type": headers.contentType,
      "content-disposition": headers.contentDisposition,
      "x-content-type-options": "nosniff",
    };
  }
  return {
    "content-type": headers.contentType,
    "content-disposition": headers.contentDisposition,
    "x-content-type-options": "nosniff",
    "content-security-policy": headers.contentSecurityPolicy,
  };
}

function asciiFilename(filename: string): string {
  let result = "";
  for (const char of filename) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (code < 32 || code > 126 || char === '"' || char === "\\" || char === ";") {
      result += "_";
      continue;
    }
    result += char;
  }
  if (result.length === 0) return "attachment";
  return result;
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => {
    const code = char.codePointAt(0);
    if (code === undefined) return "";
    return `%${code.toString(16).toUpperCase()}`;
  });
}
