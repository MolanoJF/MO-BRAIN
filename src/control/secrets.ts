import { randomBytes, createCipheriv, createDecipheriv, hkdfSync, randomUUID } from 'node:crypto';
import { eq, and, desc } from 'drizzle-orm';
import { getDb, schema } from './db/client.ts';

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

export type Sealed = { version: number; salt: string; wrappedDek: string; payload: string };

/** KEK derived per secret from ENCRYPTION_KEY + a random salt. */
function deriveKek(salt: Buffer): Buffer {
  const master = process.env.ENCRYPTION_KEY;
  if (!master || master.length < 32) throw new Error('ENCRYPTION_KEY must be at least 32 characters');
  // FROZEN FOREVER (D3). This is an HKDF domain separator, not a product name.
  // Changing it makes every existing sealed secret permanently undecryptable.
  // `lint:forbidden`'s frozen-crypto-domain rule fails the build if you try.
  return Buffer.from(hkdfSync('sha256', Buffer.from(master, 'utf8'), salt, Buffer.from('mobrain-kek-v1'), 32));
}

function encrypt(key: Buffer, plaintext: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function decrypt(key: Buffer, blob: string): Buffer {
  const raw = Buffer.from(blob, 'base64');
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(raw.subarray(IV_LEN + TAG_LEN)), decipher.final()]);
}

export function seal(plaintext: string, version = 1): Sealed {
  const salt = randomBytes(16);
  const kek = deriveKek(salt);
  const dek = randomBytes(32);
  return {
    version,
    salt: salt.toString('base64'),
    wrappedDek: encrypt(kek, dek),
    payload: encrypt(dek, Buffer.from(plaintext, 'utf8')),
  };
}

export function open(sealed: Sealed): string {
  const kek = deriveKek(Buffer.from(sealed.salt, 'base64'));
  const dek = decrypt(kek, sealed.wrappedDek);
  return decrypt(dek, sealed.payload).toString('utf8');
}

export async function storeSecret(orgId: string, name: string, plaintext: string) {
  const db = getDb();
  const [latest] = await db.select({ version: schema.secrets.version })
    .from(schema.secrets)
    .where(and(eq(schema.secrets.organizationId, orgId), eq(schema.secrets.name, name)))
    .orderBy(desc(schema.secrets.version)).limit(1);

  const version = (latest?.version ?? 0) + 1;
  const sealed = seal(plaintext, version);
  const id = randomUUID();
  await db.insert(schema.secrets).values({
    id, organizationId: orgId, name, version,
    salt: sealed.salt, wrappedDek: sealed.wrappedDek, payload: sealed.payload,
  });
  return { id, version };
}

export async function readSecret(orgId: string, name: string): Promise<string | null> {
  const [row] = await getDb().select().from(schema.secrets)
    .where(and(eq(schema.secrets.organizationId, orgId), eq(schema.secrets.name, name)))
    .orderBy(desc(schema.secrets.version)).limit(1);
  return row ? open({ version: row.version, salt: row.salt, wrappedDek: row.wrappedDek, payload: row.payload }) : null;
}

/**
 * Rotation writes a NEW version; old versions stay readable until reaped.
 * Rotation is not revocation — outstanding gbrain tokens survive it.
 */
export async function rotateSecret(orgId: string, name: string, plaintext: string) {
  const { version } = await storeSecret(orgId, name, plaintext);
  await getDb().update(schema.secrets)
    .set({ rotatedAt: new Date() })
    .where(and(eq(schema.secrets.organizationId, orgId), eq(schema.secrets.name, name)));
  return { version };
}
