import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { test, expect } from './app-harness';

test('PAIR-CHECKSUM: wrong certificate-bound hexadecimal checksum rejects then valid retry pairs', async ({
  harness: h,
}) => {
  const device = await h.pair();
  await h.api('disconnect');
  await h.api('startPairing', device.id);
  const valid = h.tv.pairingCode;
  const invalid = `${valid[0] === 'A' ? 'B' : 'A'}${valid.slice(1)}`;
  await expect(
    h.api('pair', {
      deviceId: device.id,
      host: device.host,
      code: invalid,
      macAddress: device.macAddress,
    })
  ).rejects.toThrow();
  await h.api('startPairing', device.id);
  await h.api('pair', {
    deviceId: device.id,
    host: device.host,
    code: h.tv.pairingCode,
    macAddress: device.macAddress,
  });
  expect((await h.api('connect', device.id)).status).toBe('connected');
});

test('PAIR-CERTIFICATE-REJECTION: replaced app credential cannot reuse paired authorization', async ({
  harness: h,
}) => {
  const device = await h.pair();
  await h.api('disconnect');
  const certificate = await h.certificate();
  const directory = path.join(h.profile, 'androidtvremote');
  const files = await readdir(directory);
  await h.app.close();
  for (const file of files.filter((file) => file.endsWith('.pem')))
    await rm(path.join(directory, file));
  await h.launch();
  await expect(h.api('connect', device.id)).rejects.toThrow();
  expect((await h.api('bootstrap')).deviceState.status).toBe('error');
  expect(await h.certificate()).not.toBe(certificate);
  expect(h.tv.snapshot().ready).toBe(false);
  expect(h.tv.traces.some((trace) => trace.service === 'tls' && trace.direction === 'error')).toBe(
    true
  );
  // Restoring only the public certificate cannot authorize its mismatched generated private key.
  const name = (await readdir(directory)).find((file) => file.endsWith('.cert.pem'));
  if (!name) throw new Error('Replacement certificate missing');
  expect(await readFile(path.join(directory, name), 'utf8')).not.toBe(certificate);
});

test('PAIR-UI-NONHEX: malformed user input cannot submit a six-hex exchange', async ({
  harness: h,
}) => {
  await h.preparePairing();
  await h.openPairing();
  const input = h.page.locator('input[autocomplete="one-time-code"]');
  await input.fill('OO00FF');
  await expect(input).toHaveValue('00FF');
  await expect(h.page.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
  await input.fill(h.tv.pairingCode);
  await h.page.getByRole('button', { name: 'Connect', exact: true }).click();
  await h.tv.waitFor((state) => state.ready);
});
