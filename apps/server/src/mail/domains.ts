import { Config, Schema, SchemaTransformation } from "effect";
import { MailDomain } from "@umail/api-contract";

export const ConfiguredMailDomain = Schema.String.pipe(
  Schema.decode(
    SchemaTransformation.composeTransformation(
      SchemaTransformation.trim(),
      SchemaTransformation.toLowerCase(),
    ),
  ),
  Schema.decodeTo(
    MailDomain.check(
      Schema.isPattern(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, {
        message: "must be a hostname like mail.example.com (no scheme, path or port).",
      }),
    ),
  ),
);

export const MailDomainConfiguration = Schema.Struct({
  name: ConfiguredMailDomain,
  receive: Schema.Boolean,
  send: Schema.Boolean,
}).check(
  Schema.makeFilter((domain) => domain.receive || domain.send, {
    message: "must receive or send mail.",
  }),
);
export type MailDomainConfiguration = typeof MailDomainConfiguration.Type;

export const MailDomainManifest = Schema.Array(MailDomainConfiguration).check(
  Schema.isMinLength(1),
  Schema.makeFilter((domains) => new Set(domains.map(({ name }) => name)).size === domains.length, {
    message: "must name each mail domain only once.",
  }),
  Schema.makeFilter((domains) => domains.some(({ receive }) => receive), {
    message: "must include a receiving domain.",
  }),
);
export const mailDomains = Config.schema(
  Schema.fromJsonString(MailDomainManifest),
  "UMAIL_MAIL_DOMAINS",
);

export const ResolvedMailDomain = Schema.Struct({
  name: MailDomain,
  receive: Schema.Boolean,
  send: Schema.Boolean,
  zoneId: Schema.String,
});
export type ResolvedMailDomain = typeof ResolvedMailDomain.Type;
