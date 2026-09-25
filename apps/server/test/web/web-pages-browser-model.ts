import * as Schema from "effect/Schema";

export const WebPageBrowserFixture = Schema.Literals([
  "login",
  "consent",
  "client",
  "mail-thread",
  "compose",
  "pending",
  "accepted",
  "failed",
  "queued",
  "denied",
  "expired",
  "unknown",
]);
export type WebPageBrowserFixture = typeof WebPageBrowserFixture.Type;

export const WebPageBrowserColorScheme = Schema.Literals(["light", "dark"]);
export type WebPageBrowserColorScheme = typeof WebPageBrowserColorScheme.Type;

export class WebPageBrowserVisit extends Schema.Class<WebPageBrowserVisit>("WebPageBrowserVisit")({
  fixture: WebPageBrowserFixture,
  colorScheme: WebPageBrowserColorScheme,
  viewportWidth: Schema.Finite,
  viewportHeight: Schema.Finite,
  search: Schema.optionalKey(Schema.String),
}) {}

const BrowserFormButtonObservation = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  formAction: Schema.String,
});

export const WebPageBrowserObservation = Schema.Struct({
  status: Schema.Finite,
  contentType: Schema.NullOr(Schema.String),
  contentSecurityPolicy: Schema.NullOr(Schema.String),
  frameOptions: Schema.NullOr(Schema.String),
  title: Schema.String,
  heading: Schema.String,
  bodyText: Schema.String,
  formCount: Schema.Finite,
  formMethod: Schema.NullOr(Schema.String),
  formAction: Schema.NullOr(Schema.String),
  buttons: Schema.Array(BrowserFormButtonObservation),
  keyboardFocusId: Schema.NullOr(Schema.String),
  keyboardFocusText: Schema.NullOr(Schema.String),
  focusOutlineStyle: Schema.NullOr(Schema.String),
  focusOutlineWidth: Schema.NullOr(Schema.String),
  controlHeight: Schema.NullOr(Schema.Finite),
  scriptNonce: Schema.NullOr(Schema.String),
  preapprovedShownWithApproval: Schema.NullOr(Schema.Boolean),
  preapprovedShownWhenNever: Schema.NullOr(Schema.Boolean),
  revokePopoverOpen: Schema.NullOr(Schema.Boolean),
  frameImageWidth: Schema.NullOr(Schema.Finite),
  firstTimeText: Schema.NullOr(Schema.String),
  textareaGrowth: Schema.NullOr(Schema.Finite),
  statusText: Schema.NullOr(Schema.String),
  authRequestPath: Schema.NullOr(Schema.String),
  authRequestMethod: Schema.NullOr(Schema.String),
  authRequestBody: Schema.NullOr(Schema.String),
  finalPath: Schema.String,
  hostileElementCount: Schema.Finite,
  metadataText: Schema.NullOr(Schema.String),
  metadataBidiControlCount: Schema.Finite,
  automaticIsolationCount: Schema.Finite,
  addressIsolationCount: Schema.Finite,
  sectionsSeparated: Schema.NullOr(Schema.Boolean),
  documentClientWidth: Schema.Finite,
  documentScrollWidth: Schema.Finite,
  bodyBackground: Schema.String,
  bodyColor: Schema.String,
  darkSchemeMatches: Schema.Boolean,
  iframeSandbox: Schema.NullOr(Schema.String),
  previewContentSecurityPolicy: Schema.NullOr(Schema.String),
  previewFrameOptions: Schema.NullOr(Schema.String),
  previewBodyText: Schema.NullOr(Schema.String),
  previewUrlBeforeActivation: Schema.NullOr(Schema.String),
  previewUrlAfterActivation: Schema.NullOr(Schema.String),
  externalRequests: Schema.Array(Schema.String),
  openedPageCount: Schema.Finite,
  consoleMessages: Schema.Array(Schema.String),
});
export type WebPageBrowserObservation = typeof WebPageBrowserObservation.Type;

declare module "vitest/browser" {
  interface BrowserCommands {
    observeWebPage(visit: WebPageBrowserVisit): Promise<WebPageBrowserObservation>;
  }
}
