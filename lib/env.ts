// Configuration comes from the environment only (`node --env-file=.env`).
// Validated once, at start, so a wrong seed fails here with a sentence and
// not later as an opaque 401 from Abillio.
export type Env = {
  apiUrl: string;
  keyId: string;
  seedHex: string;
  account: string;
  publicUrl: string | null;
  port: number;
  // ALLOW_PRODUCTION=1: the step buttons may write to a production account.
  allowProduction: boolean;
};

const DEFAULT_API_URL = 'https://backend.abillio.dev/company-api/v1';

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const keyId = (source.ABILLIO_API_KEY_ID ?? '').trim();
  if (!keyId) throw new Error('ABILLIO_API_KEY_ID is missing: copy .env.example to .env and fill it in.');
  const seedHex = (source.ABILLIO_PRIVATE_KEY ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(seedHex)) {
    throw new Error(
      'ABILLIO_PRIVATE_KEY must be the 64 hex characters Abillio showed when the key was created (the raw Ed25519 seed), not a PEM file.',
    );
  }
  const publicUrl = (source.PUBLIC_URL ?? '').trim();
  const port = Number(source.PORT ?? '4000');
  if (!Number.isInteger(port) || port <= 0) throw new Error('PORT must be a positive integer.');
  return {
    apiUrl: trimSlash((source.ABILLIO_API_URL ?? '').trim() || DEFAULT_API_URL),
    keyId,
    seedHex,
    account: (source.ABILLIO_ACCOUNT ?? '').trim(),
    publicUrl: publicUrl ? trimSlash(publicUrl) : null,
    port,
    allowProduction: (source.ALLOW_PRODUCTION ?? '').trim() === '1',
  };
}
