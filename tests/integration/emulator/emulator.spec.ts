import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connect } from 'node:tls';
import type { TLSSocket } from 'node:tls';
import { promisify } from 'node:util';

import { test, expect } from '@playwright/test';

import { TvModel } from './model';
import { secretFor, pairingChallenge, matchesSecret } from './secret';
import { createTvEmulator } from './tv-emulator';
import { encode, decode, frame, FrameReader } from './wire';
import type { WireObject } from './wire';

const fixture = (name: string): string =>
  readFileSync(resolve(process.cwd(), 'tests/integration/fixtures/protocol', name), 'utf8');
const clientCert = fixture('client-certificate.pem');
const clientKey = fixture('client-key.pem');

for (const vector of JSON.parse(fixture('golden-vectors.json')).vectors) {
  test(`independent golden wire: ${vector.name}`, () => {
    const message = structuredClone(vector.message);
    if (message.remoteVoicePayload)
      message.remoteVoicePayload.samples = Buffer.from(message.remoteVoicePayload.samples.data);
    expect(encode(vector.kind, message).toString('hex')).toBe(vector.hex);
    expect(frame(Buffer.from(vector.hex, 'hex')).toString('hex')).toBe(vector.framedHex);
    const reader = new FrameReader();
    const bytes = Buffer.from(vector.framedHex, 'hex');
    expect(reader.push(bytes.subarray(0, 1))).toEqual([]);
    const frames = reader.push(bytes.subarray(1));
    expect(frames).toHaveLength(1);
    expect(decode(vector.kind, frames[0])).toEqual(message);
    reader.finish();
  });
}

test('golden certificate secret binds both RSA public keys and challenge', () => {
  const vector = JSON.parse(fixture('secret-vector.json'));
  const secret = secretFor(
    clientCert,
    fixture('server-certificate.pem'),
    Buffer.from(vector.challengeHex, 'hex')
  );
  expect(secret.toString('hex')).toBe(vector.secretHex);
  expect(
    pairingChallenge(
      clientCert,
      fixture('server-certificate.pem'),
      Buffer.from(vector.challengeHex, 'hex')
    ).code
  ).toBe(vector.code);
  expect(
    secretFor(
      fixture('server-certificate.pem'),
      clientCert,
      Buffer.from(vector.challengeHex, 'hex')
    )
  ).not.toEqual(secret);
  const damaged = Buffer.from(secret);
  damaged[2] ^= 1;
  expect(matchesSecret(secret, damaged)).toBe(false);
  expect(matchesSecret(secret, Buffer.alloc(0))).toBe(false);
});

test('framing rejects overflow/zero/truncation and preserves coalesced frames', () => {
  const reader = new FrameReader();
  const payload = Buffer.from('520408131003', 'hex');
  expect(reader.push(Buffer.concat([frame(payload), frame(payload)]))).toEqual([payload, payload]);
  expect(() => new FrameReader().push(Buffer.from([255, 255, 255, 255, 255]))).toThrow('varint');
  expect(() => new FrameReader().push(Buffer.from([0]))).toThrow('size');
  const truncated = new FrameReader();
  truncated.push(Buffer.from([3, 1]));
  expect(() => truncated.finish()).toThrow('truncated');
});

test('TV oracle applies Android actions rather than echoing key requests', () => {
  const model = new TvModel();
  model.key(19, 3);
  expect(model.state.cursor).toEqual({ x: 2, y: 1 });
  model.key(22, 1);
  model.key(22, 2);
  expect(model.state.cursor.x).toBe(3);
  model.key(23, 3);
  expect(model.state.screen).toBe('app');
  expect(model.state.selected).toBe(1);
  model.key(3, 3);
  expect(model.state.screen).toBe('home');
  model.key(24, 3);
  expect(model.state.volume).toBe(21);
  model.key(25, 3);
  expect(model.state.volume).toBe(20);
  model.key(85, 3);
  expect(model.state.playing).toBe(true);
  model.key(26, 3);
  expect(model.state.powered).toBe(false);
  expect(() => model.key(999, 3)).toThrow('unsupported');
  expect(() => model.key(19, 2)).toThrow('without');
  expect(() => model.key(19, 0)).toThrow('direction');
});

