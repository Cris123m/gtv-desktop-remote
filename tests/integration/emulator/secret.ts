import { createHash, createPublicKey, randomBytes, timingSafeEqual } from 'node:crypto';

function rsaBytes(cert: string | Buffer): Buffer[] {
  const key = createPublicKey(cert).export({ format: 'jwk' });
  if (key.kty !== 'RSA' || !key.n || !key.e) throw new Error('pairing requires RSA certificates');
  return [Buffer.from(key.n, 'base64url'), Buffer.from(key.e, 'base64url')];
}
export function secretFor(
  client: string | Buffer,
  server: string | Buffer,
  challenge: Uint8Array
): Buffer {
  if (challenge.length !== 2) throw new Error('pairing challenge must contain two bytes');
  const hash = createHash('sha256');
  for (const part of [...rsaBytes(client), ...rsaBytes(server)]) hash.update(part);
  return hash.update(challenge).digest();
}
export function pairingChallenge(
  client: string | Buffer,
  server: string | Buffer,
  challenge = randomBytes(2)
) {
  const secret = secretFor(client, server, challenge);
  return {
    secret,
    code: Buffer.concat([secret.subarray(0, 1), challenge])
      .toString('hex')
      .toUpperCase(),
  };
}
export function matchesSecret(expected: Buffer, actual: Uint8Array): boolean {
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}
