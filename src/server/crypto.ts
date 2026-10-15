import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function kek(master: string, salt: Buffer): Buffer {
  // FROZEN FOREVER: an HKDF domain separator, not a product name. Changing it
  // makes every sealed token undecryptable. lint:forbidden guards it.
  return Buffer.from(hkdfSync('sha256', Buffer.from(master, 'utf8'), salt, Buffer.from('mobrain-kek-v1'), 32));
}

function encrypt(key: Buffer, plain: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv(ALG, key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

function decrypt(key: Buffer, blob: string): Buffer {
  const raw = Buffer.from(blob, 'base64');
  const d = createDecipheriv(ALG, key, raw.subarray(0, IV_LEN));
  d.setAuthTag(raw.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([d.update(raw.subarray(IV_LEN + TAG_LEN)), d.final()]);
}

/** Envelope seal: a random DEK encrypts the text; a per-value KEK wraps the DEK. */
export function seal(master: string, plaintext: string): string {
  const salt = randomBytes(16);
  const dek = randomBytes(32);
  return ['v1', salt.toString('base64'), encrypt(kek(master, salt), dek), encrypt(dek, Buffer.from(plaintext, 'utf8'))].join(':');
}

export function open(master: string, sealed: string): string {
  const [v, salt, wrapped, payload] = sealed.split(':');
  if (v !== 'v1' || !salt || !wrapped || !payload) throw new Error('not a sealed value');
  const dek = decrypt(kek(master, Buffer.from(salt, 'base64')), wrapped);
  return decrypt(dek, payload).toString('utf8');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