test('Unicode IME counters reject stale sessions and preserve supplementary characters', () => {
  const model = new TvModel();
  model.text('東京 🎬 é', 1, 1);
  expect(model.state.text).toBe('東京 🎬 é');
  expect(() => model.text('stale', 1, 1)).toThrow('stale');
  model.text('😀', 2, 1);
  model.key(67, 3);
  expect(model.state.text).toBe('');
  model.text('', 3, 1);
  expect(model.state.imeCounter).toBe(4);
});

test('assistant PCM oracle validates 8kHz PCM16LE tone and session ordering', () => {
  const model = new TvModel();
  expect(() => model.voicePayload(1, Buffer.alloc(8192))).toThrow('outside');
  const id = model.offerVoice();
  model.voiceBegin(id);
  const pcm = Buffer.alloc(16000);
  for (let sample = 0; sample < 8000; sample++)
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * sample) / 8000) * 8191), sample * 2);
  model.voicePayload(id, pcm);
  model.voiceEnd(id);
  expect(model.state.voice.valid).toBe(true);
  expect(model.state.voice.frequencyHz).toBeGreaterThan(410);
  const invalid = model.offerVoice();
  model.voiceBegin(invalid);
  model.voicePayload(invalid, Buffer.alloc(8192));
  expect(() => model.voiceEnd(invalid)).toThrow('invalid PCM signal');
  expect(() => model.voiceBegin(invalid + 1)).toThrow('session');
});

class Peer {
  readonly socket: TLSSocket;
  private frames: Buffer[] = [];
  private waiting?: PromiseWithResolvers<WireObject>;
  private readonly reader = new FrameReader();
  private failure?: Error;
  constructor(
    port: number,
    ca: string,
    private readonly kind: 'pairing' | 'remote',
    host = '127.0.0.1'
  ) {
    this.socket = connect({
      host,
      port,
      ca,
      cert: clientCert,
      key: clientKey,
      rejectUnauthorized: true,
    });
    this.socket.on('data', (chunk) => {
      for (const bytes of this.reader.push(chunk)) {
        if (this.waiting) {
          const pending = this.waiting;
          this.waiting = undefined;
          pending.resolve(decode(this.kind, bytes));
        } else this.frames.push(bytes);
      }
    });
    this.socket.on('error', (error) => {
      this.failure = error;
      this.waiting?.reject(error);
    });
    this.socket.on('close', () => {
      this.waiting?.reject(this.failure ?? new Error('peer closed'));
    });
  }
  send(message: WireObject): void {
    this.socket.write(
      frame(
        encode(
          this.kind,
          this.kind === 'pairing' ? { protocolVersion: 2, status: 200, ...message } : message
        )
      )
    );
  }
  async next(): Promise<WireObject> {
    if (this.failure) throw this.failure;
    if (this.frames.length) return decode(this.kind, this.frames.shift()!);
    if (this.socket.destroyed) throw new Error('peer closed');
    if (this.waiting) throw new Error('concurrent peer reads');
    const pending = Promise.withResolvers<WireObject>();
    this.waiting = pending;
    const timeout = setTimeout(() => pending.reject(new Error('peer reply timed out')), 3000);
    try {
      return await pending.promise;
    } finally {
      clearTimeout(timeout);
      if (this.waiting === pending) this.waiting = undefined;
    }
  }
  async close(): Promise<void> {
    if (this.socket.closed) return;
    const closed = Promise.withResolvers<void>();
    this.socket.once('close', () => closed.resolve());
    this.socket.destroy();
    await closed.promise;
  }
}

