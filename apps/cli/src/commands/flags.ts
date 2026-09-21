import {
  MailContact,
  parseExternalMailAddress,
  parseMailboxAddress,
  parseUtcInstant,
  SubmissionRequestId,
} from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CliError from "effect/unstable/cli/CliError";
import * as Flag from "effect/unstable/cli/Flag";

export const idFlag = Flag.string("id").pipe(Flag.withDescription("Resource id"));

export const limitFlag = Flag.optional(
  Flag.integer("limit").pipe(Flag.withDescription("Maximum items to return")),
);

export const cursorFlag = Flag.optional(
  Flag.string("cursor").pipe(Flag.withDescription("Continue from a previous page")),
);

export const fromFlag = Flag.string("from").pipe(
  Flag.withDescription("Send from this mailbox address"),
  Flag.mapEffect((raw) => {
    const parsed = parseMailboxAddress(raw);
    if (parsed.kind === "invalid") {
      return Effect.fail(
        new CliError.InvalidValue({
          option: "from",
          value: raw,
          expected: "a valid mailbox address",
          kind: "flag",
        }),
      );
    }
    return Effect.succeed(parsed.address);
  }),
);

export const subjectFlag = Flag.string("subject").pipe(Flag.withDescription("Subject line"));

export const toFlag = recipientFlag("to").pipe(
  Flag.withDescription("Recipient (repeatable)"),
  Flag.atLeast(1),
);

export const ccFlag = recipientFlag("cc").pipe(
  Flag.withDescription("CC recipient (repeatable)"),
  Flag.atLeast(0),
);

export const textFlag = Flag.optional(
  Flag.string("text").pipe(Flag.withDescription("Plain-text body")),
);

export const htmlFlag = Flag.optional(Flag.string("html").pipe(Flag.withDescription("HTML body")));

export const requestIdFlag = Flag.optional(
  Flag.string("request-id").pipe(
    Flag.withDescription("Stable submission id; generated once when omitted"),
    Flag.mapEffect((raw) =>
      Schema.decodeEffect(SubmissionRequestId)(raw).pipe(
        Effect.mapError(
          () =>
            new CliError.InvalidValue({
              option: "request-id",
              value: raw,
              expected: "a UUID",
              kind: "flag",
            }),
        ),
      ),
    ),
  ),
);

export const sinceFlag = Flag.optional(
  Flag.string("since").pipe(
    Flag.withDescription("Occurred at or after this instant"),
    Flag.mapEffect((raw) => {
      const instant = parseUtcInstant(raw);
      if (instant === null) {
        return Effect.fail(
          new CliError.InvalidValue({
            option: "since",
            value: raw,
            expected: "a canonical UTC instant",
            kind: "flag",
          }),
        );
      }
      return Effect.succeed(instant);
    }),
  ),
);

export const sinceHoursFlag = Flag.optional(
  Flag.integer("since-hours").pipe(Flag.withDescription("Converted locally to --since")),
);

export const unreadFlag = Flag.boolean("unread").pipe(
  Flag.withDescription("Unread only"),
  Flag.withDefault(false),
);

export const directionFlag = Flag.optional(
  Flag.choice("direction", ["inbound", "outbound"]).pipe(
    Flag.withDescription("Filter by direction"),
  ),
);

export const replyToFlag = Flag.string("reply-to").pipe(
  Flag.withDescription("Reply to this message id"),
);

export const clientLabelFlag = Flag.optional(
  Flag.string("label").pipe(Flag.withDescription("Human-readable client label")),
);

export const sendModeFlag = Flag.optional(
  Flag.choice("send-mode", ["deny", "allow", "requireApproval"]).pipe(
    Flag.withDescription("How this client may send: deny, allow, or requireApproval"),
  ),
);

export const preapprovedFlag = Flag.optional(
  Flag.string("preapproved").pipe(
    Flag.withDescription(
      "Comma-separated recipients exempt from approval; only read for requireApproval",
    ),
  ),
);

export const mailboxesFlag = Flag.optional(
  Flag.string("mailboxes").pipe(
    Flag.withDescription("'all' or a comma-separated list of mailbox ids"),
  ),
);

export const recipientAllowlistFlag = Flag.optional(
  Flag.string("recipients").pipe(
    Flag.withDescription("'any' or a comma-separated recipient allowlist"),
  ),
);

export const activeFlag = Flag.optional(
  Flag.choice("active", ["true", "false"]).pipe(
    Flag.withDescription("Whether the client stays active"),
  ),
);

export const canReadFlag = Flag.optional(
  Flag.choice("can-read", ["true", "false"]).pipe(Flag.withDescription("Allow reading mail")),
);

export const canDeleteFlag = Flag.optional(
  Flag.choice("can-delete", ["true", "false"]).pipe(Flag.withDescription("Allow deleting mail")),
);

export const canAdminFlag = Flag.optional(
  Flag.choice("can-admin", ["true", "false"]).pipe(
    Flag.withDescription("Allow administration, including editing client policies"),
  ),
);

export const replyAllFlag = Flag.boolean("reply-all").pipe(
  Flag.withDescription("Reply All to the selected message"),
  Flag.withDefault(false),
);

export const tokenFileFlag = Flag.optional(
  Flag.string("token-file").pipe(
    Flag.withDescription("Read the approval token from a protected file; omit for a masked prompt"),
  ),
);

function recipientFlag(name: string) {
  return Flag.string(name).pipe(
    Flag.mapEffect((raw) => {
      const parsed = parseExternalMailAddress(raw);
      if (parsed.kind !== "ok") {
        return Effect.fail(
          new CliError.InvalidValue({
            option: name,
            value: raw,
            expected: "a valid recipient address",
            kind: "flag",
          }),
        );
      }
      return Effect.succeed(new MailContact({ address: parsed.address, displayName: null }));
    }),
  );
}
