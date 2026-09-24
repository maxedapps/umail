import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const RAW_LOCAL_PART = /^[A-Za-z0-9._-]+$/;
const CANONICAL_LOCAL_PART = /^[a-z0-9._-]+$/;
const CANONICAL_DOMAIN = /^[^@]+$/;
const CANONICAL_ADDRESS = /^[a-z0-9._-]+@[^@]+$/;

const RESERVED_LOCAL_PARTS = new Set<string>([
  "postmaster",
  "abuse",
  "webmaster",
  "hostmaster",
  "admin",
  "administrator",
  "root",
  "mailer-daemon",
]);

const RawMailboxLocalPart = Schema.String.check(Schema.isPattern(RAW_LOCAL_PART));

export const MailDomain = Schema.String.check(
  Schema.isPattern(CANONICAL_DOMAIN),
  Schema.isLowercased(),
).pipe(Schema.brand("MailDomain"));
export type MailDomain = typeof MailDomain.Type;

export const MailboxLocalPart = Schema.String.check(
  Schema.isPattern(CANONICAL_LOCAL_PART),
  Schema.isLowercased(),
).pipe(Schema.brand("MailboxLocalPart"));
export type MailboxLocalPart = typeof MailboxLocalPart.Type;

export const MailboxAddress = Schema.String.check(
  Schema.isPattern(CANONICAL_ADDRESS),
  Schema.isLowercased(),
).pipe(Schema.brand("MailboxAddress"));
export type MailboxAddress = typeof MailboxAddress.Type;

export type MailDomainParseResult =
  | { readonly kind: "ok"; readonly domain: MailDomain }
  | { readonly kind: "invalid" };

export type MailboxLocalPartParseResult =
  | { readonly kind: "ok"; readonly localPart: MailboxLocalPart }
  | { readonly kind: "invalid" };

export type MailboxAddressParseResult =
  | {
      readonly kind: "ok";
      readonly localPart: MailboxLocalPart;
      readonly domain: MailDomain;
      readonly address: MailboxAddress;
    }
  | { readonly kind: "invalid" };

export type RegistrationMailboxAddressResult =
  | MailboxAddressParseResult
  | { readonly kind: "reserved" };

export function parseMailDomain(raw: string): MailDomainParseResult {
  return decodeMailDomain(raw.trim().toLowerCase());
}

export function parseMailboxLocalPart(raw: string): MailboxLocalPartParseResult {
  return decodeRawMailboxLocalPart(raw.trim());
}

export function parseMailboxAddress(raw: string): MailboxAddressParseResult {
  const trimmed = raw.trim();
  const separator = trimmed.lastIndexOf("@");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return { kind: "invalid" };
  }

  const localPart = decodeRawMailboxLocalPart(trimmed.slice(0, separator));
  const domain = decodeMailDomain(trimmed.slice(separator + 1).toLowerCase());
  if (localPart.kind === "invalid" || domain.kind === "invalid") {
    return { kind: "invalid" };
  }

  return assembleMailboxAddress(localPart.localPart, domain.domain);
}

export function constructMailboxAddress(
  rawLocalPart: string,
  rawDomain: string,
): RegistrationMailboxAddressResult {
  const localPart = parseMailboxLocalPart(rawLocalPart);
  const domain = parseMailDomain(rawDomain);
  if (localPart.kind === "invalid" || domain.kind === "invalid") {
    return { kind: "invalid" };
  }
  if (RESERVED_LOCAL_PARTS.has(localPart.localPart)) {
    return { kind: "reserved" };
  }
  return assembleMailboxAddress(localPart.localPart, domain.domain);
}

function assembleMailboxAddress(
  localPart: MailboxLocalPart,
  domain: MailDomain,
): MailboxAddressParseResult {
  const decoded = Schema.decodeResult(MailboxAddress)(`${localPart}@${domain}`);
  if (Result.isFailure(decoded)) {
    return { kind: "invalid" };
  }
  return { kind: "ok", localPart, domain, address: decoded.success };
}

function decodeMailDomain(canonical: string): MailDomainParseResult {
  const decoded = Schema.decodeResult(MailDomain)(canonical);
  if (Result.isFailure(decoded)) {
    return { kind: "invalid" };
  }
  return { kind: "ok", domain: decoded.success };
}

function decodeMailboxLocalPart(canonical: string): MailboxLocalPartParseResult {
  const decoded = Schema.decodeResult(MailboxLocalPart)(canonical);
  if (Result.isFailure(decoded)) {
    return { kind: "invalid" };
  }
  return { kind: "ok", localPart: decoded.success };
}

function decodeRawMailboxLocalPart(raw: string): MailboxLocalPartParseResult {
  const decoded = Schema.decodeResult(RawMailboxLocalPart)(raw);
  if (Result.isFailure(decoded)) {
    return { kind: "invalid" };
  }
  return decodeMailboxLocalPart(decoded.success.toLowerCase());
}