test('real mutually verified TLS pairing authorizes only certificate-bound secrets then remote resumes', async () => {
  const tv = await createTvEmulator();
  const peers: Peer[] = [];
  try {
    tv.trustClient(clientCert);
    await tv.start();
    const unpaired = new Peer(tv.remotePort, tv.certificatePem, 'remote');
    peers.push(unpaired);
    await expect(unpaired.next()).rejects.toThrow();
    const pair = new Peer(tv.pairingPort, tv.certificatePem, 'pairing');
    peers.push(pair);
    pair.send({
      pairingRequest: { serviceName: 'androidtvremote2', clientName: 'Independent fixture peer' },
    });
    expect((await pair.next()).pairingRequestAck.serverName).toBe('Synthetic Google TV');
    pair.send({
      pairingOption: { inputEncodings: [{ type: 3, symbolLength: 6 }], preferredRole: 1 },
    });
    await pair.next();
    pair.send({ pairingConfiguration: { encoding: { type: 3, symbolLength: 6 }, clientRole: 1 } });
    await pair.next();
    pair.send({ pairingSecret: { secret: Buffer.alloc(32) } });
    expect((await pair.next()).status).toBe(402);
    expect(tv.snapshot().pairedClients).toBe(0);
    const secret = secretFor(
      clientCert,
      tv.certificatePem,
      Buffer.from(tv.pairingCode.slice(2), 'hex')
    );
    pair.send({ pairingSecret: { secret } });
    expect((await pair.next()).status).toBe(200);
    expect(tv.snapshot().pairedClients).toBe(1);
    for (let connection = 1; connection <= 2; connection++) {
      const remote = new Peer(tv.remotePort, tv.certificatePem, 'remote', tv.host);
      peers.push(remote);
      const config = await remote.next();
      remote.send({ remoteConfigure: { code1: config.remoteConfigure.code1 } });
      await remote.next();
      remote.send({ remoteSetActive: { active: config.remoteConfigure.code1 } });
      expect((await remote.next()).remoteStart.started).toBe(true);
      await remote.next();
      remote.send({ remoteKeyInject: { keyCode: 19, direction: 3 } });
      await tv.waitFor((state) => state.cursor.y === 2 - connection);
      if (connection === 1) {
        remote.send({
          remoteImeBatchEdit: {
            imeCounter: 1,
            fieldCounter: 1,
            editInfo: [{ insert: 1, textFieldStatus: { value: '世界 🎬' } }],
          },
        });
        const ime = await remote.next();
        expect(ime.remoteImeBatchEdit.imeCounter).toBe(2);
        expect(tv.snapshot().text).toBe('世界 🎬');
        remote.send({ remoteKeyInject: { keyCode: 84, direction: 1 } });
        remote.send({ remoteKeyInject: { keyCode: 84, direction: 2 } });
        const offer = await remote.next();
        const sessionId = offer.remoteVoiceBegin.sessionId;
        remote.send({ remoteVoiceBegin: { sessionId } });
        const pcm = Buffer.alloc(16000);
        for (let sample = 0; sample < 8000; sample++)
          pcm.writeInt16LE(
            Math.round(Math.sin((2 * Math.PI * 440 * sample) / 8000) * 8191),
            sample * 2
          );
        remote.send({ remoteVoicePayload: { sessionId, samples: pcm } });
        await tv.waitFor((state) => state.voice.samples === 8000);
        remote.send({ remoteVoiceEnd: { sessionId } });
        await tv.waitFor((state) => state.voice.phase === 'ended' && state.voice.valid);
        // Two synchronous TV responses previously interleaved length-prefix fragments.
        // Assert both complete protobuf frames arrive in exact emission order.
        await tv.setFault('fragment');
        const sequences = [tv.sendPing(), tv.sendPing()];
        for (const sequence of sequences) {
          const response = await remote.next();
          expect(response.remotePingRequest.val1).toBe(sequence);
          remote.send({ remotePingResponse: { val1: sequence } });
        }
        await tv.waitFor((state) => state.pingReplies === 2);
        await tv.setFault('none');
      }
      tv.sendPing();
      const ping = await remote.next();
      remote.send({ remotePingResponse: { val1: ping.remotePingRequest.val1 } });
      await tv.waitFor((state) => state.pingReplies === connection + 2);
      await remote.close();
      await tv.waitFor((state) => !state.connected);
      if (connection === 1) await tv.migrateHost('127.0.0.2');
    }
  } finally {
    await Promise.all(peers.map((peer) => peer.close()));
    await tv.stop();
  }
});

