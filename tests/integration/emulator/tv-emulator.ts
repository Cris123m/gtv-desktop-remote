import { X509Certificate } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:tls';
import type { Server, TLSSocket } from 'node:tls';

import forge from 'node-forge';

import { TvModel } from './model';
import type { TvState, VoiceExpectation } from './model';
import { pairingChallenge, matchesSecret } from './secret';
import { encode, decode, frame, FrameReader } from './wire';
import type { WireObject } from './wire';
export type { TvState, VoiceExpectation } from './model';
export interface DiscoveryRecord {
  name: string;
  service?: string;
  hostName?: string;
  host?: string;
  port?: number;
  txt?: Record<string, string>;
  duplicate?: number;
  malformed?: boolean;
}
export interface DiscoveryOptions {
  available?: boolean;
  error?: string;
  malformed?: boolean;
}
export type FaultMode =
  | 'none'
  | 'pairing-silence'
  | 'pairing-reject'
  | 'remote-silence'
  | 'remote-reject'
  | 'voice-silence'
  | 'fragment'
  | 'coalesce'
  | 'invalid-frame'
  | 'truncated-frame'
  | 'refuse';
export interface TvEmulatorOptions {
  start?: boolean;
  host?: string;
  discoveryStatePath?: string;
  voice?: VoiceExpectation;
}
export interface ProtocolTrace {
  sequence: number;
  service: 'pairing' | 'remote' | 'tls';
  direction: 'rx' | 'tx' | 'error';
  message: string;
  bytes?: number;
}

