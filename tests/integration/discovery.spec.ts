import { test, expect } from './app-harness';

for (const service of ['_androidtvremote2._tcp', '_googlecast._tcp', 'adb'] as const) {
  test(`DISCOVERY-${service}: production native parser handles service, duplicates and punctuation`, async ({
    harness: h,
  }) => {
    const name = 'Synthetic: TV "Living Room" \\ café 世界';
    await h.tv.setDiscovery([
      {
        name,
        service,
        host: h.tv.host,
        port: h.tv.remotePort,
        duplicate: 2,
        txt: { id: 'synthetic-cast', fn: name, md: 'Synthetic Model', bt: '02:00:00:00:00:01' },
      },
    ]);
    if (service === 'adb')
      await h.tv.setDiscovery([
        {
          name,
          service: '_googlecast._tcp',
          host: h.tv.host,
          duplicate: 2,
          txt: { fn: name, md: 'Synthetic Model', id: 'synthetic-cast' },
        },
        { name, service: '_adb-tls-connect._tcp', host: h.tv.host, port: 5555 },
        { name, service: '_adb-tls-pairing._tcp', host: h.tv.host, port: h.tv.pairingPort },
      ]);
    const records = await h.api('scanDevices');
    expect(records).toHaveLength(1);
    expect(records[0].name).toBe(name);
    expect(records[0].source).toBe(
      service === 'adb' ? 'adb' : service === '_googlecast._tcp' ? 'googlecast' : 'androidtvremote'
    );
    if (service === 'adb') {
      expect(records[0].adbPort).toBe(5555);
      expect(records[0].pairingPort).toBe(h.tv.pairingPort);
    }
    await h.page.getByRole('button', { name: "Don't see your device?", exact: true }).click();
    await expect(h.page.getByRole('button').filter({ hasText: name })).toHaveCount(1);
  });
}

for (const mode of ['empty', 'malformed', 'error'] as const) {
  test(`DISCOVERY-${mode}: scanner releases busy and subsequent refresh recovers`, async ({
    harness: h,
  }) => {
    await h.tv.setDiscovery(
      [],
      mode === 'error'
        ? { error: 'Synthetic native discovery failure' }
        : mode === 'malformed'
          ? { malformed: true }
          : {}
    );
    await h.page.getByRole('button', { name: "Don't see your device?", exact: true }).click();
    await expect(h.page.getByText('No new devices detected right now.')).toBeVisible();
    await h.tv.setDiscovery([{ name: 'Recovered TV', host: h.tv.host }]);
    await h.page.getByRole('button', { name: "Don't see your device?", exact: true }).click();
    await expect(h.page.getByRole('button').filter({ hasText: 'Recovered TV' })).toBeVisible();
  });
}

test('DISCOVERY-IDENTITY-MIGRATION: stable MAC preserves saved id and actual credential across address changes', async ({
  harness: h,
}) => {
  const saved = await h.pair();
  const certificate = await h.certificate();
  await h.api('disconnect');
  await h.tv.migrateHost('127.0.0.2');
  await h.tv.setDiscovery([
    {
      name: 'Renamed TV',
      host: h.tv.host,
      port: h.tv.remotePort,
      txt: { bt: '02:00:00:00:00:01', md: 'Synthetic Model' },
    },
  ]);
  await h.api('scanDevices');
  const migrated = (await h.api('bootstrap')).devices;
  expect(migrated).toHaveLength(1);
  expect(migrated[0].id).toBe(saved.id);
  expect(migrated[0].host).toBe('127.0.0.2');
  expect(await h.certificate()).toBe(certificate);
  expect((await h.api('connect', saved.id)).status).toBe('connected');
  await h.api('disconnect');
  await h.tv.migrateHost('127.0.0.1');
  await h.tv.setDiscovery([
    {
      name: 'Synthetic TV',
      host: h.tv.host,
      port: h.tv.remotePort,
      txt: { bt: '02:00:00:00:00:01' },
    },
  ]);
  await h.api('scanDevices');
  expect((await h.api('connect', saved.id)).status).toBe('connected');
  expect(h.tv.snapshot().pairedClients).toBe(1);
});