test('native dns-sd subprocess emits mutable duplicates, escapes, empty, malformed and errors', async () => {
  const tv = await createTvEmulator();
  const run = promisify(execFile);
  const command = resolve(process.cwd(), 'tests/integration/fixtures/bin/dns-sd.cjs');
  const options = { env: { ...process.env, GTV_DNS_SD_STATE: tv.discoveryStatePath } };
  try {
    await tv.setDiscovery([
      {
        name: 'TV "A" \\ lounge',
        duplicate: 2,
        txt: { fn: 'TV "A" \\ lounge', bt: '02:00:00:00:00:01' },
      },
    ]);
    const browse = await run(command, ['-B', '_androidtvremote2._tcp', 'local.'], options);
    expect(browse.stdout.match(/ Add /g)).toHaveLength(2);
    expect(browse.stdout).toContain('TV "A" \\ lounge');
    const lookup = await run(
      command,
      ['-L', 'TV "A" \\ lounge', '_androidtvremote2._tcp', 'local.'],
      options
    );
    expect(lookup.stdout).toContain(`can be reached at synthetic-tv.local.:${tv.remotePort}`);
    const slash = String.fromCharCode(92);
    expect(lookup.stdout).toContain(
      [
        'fn=TV',
        slash + ' ',
        slash + '"A' + slash + '"',
        slash + ' ',
        slash.repeat(4),
        slash + ' lounge',
      ].join('')
    );
    const address = await run(command, ['-G', 'v4', 'synthetic-tv.local.'], options);
    expect(address.stdout).toContain('127.0.0.1 120');
    await tv.setDiscovery([]);
    expect(
      (await run(command, ['-B', '_androidtvremote2._tcp', 'local.'], options)).stdout
    ).not.toContain(' Add ');
    await tv.setDiscovery([], { malformed: true });
    expect(
      (await run(command, ['-L', 'missing', '_androidtvremote2._tcp', 'local.'], options)).stdout
    ).toContain('malformed');
    await tv.setDiscovery([], { error: 'synthetic discovery failure' });
    await expect(run(command, ['-B', '_androidtvremote2._tcp', 'local.'], options)).rejects.toThrow(
      'synthetic discovery failure'
    );
  } finally {
    await tv.stop();
  }
});

test('TLS admission refuses absent client certificates and waiters dispose deterministically', async () => {
  const tv = await createTvEmulator();
  let socket: TLSSocket | undefined;
  try {
    tv.trustClient(clientCert);
    await tv.start();
    socket = connect({
      host: tv.host,
      port: tv.pairingPort,
      ca: tv.certificatePem,
      rejectUnauthorized: true,
    });
    const closed = Promise.withResolvers<void>();
    socket.on('error', () => undefined);
    socket.once('close', () => closed.resolve());
    const timeout = setTimeout(
      () => closed.reject(new Error('unauthorized TLS did not close')),
      3000
    );
    try {
      await closed.promise;
    } finally {
      clearTimeout(timeout);
    }
    expect(tv.snapshot().pairingSessions).toBe(0);
    const wait = tv.waitFor((state) => state.ready);
    const rejected = expect(wait).rejects.toThrow('stopped');
    await tv.stop();
    await rejected;
  } finally {
    socket?.destroy();
    await tv.stop();
  }
});

test('PCM oracle rejects wrong sample rate, byte order and expired session payloads', () => {
  for (const [sampleRate, byteOrder] of [
    [16000, 'LE'],
    [8000, 'BE'],
  ] as const) {
    const model = new TvModel();
    const id = model.offerVoice();
    model.voiceBegin(id);
    const pcm = Buffer.alloc(16000);
    for (let sample = 0; sample < 8000; sample++) {
      const value = Math.round(Math.sin((2 * Math.PI * 440 * sample) / sampleRate) * 8191);
      if (byteOrder === 'LE') pcm.writeInt16LE(value, sample * 2);
      else pcm.writeInt16BE(value, sample * 2);
    }
    model.voicePayload(id, pcm);
    expect(() => model.voiceEnd(id)).toThrow('invalid PCM signal');
    expect(model.state.voice.valid).toBe(false);
    expect(() => model.voicePayload(id, pcm)).toThrow('outside');
  }
});

test('malformed external wiki pairing request is a negative fixture, not a golden oracle', () => {
  // The wiki claims a 43-byte nested request but supplies only 38 bytes.
  const malformed = Buffer.from(
    '080210c801522b0a15696e666f2e6b6f646f6e6f2e617373697374616e74120d696e7465726661636520776562',
    'hex'
  );
  expect(() => decode('pairing', malformed)).toThrow();
});