async function unusedPorts(host: string): Promise<number[]> {
  const reservations = [createNetServer(), createNetServer()];
  try {
    const ports: number[] = [];
    for (const server of reservations) {
      const listening = Promise.withResolvers<void>();
      server.once('error', listening.reject);
      server.listen(0, host, () => listening.resolve());
      await listening.promise;
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no loopback port');
      ports.push(address.port);
    }
    return ports;
  } finally {
    await Promise.all(
      reservations.map((server) => {
        if (!server.listening) return Promise.resolve();
        const closed = Promise.withResolvers<void>();
        server.close((error) => (error ? closed.reject(error) : closed.resolve()));
        return closed.promise;
      })
    );
  }
}
function certificate(): { cert: string; key: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date('2020-01-01T00:00:00Z');
  cert.validity.notAfter = new Date('2040-01-01T00:00:00Z');
  const attributes = [{ name: 'commonName', value: 'Synthetic Google TV regression emulator' }];
  cert.setSubject(attributes);
  cert.setIssuer(attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 7, ip: '127.0.0.1' },
        { type: 7, ip: '127.0.0.2' },
        { type: 2, value: 'localhost' },
      ],
    },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
}
export class TvEmulator extends EventEmitter {
  readonly certificatePem: string;
  host: string;
  readonly remotePort: number;
  readonly pairingPort: number;
  readonly discoveryStatePath: string;
  pairingCode = '';
  readonly traces: ProtocolTrace[] = [];
  private readonly credentials: { cert: string; key: string };
  private readonly model: TvModel;
  private readonly trusted = new Map<string, string>();
  private readonly paired = new Set<string>();
  private readonly sockets = new Set<TLSSocket>();
  private readonly remoteSockets = new Set<TLSSocket>();
  private readonly sendQueues = new Map<TLSSocket, { chunks: Buffer[]; end: boolean }[]>();
  private servers: Server[] = [];
  private fault: FaultMode = 'none';
  private capabilities = 623;
  private sequence = 0;
  private pingSequence = 0;
  private pendingPings = new Set<number>();
  private started = false;
  private stopped = false;
  private constructor(
    options: TvEmulatorOptions,
    ports: number[],
    private readonly temporaryDirectory: string
  ) {
    super();
    this.host = options.host ?? '127.0.0.1';
    [this.pairingPort, this.remotePort] = ports;
    this.discoveryStatePath =
      options.discoveryStatePath ?? join(temporaryDirectory, 'discovery.json');
    this.credentials = certificate();
    this.certificatePem = this.credentials.cert;
    this.model = new TvModel(options.voice);
  }
  static async create(options: TvEmulatorOptions = {}): Promise<TvEmulator> {
    const host = options.host ?? '127.0.0.1';
    if (!/^127\.\d+\.\d+\.\d+$/.test(host)) throw new Error('emulator requires IPv4 loopback');
    const directory = await mkdtemp(join(tmpdir(), 'gtv-emulator-'));
    try {
      const emulator = new TvEmulator(options, await unusedPorts(host), directory);
      await emulator.setDiscovery([
        {
          name: 'Synthetic Google TV',
          host,
          port: emulator.remotePort,
          txt: { bt: '02:00:00:00:00:01', fn: 'Synthetic Google TV', md: 'Regression TV' },
        },
      ]);
      if (options.start) await emulator.start();
      return emulator;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  trustClient(pem: string): void {
    const cert = new X509Certificate(pem);
    if (this.started)
      throw new Error('trust clients before start; stop listeners before adding trust');
    this.trusted.set(cert.fingerprint256, pem);
  }
  async start(): Promise<void> {
    if (this.stopped) throw new Error('emulator already disposed');
    if (this.started) return;
    if (!this.trusted.size) throw new Error('TLS requires explicit trusted client certificate');
    if (this.fault === 'refuse') return;
    try {
      for (const [service, port] of [
        ['pairing', this.pairingPort],
        ['remote', this.remotePort],
      ] as const) {
        const server = createServer(
          {
            ...this.credentials,
            ca: [...this.trusted.values()],
            requestCert: true,
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2',
          },
          (socket) => this.accept(socket, service)
        );
        this.servers.push(server);
        server.on('tlsClientError', (error) => this.trace('tls', 'error', error.message));
        const listening = Promise.withResolvers<void>();
        server.once('error', listening.reject);
        server.listen(port, this.host, () => listening.resolve());
        await listening.promise;
      }
      this.started = true;
    } catch (error) {
      await this.closeListeners();
      throw error;
    }
  }
  private accept(socket: TLSSocket, service: 'pairing' | 'remote'): void {
    const peer = socket.getPeerCertificate();
    if (!socket.authorized || !peer.raw) {
      socket.destroy();
      this.fail('unauthorized TLS client');
      return;
    }
    const fingerprint = new X509Certificate(peer.raw).fingerprint256;
    if (!this.trusted.has(fingerprint) || (service === 'remote' && !this.paired.has(fingerprint))) {
      this.fail('remote client has not completed pairing');
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    const reader = new FrameReader();
    let stage = 0;
    let negotiatedFeatures = 0;
    let expectedSecret: Buffer = Buffer.alloc(0);
    if (service === 'pairing') {
      const challenge = pairingChallenge(
        new X509Certificate(peer.raw).toString(),
        this.certificatePem
      );
      this.pairingCode = challenge.code;
      expectedSecret = challenge.secret;
      this.model.state.pairingSessions++;
    } else {
      this.remoteSockets.add(socket);
      this.model.state.remoteConnections++;
      this.model.state.connected = true;
      if (this.fault === 'remote-reject') {
        socket.destroy();
        this.fail('remote deliberately rejected');
      } else
        this.send(socket, service, {
          remoteConfigure: {
            code1: this.capabilities,
            deviceInfo: { model: 'Regression TV', vendor: 'Synthetic', appVersion: '1.0' },
          },
        });
    }
    this.changed();
    socket.on('error', (error) => this.trace('tls', 'error', error.message));
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.sendQueues.delete(socket);
      if (this.remoteSockets.delete(socket) && this.remoteSockets.size === 0)
        this.model.disconnect();
      try {
        reader.finish();
      } catch (error) {
        this.fail((error as Error).message);
      }
      this.changed();
    });
    socket.on('data', (chunk) => {
      try {
        for (const bytes of reader.push(chunk)) {
          const message = decode(service, bytes);
          this.trace(service, 'rx', Object.keys(message).join(','), bytes.length);
          if (service === 'pairing') {
            if (message.protocolVersion !== 2 || message.status !== 200)
              throw new Error('invalid pairing version/status');
            if (Object.keys(message).filter((key) => key.startsWith('pairing')).length !== 1)
              throw new Error('pairing requires exactly one operation');
            if (stage === 0 && message.pairingRequest) {
              if (!message.pairingRequest.serviceName || !message.pairingRequest.clientName)
                throw new Error('invalid pairing request');
              this.send(socket, service, {
                pairingRequestAck: { serverName: 'Synthetic Google TV' },
              });
              stage = 1;
            } else if (stage === 1 && message.pairingOption) {
              if (
                !message.pairingOption.inputEncodings?.some(
                  (encoding: WireObject) => encoding.type === 3 && encoding.symbolLength === 6
                )
              )
                throw new Error('unsupported pairing encoding');
              this.send(socket, service, {
                pairingOption: {
                  outputEncodings: [{ type: 3, symbolLength: 6 }],
                  preferredRole: 2,
                },
              });
              stage = 2;
            } else if (stage === 2 && message.pairingConfiguration) {
              const config = message.pairingConfiguration;
              if (
                config.encoding?.type !== 3 ||
                config.encoding?.symbolLength !== 6 ||
                config.clientRole !== 1
              )
                throw new Error('invalid pairing configuration');
              this.send(socket, service, { pairingConfigurationAck: {} });
              stage = 3;
            } else if (stage === 3 && message.pairingSecret) {
              if (
                this.fault === 'pairing-reject' ||
                !matchesSecret(expectedSecret, message.pairingSecret.secret ?? Buffer.alloc(0))
              ) {
                this.send(socket, service, { status: 402, pairingSecretAck: {} });
                this.fail('pairing secret rejected');
              } else {
                this.paired.add(fingerprint);
                this.model.state.pairedClients = this.paired.size;
                this.send(socket, service, { pairingSecretAck: { secret: expectedSecret } });
                stage = 4;
              }
            } else throw new Error('pairing message out of sequence');
          } else {
            if (stage === 0 && message.remoteConfigure) {
              if (
                !(message.remoteConfigure.code1 & 2) ||
                message.remoteConfigure.code1 & ~this.capabilities
              )
                throw new Error('invalid remote capabilities');
              negotiatedFeatures = message.remoteConfigure.code1;
              this.send(socket, service, { remoteSetActive: { active: negotiatedFeatures } });
              stage = 1;
            } else if (stage === 1 && message.remoteSetActive) {
              if (message.remoteSetActive.active !== negotiatedFeatures)
                throw new Error('remote active capabilities mismatch');
              this.model.state.ready = true;
              stage = 2;
              const start = { remoteStart: { started: this.model.state.powered } };
              // Keep both frames in one transmission so coalesce actually exercises two frames.
              if (negotiatedFeatures & 4) this.send(socket, service, start, this.imeMessage());
              else this.send(socket, service, start);
            } else if (stage !== 2) throw new Error('remote message before handshake');
            else {
              const operations = Object.keys(message).filter((key) => key.startsWith('remote'));
              if (operations.length !== 1) throw new Error('remote requires exactly one operation');
              if (message.remoteImeBatchEdit && !(negotiatedFeatures & 4))
                throw new Error('IME capability not negotiated');
              if (
                (message.remoteVoiceBegin ||
                  message.remoteVoicePayload ||
                  message.remoteVoiceEnd) &&
                !(negotiatedFeatures & 8)
              )
                throw new Error('voice capability not negotiated');
              this.handleRemote(socket, message);
            }
          }
          this.changed();
        }
      } catch (error) {
        this.fail((error as Error).message);
        if (service === 'pairing')
          this.send(socket, service, { status: 401, pairingConfigurationAck: {} });
        socket.end();
      }
    });
  }
  private handleRemote(socket: TLSSocket, message: WireObject): void {
    if (message.remoteKeyInject) {
      const key = message.remoteKeyInject;
      if (this.model.key(key.keyCode ?? 0, key.direction ?? 0) && this.fault !== 'voice-silence') {
        this.send(socket, 'remote', {
          remoteVoiceBegin: {
            sessionId: this.model.offerVoice(),
            packageName: 'com.synthetic.assistant',
          },
        });
      }
      if (key.keyCode === 26)
        this.send(socket, 'remote', { remoteStart: { started: this.model.state.powered } });
      if ([24, 25].includes(key.keyCode))
        this.send(socket, 'remote', {
          remoteSetVolumeLevel: {
            volumeMax: 100,
            volumeLevel: this.model.state.volume,
            volumeMuted: false,
          },
        });
    } else if (message.remoteImeBatchEdit) {
      const edit = message.remoteImeBatchEdit;
      if (
        !edit.editInfo?.length ||
        edit.editInfo.some(
          (item: WireObject) => item.insert !== 1 || typeof item.textFieldStatus?.value !== 'string'
        )
      )
        throw new Error('invalid IME batch edit');
      const text = edit.editInfo.map((item: WireObject) => item.textFieldStatus.value).join('');
      this.model.text(text, edit.imeCounter, edit.fieldCounter);
      this.send(socket, 'remote', this.imeMessage());
    } else if (message.remoteVoiceBegin) this.model.voiceBegin(message.remoteVoiceBegin.sessionId);
    else if (message.remoteVoicePayload)
      this.model.voicePayload(
        message.remoteVoicePayload.sessionId,
        message.remoteVoicePayload.samples ?? Buffer.alloc(0)
      );
    else if (message.remoteVoiceEnd) this.model.voiceEnd(message.remoteVoiceEnd.sessionId);
    else if (message.remotePingResponse) {
      if (!this.pendingPings.delete(message.remotePingResponse.val1))
        throw new Error('unexpected ping response');
      this.model.state.pingReplies++;
    } else if (message.remoteAppLinkLaunchRequest) {
      const link = message.remoteAppLinkLaunchRequest.appLink;
      if (!link || !/^[a-z][a-z\d+.-]*:/i.test(link)) throw new Error('invalid app link');
      this.model.state.app = link;
      this.model.state.screen = 'app';
    } else throw new Error(`unsupported remote message ${Object.keys(message).join(',')}`);
  }
  private imeMessage(): WireObject {
    const state = this.model.state;
    return {
      remoteImeBatchEdit: {
        imeCounter: state.imeCounter,
        fieldCounter: state.fieldCounter,
        editInfo: [
          {
            insert: 1,
            textFieldStatus: {
              start: Math.max(0, state.text.length - 1),
              end: Math.max(0, state.text.length - 1),
              value: state.text,
            },
          },
        ],
      },
    };
  }
  private send(socket: TLSSocket, service: 'pairing' | 'remote', ...messages: WireObject[]): void {
    if (this.fault === `${service}-silence` || socket.destroyed) return;
    const packets = messages.map((message) => {
      const bytes = encode(
        service,
        service === 'pairing' ? { protocolVersion: 2, status: 200, ...message } : message
      );
      this.trace(service, 'tx', Object.keys(message).join(','), bytes.length);
      return frame(bytes);
    });
    let chunks = packets;
    if (this.fault === 'invalid-frame') chunks = [Buffer.from([255, 255, 255, 255, 255])];
    else if (this.fault === 'truncated-frame')
      chunks = [packets[0].subarray(0, packets[0].length - 1)];
    else if (this.fault === 'fragment') {
      const bytes = Buffer.concat(packets);
      chunks = [bytes.subarray(0, 1), bytes.subarray(1)];
    } else if (this.fault === 'coalesce') chunks = [Buffer.concat(packets)];
    const transmission = { chunks, end: this.fault === 'truncated-frame' };
    const queue = this.sendQueues.get(socket);
    if (queue) queue.push(transmission);
    else {
      this.sendQueues.set(socket, [transmission]);
      this.flushSend(socket);
    }
  }
  private flushSend(socket: TLSSocket): void {
    const queue = this.sendQueues.get(socket);
    if (!queue?.length || socket.destroyed) {
      this.sendQueues.delete(socket);
      return;
    }
    const transmission = queue[0];
    let index = 0;
    const writeNext = (): void => {
      if (socket.destroyed) {
        this.sendQueues.delete(socket);
        return;
      }
      if (index === transmission.chunks.length) {
        queue.shift();
        if (transmission.end) {
          this.sendQueues.delete(socket);
          socket.end();
        } else if (queue.length) this.flushSend(socket);
        else this.sendQueues.delete(socket);
        return;
      }
      socket.write(transmission.chunks[index++], (error) => {
        if (error) {
          this.sendQueues.delete(socket);
          this.fail('TLS response write failed');
          socket.destroy();
        } else writeNext();
      });
    };
    writeNext();
  }
  snapshot(): TvState {
    return structuredClone(this.model.state);
  }
  waitFor(
    predicate: (state: TvState) => boolean,
    options: { timeout?: number } = {}
  ): Promise<TvState> {
    const { promise, resolve, reject } = Promise.withResolvers<TvState>();
    const listener = (): void => {
      try {
        const state = this.snapshot();
        if (predicate(state)) {
          cleanup();
          resolve(state);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`TV state wait timed out; trace=${JSON.stringify(this.traces.slice(-15))}`));
    }, options.timeout ?? 5000);
    const disposed = (): void => {
      cleanup();
      reject(new Error('TV emulator stopped during wait'));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      this.off('change', listener);
      this.off('disposed', disposed);
    };
    this.on('change', listener);
    this.on('disposed', disposed);
    listener();
    return promise;
  }
  async setDiscovery(records: DiscoveryRecord[], options: DiscoveryOptions = {}): Promise<void> {
    await mkdir(dirname(this.discoveryStatePath), { recursive: true });
    const temporaryPath = `${this.discoveryStatePath}.next`;
    await writeFile(
      temporaryPath,
      JSON.stringify({
        schemaVersion: 1,
        records: records.map((record) => ({ port: this.remotePort, host: this.host, ...record })),
        ...options,
      }) + '\n'
    );
    await rename(temporaryPath, this.discoveryStatePath);
  }
  async writeDiscoveryState(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await readFile(this.discoveryStatePath));
  }
  async setFault(mode: FaultMode): Promise<void> {
    const previous = this.fault;
    this.fault = mode;
    if (mode === 'refuse') {
      this.disconnectRemote();
      await this.closeListeners();
    } else if (previous === 'refuse') await this.start();
  }
  async migrateHost(host: string): Promise<void> {
    if (!/^127\.\d+\.\d+\.\d+$/.test(host)) throw new Error('migration requires IPv4 loopback');
    const resume = this.started;
    await this.closeListeners();
    this.host = host;
    if (resume) await this.start();
  }
  setCapabilities(features: number): void {
    this.capabilities = features;
  }
  setImeState(text: string, options: { newField?: boolean } = {}): void {
    this.model.state.text = text;
    this.model.state.imeCounter++;
    if (options.newField) this.model.state.fieldCounter++;
    for (const socket of this.remoteSockets) this.send(socket, 'remote', this.imeMessage());
    this.changed();
  }
  setPower(powered: boolean): void {
    this.model.state.powered = powered;
    for (const socket of this.remoteSockets)
      this.send(socket, 'remote', { remoteStart: { started: powered } });
    this.changed();
  }
  setApp(app: string): void {
    this.model.state.app = app;
    for (const socket of this.remoteSockets)
      this.send(socket, 'remote', {
        remoteImeKeyInject: {
          appInfo: { appPackage: app },
          textFieldStatus: {
            counterField: this.model.state.fieldCounter,
            value: this.model.state.text,
          },
        },
      });
    this.changed();
  }
  sendPing(): number {
    const id = ++this.pingSequence;
    this.pendingPings.add(id);
    for (const socket of this.remoteSockets)
      this.send(socket, 'remote', { remotePingRequest: { val1: id } });
    return id;
  }
  disconnectRemote(): void {
    for (const socket of this.remoteSockets) socket.destroy();
  }
  private async closeListeners(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await Promise.all(
      this.servers.map((server) => {
        if (!server.listening) return Promise.resolve();
        const closed = Promise.withResolvers<void>();
        server.close((error) => (error ? closed.reject(error) : closed.resolve()));
        return closed.promise;
      })
    );
    this.servers = [];
    this.started = false;
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.emit('disposed');
    await this.closeListeners();
    this.sendQueues.clear();
    await rm(this.temporaryDirectory, { recursive: true, force: true });
    this.removeAllListeners();
  }
  private changed(): void {
    this.emit('change', this.snapshot());
  }
  private fail(message: string): void {
    this.model.state.errors.push(message);
    this.trace('tls', 'error', message);
    this.changed();
  }
  private trace(
    service: ProtocolTrace['service'],
    direction: ProtocolTrace['direction'],
    message: string,
    bytes?: number
  ): void {
    this.traces.push({ sequence: ++this.sequence, service, direction, message, bytes });
    if (this.traces.length > 1000) this.traces.shift();
  }
}
export async function createTvEmulator(options: TvEmulatorOptions = {}): Promise<TvEmulator> {
  return TvEmulator.create(options);
}
