import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { packEnvValue } from "alchemy/RuntimeContext";
import { Array as EffectArray, Config, Context, Effect } from "effect";
import { currentSite, rootDomain, stageKeepsData, stageSendsMail } from "../site.ts";
import { EmailRoutingDomain } from "./receiving-domain.ts";
import { mailDomains } from "./domains.ts";
import { ReceivingDomainUnsafe } from "./receiving-domain.ts";

export class DeploymentMailDomains extends Context.Service<
  DeploymentMailDomains,
  {
    readonly domainsJson: Alchemy.Input<string>;
    readonly legacySeedsJson: Alchemy.Input<string>;
    readonly legacyZone: Alchemy.Input<string> | null;
  }
>()("umail/DeploymentMailDomains") {}

// Deferred lookups are inert during graph construction and runtime. Zone IDs consumed by the
// app come from resource outputs, so the Worker never looks up zones with its rules-only token.
export const mailDomainResources = Effect.gen(function* () {
  const site = yield* currentSite;
  const stage = yield* Alchemy.Stage;
  const root = yield* rootDomain;
  const configured = yield* mailDomains;
  const outputs = [];
  const seeds = [];
  let legacyZone: Alchemy.Input<string> | null = null;
  const transferSeeds = yield* Config.Boolean("UMAIL_LEGACY_SEED_RULES").pipe(
    Config.withDefault(false),
  );
  for (const [domain, base] of EffectArray.zip(site.mailDomains, configured)) {
    const baseName = base.name;
    const suffix = baseName === root ? "" : `_${baseName}`;
    const lookup = Output.fromEffect(
      Effect.gen(function* () {
        const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
        return yield* Cloudflare.Zone.resolveZoneId({
          accountId,
          hostname: domain.name,
          zone: undefined,
        }).pipe(Effect.orDie);
      }),
    );
    let zoneId = lookup;
    if (domain.receive) {
      const receiving = yield* EmailRoutingDomain(`MailRoutingDomain${suffix}`, {
        zoneId: lookup,
        name: domain.name,
      }).pipe(Alchemy.RemovalPolicy.retain(stageKeepsData(stage)));
      zoneId = receiving.zoneId;
      if (domain.name === root) legacyZone = receiving.zoneId;
    }
    if (domain.send && stageSendsMail(stage)) {
      yield* Cloudflare.Email.SendingSubdomain(`MailSending${suffix}`, {
        zoneId,
        name: domain.name,
      });
    }
    if (transferSeeds && site.kind === "preview" && domain.name === site.mailDomain) {
      for (const localPart of site.testLocalParts) {
        const address = `${localPart}@${domain.name}`;
        // This provider retains observed actions; it never reconciles these into a routing write.
        const rule = yield* Cloudflare.Email.Rule(`Mail_${localPart}`, {
          zone: zoneId,
          matchers: [{ type: "literal", field: "to", value: address }],
          actions: [],
        }).pipe(Alchemy.RemovalPolicy.retain());
        seeds.push(
          Output.all(rule.ruleId, rule.zoneId).pipe(
            Output.map(([id, zone]) => ({ id, zoneId: zone, address })),
          ),
        );
      }
    }
    outputs.push(zoneId.pipe(Output.map((id) => ({ ...domain, zoneId: id }))));
  }
  return DeploymentMailDomains.of({
    // Explicit env strings bypass RuntimeContext.set. Pack JSON strings so runtime get
    // preserves them as strings for Config's JSON schema instead of reinterpreting an array.
    domainsJson: Output.all(...outputs).pipe(
      Output.map((domains) => packEnvValue(JSON.stringify(domains))),
    ),
    legacySeedsJson: Output.all(...seeds).pipe(
      Output.map((rules) => packEnvValue(JSON.stringify(rules))),
    ),
    legacyZone,
  });
});

export const configureMailRouting = Effect.fn("configureMailRouting")(function* (
  workerName: Alchemy.Input<string>,
) {
  const legacy = yield* Config.Boolean("UMAIL_LEGACY_CATCH_ALL").pipe(Config.withDefault(false));
  if (!legacy) return;
  const site = yield* currentSite;
  if (site.kind !== "prod") return;
  const root = yield* rootDomain;
  if (!site.mailDomains.some((domain) => domain.name === root && domain.receive))
    return yield* new ReceivingDomainUnsafe({
      message:
        "UMAIL_LEGACY_CATCH_ALL requires the existing UMAIL_DOMAIN in the receiving manifest.",
    });
  const registrations = yield* DeploymentMailDomains;
  const zone = registrations.legacyZone;
  if (zone === null)
    return yield* new ReceivingDomainUnsafe({
      message: "UMAIL_LEGACY_CATCH_ALL requires this installation's existing receiving zone.",
    });
  yield* Cloudflare.Email.CatchAll("MailCatchAll", {
    zone,
    actions: [{ type: "worker", value: [workerName] }],
  }).pipe(Alchemy.RemovalPolicy.retain());
});
