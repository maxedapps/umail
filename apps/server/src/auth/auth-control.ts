import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export const AuthDb = Cloudflare.D1.Database("AuthDb").pipe(Alchemy.RemovalPolicy.retain());

export class ProvisionedOperator extends Context.Service<
  ProvisionedOperator,
  {
    readonly operatorId: Alchemy.Input<string>;
  }
>()("uMail/ProvisionedOperator") {}

export const AUTH_CONTROL_TABLE = "umailAuthControl" as const;
export const AUTH_CONTROL_ROW_ID = "operator" as const;

export const AUTH_CONTROL_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${AUTH_CONTROL_TABLE} (
  id TEXT PRIMARY KEY NOT NULL,
  operatorId TEXT NOT NULL,
  canonicalEmail TEXT NOT NULL,
  credentialGeneration INTEGER NOT NULL,
  ready INTEGER NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
)` as const;

export type AuthControl = {
  readonly operatorId: string;
  readonly canonicalEmail: string;
  readonly credentialGeneration: number;
  readonly ready: boolean;
};

export type AuthControlDatabase = {
  prepare(query: string): {
    bind(...values: ReadonlyArray<string | number | null>): {
      first(): Promise<AuthControlRow | null>;
    };
  };
};

type AuthControlRow = {
  readonly [column: string]: string | number | null;
};

const ControlRow = Schema.Struct({
  operatorId: Schema.String,
  canonicalEmail: Schema.String,
  credentialGeneration: Schema.Finite,
  ready: Schema.Literals([0, 1]),
});

export async function readAuthControl(database: AuthControlDatabase): Promise<AuthControl | null> {
  const row = await database
    .prepare(
      `SELECT operatorId, canonicalEmail, credentialGeneration, ready
       FROM ${AUTH_CONTROL_TABLE}
       WHERE id = ?`,
    )
    .bind(AUTH_CONTROL_ROW_ID)
    .first();
  if (row === null) return null;
  const decoded = Schema.decodeUnknownResult(ControlRow)(row);
  if (Result.isFailure(decoded)) {
    throw new Error("umailAuthControl row is not a valid control record");
  }
  return {
    operatorId: decoded.success.operatorId,
    canonicalEmail: decoded.success.canonicalEmail,
    credentialGeneration: decoded.success.credentialGeneration,
    ready: decoded.success.ready === 1,
  };
}
