import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { stageKeepsData } from "./site.ts";

// The stack's stateful resources. Kept apart from the mail and account logic so tests can import
// that logic without pulling deployment code into workerd.

// Deploy time knows the stage. The Worker's runtime has none and only resolves bindings, where the
// removal policy never applies, so it keeps the prod answer.
const keepsData = Effect.serviceOption(Alchemy.Stage).pipe(
  Effect.map(Option.match({ onNone: () => true, onSome: stageKeepsData })),
);

export const AuthDb = Cloudflare.D1.Database("AuthDb").pipe(
  Alchemy.RemovalPolicy.retain(keepsData),
);

// R2 refuses to delete a bucket that still holds objects, so a preview's archive is emptied first.
export const MailArchive = Cloudflare.R2.Bucket(
  "MailArchive",
  keepsData.pipe(Effect.map((keep) => (keep ? {} : { forceDestroy: true }))),
).pipe(Alchemy.RemovalPolicy.retain(keepsData));

export const MailIndex = Cloudflare.Queues.Queue("MailIndex");

// The HMAC key behind approval links: minted once, kept in alchemy's encrypted state.
export const NotificationKey = Alchemy.Random("NotificationKey");

export class ProvisionedOperator extends Context.Service<
  ProvisionedOperator,
  {
    readonly operatorId: Alchemy.Input<string>;
  }
>()("uMail/ProvisionedOperator") {}
