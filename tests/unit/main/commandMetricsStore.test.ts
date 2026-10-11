import { describe, expect, it, vi } from 'vitest';

import { CommandMetricsStore } from '../../../src/main/metrics';
import type { CommandDispatchRequest } from '../../../src/shared/types';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

describe('CommandMetricsStore bounded retention', () => {
  const request = (id: string): CommandDispatchRequest => ({
    id,
    command: 'right',
    source: 'keyboard',
    issuedAt: 1_000,
  });

  it('conserves terminal counters through a drop burst and aged serial admissions', () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const store = new CommandMetricsStore();
    const first = request('sent-0');
    store.recordIpcReceived(first);
    store.recordAdapterDispatchStart(first);
    store.recordBridgeSendStart(first, 'tv');

    // Drops arrive while the first real send is awaiting its transport.
    for (let index = 0; index < 150; index += 1) {
      now += 1;
      store.recordRendererDrop({
        ...request(`drop-${String(index)}`),
        droppedAt: now,
        dropReason: 'renderer_burst_limit',
        pendingCommandCount: 100,
      });
    }
    const duringBurst = store.getSnapshot();
    expect(duringBurst.recentCommands).toHaveLength(40);
    expect(duringBurst.recentCommands.find((record) => record.id === first.id)?.status).toBe(
      'pending'
    );

    for (let index = 0; index < 100; index += 1) {
      now += 1;
      const queued = request(`sent-${String(index)}`);
      if (index > 0) {
        store.recordIpcReceived(queued);
        store.recordAdapterDispatchStart(queued);
        store.recordBridgeSendStart(queued, 'tv');
      }
      store.recordSocketWrite(queued, { host: 'tv', buffered: false });
      store.recordCommandSucceeded(queued.id);
      store.recordAdapterDispatchCompleted(queued.id);
    }

    const completed = store.getSnapshot();
    expect(completed.counters).toMatchObject({
      totalSubmitted: 250,
      totalSucceeded: 100,
      totalDropped: 150,
      totalFailed: 0,
      rendererDrops: 150,
    });
    expect(completed.recentCommands).toHaveLength(40);
    expect(completed.recentCommands.map((record) => record.id)).toEqual(
      Array.from({ length: 40 }, (_, index) => `sent-${String(99 - index)}`)
    );
    expect(
      completed.recentCommands.every(
        (record) =>
          record.status === 'sent' &&
          record.lastStage === 'completed' &&
          record.completedAt === record.updatedAt &&
          record.issuedAt === 1_000
      )
    ).toBe(true);
    expect(store.getSnapshot().counters).toEqual(completed.counters);
  });

  it('retains a newly admitted aged request when activity timestamps tie', () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const store = new CommandMetricsStore();
    for (let index = 0; index < 40; index += 1) {
      store.recordRendererDrop({
        ...request(`drop-${String(index)}`),
        droppedAt: 10_000,
        dropReason: 'renderer_burst_limit',
        pendingCommandCount: 100,
      });
    }

    const queued = request('aged');
    store.recordIpcReceived(queued);
    store.recordAdapterDispatchStart(queued);
    store.recordSocketWrite(queued, { host: 'tv', buffered: false });
    store.recordCommandSucceeded(queued.id);

    const snapshot = store.getSnapshot();
    expect(snapshot.counters.totalSubmitted).toBe(41);
    expect(snapshot.counters.totalSucceeded).toBe(1);
    expect(snapshot.recentCommands.find((record) => record.id === queued.id)).toMatchObject({
      issuedAt: 1_000,
      ipcReceivedAt: 10_000,
      socketWriteAt: 10_000,
      completedAt: 10_000,
      status: 'sent',
    });
    expect(snapshot.recentCommands).toHaveLength(40);
  });

  it('keeps the hard retention bound even when every record is pending', () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const store = new CommandMetricsStore();
    for (let index = 0; index < 80; index += 1) {
      now += 1;
      store.recordIpcReceived(request(`pending-${String(index)}`));
    }
    expect(store.getSnapshot().recentCommands.map((record) => record.id)).toEqual(
      Array.from({ length: 40 }, (_, index) => `pending-${String(79 - index)}`)
    );

    // Out-of-policy records are truly evicted, not hidden in a pending side store.
    for (let index = 0; index < 40; index += 1) {
      store.recordCommandSucceeded(`pending-${String(index)}`);
    }
    expect(store.getSnapshot().counters.totalSucceeded).toBe(0);
    for (let index = 40; index < 80; index += 1) {
      store.recordCommandSucceeded(`pending-${String(index)}`);
    }
    expect(store.getSnapshot().counters).toMatchObject({
      totalSubmitted: 80,
      totalSucceeded: 40,
    });
    expect(store.getSnapshot().recentCommands.every((record) => record.status === 'sent')).toBe(
      true
    );
  });
});
