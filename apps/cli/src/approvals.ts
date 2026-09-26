import { ApprovalToken, type ApprovalDecisionState } from "@umail/api-contract";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Terminal from "effect/Terminal";
import * as Prompt from "effect/unstable/cli/Prompt";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { publicApprovalClient } from "./client.ts";
import { UnexpectedResponse, fromHttpClientError } from "./errors.ts";

type ApprovalDecisionCommand = "approve" | "deny";

type ApprovalTokenInputErrorReason = "interrupted" | "invalid" | "unreadable";

const approvalTokenInputErrorMessages = {
  interrupted: "Approval token input was interrupted",
  invalid: "Approval token must be 64 lowercase hexadecimal characters",
  unreadable: "Could not read approval token file",
} as const satisfies Record<ApprovalTokenInputErrorReason, string>;

interface ApprovalTokenInputErrorFields {
  readonly reason: ApprovalTokenInputErrorReason;
}

export class ApprovalTokenInputError extends Data.TaggedError(
  "ApprovalTokenInputError",
)<ApprovalTokenInputErrorFields> {
  override readonly message = approvalTokenInputErrorMessages[this.reason];
}

export interface ApprovalTokenSourceService {
  readonly readToken: (
    tokenFile: string | undefined,
  ) => Effect.Effect<ApprovalToken, ApprovalTokenInputError>;
}

export class ApprovalTokenSource extends Context.Service<
  ApprovalTokenSource,
  ApprovalTokenSourceService
>()("umail/ApprovalTokenSource") {
  static readonly layer = Layer.effect(
    ApprovalTokenSource,
    Effect.gen(function* () {
      const terminal = yield* Terminal.Terminal;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const promptToken = Prompt.password({ message: "Approval token" }).pipe(
        Effect.provideService(Terminal.Terminal, terminal),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(() => new ApprovalTokenInputError({ reason: "interrupted" })),
        Effect.flatMap((token) => decodeApprovalToken(Redacted.value(token))),
      );
      return ApprovalTokenSource.of({
        readToken: (tokenFile) => {
          if (tokenFile === undefined) {
            return promptToken;
          }
          return fileSystem.readFileString(tokenFile).pipe(
            Effect.mapError(() => new ApprovalTokenInputError({ reason: "unreadable" })),
            Effect.map(removeOneTrailingLineEnding),
            Effect.flatMap(decodeApprovalToken),
          );
        },
      });
    }),
  );
}

// The server's answer about the token. The messages never repeat the token or the request URL.
class ApprovalRefused extends Data.TaggedError("ApprovalRefused")<{
  readonly reason: "unknown" | "gone";
}> {
  override readonly message =
    this.reason === "unknown"
      ? "This approval token is not recognized."
      : "This approval is no longer available.";
}

// Named without the request path, which carries the token.
const APPROVAL_STEP = "the approval request";

interface ApprovalDecisionOutput {
  readonly state: ApprovalDecisionState;
}

export const decideApproval = Effect.fn("decideApproval")(function* (
  command: ApprovalDecisionCommand,
  tokenFile: string | undefined,
  httpClient: HttpClient.HttpClient,
) {
  const client = yield* publicApprovalClient(httpClient);
  const tokenSource = yield* ApprovalTokenSource;
  const token = yield* tokenSource.readToken(tokenFile);
  const request =
    command === "approve"
      ? client.PublicApprovals.approveApproval({ params: { token } })
      : client.PublicApprovals.denyApproval({ params: { token } });
  const response = yield* request.pipe(
    Effect.catchTags({
      ApprovalPageNotFound: () => Effect.fail(new ApprovalRefused({ reason: "unknown" })),
      ApprovalPageGone: () => Effect.fail(new ApprovalRefused({ reason: "gone" })),
      HttpClientError: (error) => fromHttpClientError(error, APPROVAL_STEP),
      SchemaError: () =>
        Effect.fail(new UnexpectedResponse({ detail: `${APPROVAL_STEP} answered unreadably` })),
    }),
  );
  return {
    state: response.headers["x-umail-approval-state"],
  } satisfies ApprovalDecisionOutput;
});

function decodeApprovalToken(value: string) {
  return Schema.decodeEffect(ApprovalToken)(value).pipe(
    Effect.mapError(() => new ApprovalTokenInputError({ reason: "invalid" })),
  );
}

function removeOneTrailingLineEnding(value: string) {
  if (value.endsWith("\r\n")) {
    return value.slice(0, -2);
  }
  if (value.endsWith("\n")) {
    return value.slice(0, -1);
  }
  return value;
}
