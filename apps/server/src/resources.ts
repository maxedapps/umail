import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";

// The stack's stateful resources. Kept apart from the mail and account logic so tests can import
// that logic without pulling deployment code into workerd.

export const AuthDb = Cloudflare.D1.Database("AuthDb").pipe(Alchemy.RemovalPolicy.retain());

export const MailArchive = Cloudflare.R2.Bucket("MailArchive").pipe(Alchemy.RemovalPolicy.retain());

export const MailIndex = Cloudflare.Queues.Queue("MailIndex");

// The HMAC key behind approval links: minted once, kept in alchemy's encrypted state.
export const NotificationKey = Alchemy.Random("NotificationKey");

export class ProvisionedOperator extends Context.Service<
  ProvisionedOperator,
  {
    readonly operatorId: Alchemy.Input<string>;
  }
>()("uMail/ProvisionedOperator") {}
