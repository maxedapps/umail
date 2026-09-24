import {
  MailContact,
  parseExternalMailAddress,
  parseMailboxAddress,
  parseUtcInstant,
  SubmissionRequestId,
} from "@umail/api-contract";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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
  Flag.filterMap(
    (raw) => {
      const parsed = parseMailboxAddress(raw);
      return parsed.kind === "invalid" ? Option.none() : Option.some(parsed.address);
    },
    () => "a valid mailbox address",
  ),
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
    Flag.filterMap(Schema.decodeOption(SubmissionRequestId), () => "a UUID"),
  ),
);

export const sinceFlag = Flag.optional(
  Flag.string("since").pipe(
    Flag.withDescription("Occurred at or after this instant"),
    Flag.filterMap(
      (raw) => Option.fromNullOr(parseUtcInstant(raw)),
      () => "a canonical UTC instant",
    ),
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

export const forwardEmailFlag = Flag.string("email").pipe(
  Flag.withDescription("Inbox to forward to"),
  Flag.filterMap(
    (raw) => {
      const parsed = parseExternalMailAddress(raw);
      return parsed.kind === "ok" ? Option.some(parsed.address) : Option.none();
    },
    () => "a valid email address",
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
    Flag.filterMap(
      (raw) => {
        const parsed = parseExternalMailAddress(raw);
        return parsed.kind === "ok"
          ? Option.some(new MailContact({ address: parsed.address, displayName: null }))
          : Option.none();
      },
      () => "a valid recipient address",
    ),
  );
}
