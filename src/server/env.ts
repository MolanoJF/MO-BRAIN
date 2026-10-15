export type Env = {
  port: number;
  databaseUrl: string;
  gbrainUrl: string;
  publicUrl: string;
  encryptionKey: string;
  gbrainVersion: string;
  uiDir: string;
  secureCookies: boolean;
};

type Source = Record<string, string | undefined>;

function required(src: Source, key: string): string {
  const v = src[key]?.trim();
  if (!v) throw new Error(`${key} is required`);
  return v;
}

export function loadEnv(src: Source = process.env): Env {
  const encryptionKey = required(src, 'ENCRYPTION_KEY');
  if (encryptionKey.length < 32) throw new Error('ENCRYPTION_KEY must be at least 32 characters');
  const publicUrl = (src.MOBRAIN_PUBLIC_URL?.trim() || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  return {
    port: Number(src.PORT ?? 3000),
    databaseUrl: required(src, 'DATABASE_URL'),
    gbrainUrl: (src.GBRAIN_URL?.trim() || 'http://gbrain:3131').replace(/\/+$/, ''),
    publicUrl,
    encryptionKey,
    gbrainVersion: required(src, 'GBRAIN_VERSION'),
    uiDir: src.MOBRAIN_UI_DIR?.trim() || 'dist/ui',
    secureCookies: publicUrl.startsWith('https://'),
  };
}
