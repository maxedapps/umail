import type { InvalidRequest, Unavailable } from "@umail/api-contract";
import * as Effect from "effect/Effect";

import {
  MailHtmlPolicyError,
  type MailHtmlMaterialization,
  type MailHtmlPolicy,
  type MailHtmlSanitization,
  type StoredMailHtml,
} from "../../src/mail/html-policy.ts";
import type { MailHtmlResourceLimit } from "../../src/mail/html-parser.ts";
import { ArchiveTransportError, type MailArchiveReader } from "../../src/api/app.ts";
import type { DestinationsClient, ForwardingDestination } from "../../src/api/destinations.ts";

export class MemoryArchive implements MailArchiveReader {
  readonly objects = new Map<string, Uint8Array>();
  readonly getCalls: string[] = [];
  #failNext = false;

  put(key: string, bytes: Uint8Array): void {
    this.objects.set(key, bytes);
  }

  failNextTransport(): void {
    this.#failNext = true;
  }

  get(key: string): Effect.Effect<Uint8Array | null, ArchiveTransportError> {
    return Effect.suspend(() => {
      this.getCalls.push(key);
      if (this.#failNext) {
        this.#failNext = false;
        return new ArchiveTransportError({ key });
      }
      return Effect.succeed(this.objects.get(key) ?? null);
    });
  }
}

// Cloudflare's account-wide destinations: `verify` stands in for the owner clicking the link.
export class MemoryDestinations implements DestinationsClient {
  readonly ensureCalls: string[] = [];
  readonly #verified = new Set<string>();
  #failure: InvalidRequest | Unavailable | null = null;

  verify(email: string): void {
    this.#verified.add(email.toLowerCase());
  }

  failNext(error: InvalidRequest | Unavailable): void {
    this.#failure = error;
  }

  ensure(email: string): Effect.Effect<ForwardingDestination, InvalidRequest | Unavailable> {
    return Effect.suspend(() => {
      this.ensureCalls.push(email);
      if (this.#failure !== null) {
        const failure = this.#failure;
        this.#failure = null;
        return Effect.fail(failure);
      }
      return Effect.succeed({ email, verified: this.#verified.has(email.toLowerCase()) });
    });
  }
}

export const REMOTE_HTML_SOURCE =
  '<p>html body</p><img src="https://tracker.example/pixel">' as const;
export const REMOTE_HTML_STORED =
  '<p>html body</p><img data-umail-remote-src="https://tracker.example/pixel">' as const;
export const REMOTE_HTML_MATERIALIZED =
  '<p>html body</p><img data-umail-remote-src="https://tracker.example/pixel" src="https://tracker.example/pixel" referrerpolicy="no-referrer">' as const;

export const PREVIEW_EXTERNAL_ORIGIN = "https://outside.invalid" as const;
export const PREVIEW_HTML_SOURCE =
  `<p id="preview-copy">Canonical stored preview</p><a id="external-preview-link" href="${PREVIEW_EXTERNAL_ORIGIN}/destination" target="_blank">External destination</a><img id="remote-preview-image" src="${PREVIEW_EXTERNAL_ORIGIN}/pixel.png" alt="Remote image remains inert">` as const;
export const PREVIEW_HTML_STORED =
  `<p id="preview-copy">Canonical stored preview</p><a id="external-preview-link" href="${PREVIEW_EXTERNAL_ORIGIN}/destination" target="_blank" rel="noopener noreferrer nofollow" referrerpolicy="no-referrer">External destination</a><img id="remote-preview-image" alt="Remote image remains inert" data-umail-remote-src="${PREVIEW_EXTERNAL_ORIGIN}/pixel.png">` as const;

function storedMailHtml(body: string): StoredMailHtml {
  return { body, hasRemoteImages: true };
}

export type MailHtmlPolicySanitizeCall = {
  readonly html: string;
  readonly sanitization: MailHtmlSanitization;
};

export class FaithfulMailHtmlPolicy implements MailHtmlPolicy {
  readonly sanitizeCalls: MailHtmlPolicySanitizeCall[] = [];
  readonly materializeCalls: MailHtmlMaterialization[] = [];
  private sanitizerFailure: MailHtmlPolicyError | null = null;
  private materializerFails = false;

  // A resource limit when given, else a rewrite failure.
  failSanitization(limit?: MailHtmlResourceLimit): void {
    this.sanitizerFailure =
      limit === undefined
        ? new MailHtmlPolicyError({ reason: "rewrite_failed" })
        : new MailHtmlPolicyError({ reason: "resource_exhausted", limit });
  }

  failMaterialization(): void {
    this.materializerFails = true;
  }

  sanitizeForStorage(
    html: string,
    sanitization: MailHtmlSanitization,
  ): Effect.Effect<StoredMailHtml, MailHtmlPolicyError> {
    return Effect.suspend(() => {
      this.sanitizeCalls.push({ html, sanitization });
      if (this.sanitizerFailure !== null) {
        return Effect.fail(this.sanitizerFailure);
      }
      if (html === REMOTE_HTML_SOURCE) {
        return Effect.succeed(storedMailHtml(REMOTE_HTML_STORED));
      }
      if (html === PREVIEW_HTML_SOURCE) {
        return Effect.succeed(storedMailHtml(PREVIEW_HTML_STORED));
      }
      return new MailHtmlPolicyError({ reason: "rewrite_failed" });
    });
  }

  materializeRemoteImages(
    materialization: MailHtmlMaterialization,
  ): Effect.Effect<string, MailHtmlPolicyError> {
    return Effect.suspend(() => {
      this.materializeCalls.push(materialization);
      if (this.materializerFails || materialization.body !== REMOTE_HTML_STORED) {
        return new MailHtmlPolicyError({ reason: "rewrite_failed" });
      }
      return Effect.succeed(REMOTE_HTML_MATERIALIZED);
    });
  }
}
