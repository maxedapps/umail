import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { MailboxAddress, parseMailboxAddress, type MailDomain } from "./mailbox-address.ts";

export const ExternalMailAddress = Schema.String.check(
  Schema.makeFilter((raw: string) =>
    isCanonicalExternalMailAddress(raw) ? undefined : "Invalid external mail address",
  ),
).pipe(Schema.brand("ExternalMailAddress"));
export type ExternalMailAddress = typeof ExternalMailAddress.Type;

export class MailContact extends Schema.Class<MailContact>("MailContact")({
  address: ExternalMailAddress,
  displayName: Schema.NullOr(Schema.String),
}) {}

export type ExternalMailAddressParseResult =
  | {
      readonly kind: "ok";
      readonly localPart: string;
      readonly domain: string;
      readonly address: ExternalMailAddress;
      readonly comparisonKey: string;
    }
  | { readonly kind: "invalid" };

export function parseExternalMailAddress(raw: string): ExternalMailAddressParseResult {
  const trimmed = raw.trim();
  const separator = trimmed.lastIndexOf("@");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return { kind: "invalid" };
  }

  const localPart = trimmed.slice(0, separator);
  const domain = trimmed.slice(separator + 1).toLowerCase();
  if (
    localPart.length === 0 ||
    domain.length === 0 ||
    hasDisallowedAddressChar(localPart) ||
    hasDisallowedAddressChar(domain) ||
    localPart.includes("@") ||
    domain.includes("@")
  ) {
    return { kind: "invalid" };
  }

  const formatted = `${localPart}@${domain}`;
  const decoded = Schema.decodeResult(ExternalMailAddress)(formatted);
  if (Result.isFailure(decoded)) {
    return { kind: "invalid" };
  }
  return {
    kind: "ok",
    localPart,
    domain,
    address: decoded.success,
    comparisonKey: formatted,
  };
}

export function comparisonKey(address: ExternalMailAddress): string {
  return address;
}

export function isOwnRegisteredIdentity(
  address: ExternalMailAddress,
  managedDomain: MailDomain,
  registered: ReadonlySet<MailboxAddress>,
): boolean {
  const parsed = parseExternalMailAddress(address);
  if (parsed.kind === "invalid" || parsed.domain !== managedDomain) {
    return false;
  }
  const mailbox = parseMailboxAddress(parsed.address);
  return mailbox.kind === "ok" && registered.has(mailbox.address);
}

export function dedupeMailContacts(
  contacts: ReadonlyArray<MailContact>,
): ReadonlyArray<MailContact> {
  const seen = new Set<string>();
  const deduped: Array<MailContact> = [];
  for (const contact of contacts) {
    const key = comparisonKey(contact.address);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(contact);
  }
  return deduped;
}

function isCanonicalExternalMailAddress(raw: string): boolean {
  const separator = raw.lastIndexOf("@");
  if (separator <= 0 || separator === raw.length - 1) {
    return false;
  }
  const localPart = raw.slice(0, separator);
  const domain = raw.slice(separator + 1);
  return (
    localPart.length > 0 &&
    domain.length > 0 &&
    domain === domain.toLowerCase() &&
    !hasDisallowedAddressChar(localPart) &&
    !hasDisallowedAddressChar(domain) &&
    !localPart.includes("@") &&
    !domain.includes("@")
  );
}

function hasDisallowedAddressChar(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}
