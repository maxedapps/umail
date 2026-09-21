import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import {
  MailHtmlPolicyError,
  type MailHtmlMaterialization,
  type MailHtmlPolicy,
  type MailHtmlSanitization,
  type StoredMailHtml,
} from "@umail/mail-content";

import {
  ArchiveTransportError,
  type MailArchiveReader,
  type InstantClock,
} from "../../src/api/app.ts";
import {
  DestinationsError,
  type CloudflareDestination,
  type DestinationsClient,
} from "../../src/api/destinations.ts";

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

export class MemoryApprovalClock implements InstantClock {
  #current = DateTime.makeUnsafe("2026-08-28T10:00:00.000Z");

  get now() {
    return Effect.sync(() => this.#current);
  }

  set(iso: string): void {
    this.#current = DateTime.makeUnsafe(iso);
  }
}

export class MemoryDestinations implements DestinationsClient {
  readonly items = new Map<string, CloudflareDestination>();
  readonly createCalls: string[] = [];
  readonly getCalls: string[] = [];
  readonly deleteCalls: string[] = [];
  #failMessage: string | null = null;

  failNext(message: string): void {
    this.#failMessage = message;
  }

  create(email: string): Effect.Effect<CloudflareDestination, DestinationsError> {
    return Effect.suspend(() => {
      this.createCalls.push(email);
      if (this.#failMessage !== null) {
        const message = this.#failMessage;
        this.#failMessage = null;
        return new DestinationsError({ reason: "http_failed", message });
      }
      const destination: CloudflareDestination = {
        cloudflareId: crypto.randomUUID(),
        email,
        verifiedAt: null,
      };
      this.items.set(destination.cloudflareId, destination);
      return Effect.succeed(destination);
    });
  }

  get(cloudflareId: string): Effect.Effect<CloudflareDestination, DestinationsError> {
    return Effect.suspend(() => {
      this.getCalls.push(cloudflareId);
      const item = this.items.get(cloudflareId);
      if (item === undefined) {
        return new DestinationsError({
          reason: "missing",
          message: "Could not create the forwarding destination.",
        });
      }
      return Effect.succeed(item);
    });
  }

  delete(cloudflareId: string): Effect.Effect<void, DestinationsError> {
    return Effect.suspend(() => {
      this.deleteCalls.push(cloudflareId);
      if (this.#failMessage !== null) {
        const message = this.#failMessage;
        this.#failMessage = null;
        return new DestinationsError({ reason: "http_failed", message });
      }
      this.items.delete(cloudflareId);
      return Effect.void;
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
  private sanitizerFails = false;
  private materializerFails = false;

  failSanitization(): void {
    this.sanitizerFails = true;
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
      if (this.sanitizerFails) {
        return new MailHtmlPolicyError({ reason: "rewrite_failed" });
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
