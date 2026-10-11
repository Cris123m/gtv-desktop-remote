import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import protobuf from 'protobufjs';

// Independent vendored schemas: never import the application or LibreControl codecs.
const root = new protobuf.Root();
for (const file of ['pairing.proto', 'remote.proto']) {
  protobuf.parse(
    readFileSync(resolve(process.cwd(), 'tests/integration/fixtures/protocol', file), 'utf8'),
    root
  );
}
root.resolveAll();
export type WireObject = Record<string, any>;
export function encode(kind: 'pairing' | 'remote', value: WireObject): Buffer {
  const type = root.lookupType(
    `${kind}.${kind === 'pairing' ? 'PairingMessage' : 'RemoteMessage'}`
  );
  const error = type.verify(value);
  if (error) throw new Error(error);
  return Buffer.from(type.encode(type.create(value)).finish());
}
export function decode(kind: 'pairing' | 'remote', bytes: Uint8Array): WireObject {
  const type = root.lookupType(
    `${kind}.${kind === 'pairing' ? 'PairingMessage' : 'RemoteMessage'}`
  );
  return type.toObject(type.decode(bytes), { bytes: Buffer, defaults: false });
}
export function frame(payload: Uint8Array): Buffer {
  let length = payload.length;
  const prefix: number[] = [];
  do {
    prefix.push((length & 127) | (length > 127 ? 128 : 0));
    length >>>= 7;
  } while (length);
  return Buffer.concat([Buffer.from(prefix), payload]);
}
export class FrameReader {
  private pending = Buffer.alloc(0);
  push(chunk: Uint8Array): Buffer[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: Buffer[] = [];
    while (this.pending.length) {
      let size = 0;
      let count = 0;
      for (; count < this.pending.length && count < 5; count++) {
        const byte = this.pending[count];
        if (count === 4 && byte & 0xf0) throw new Error('invalid frame length varint');
        size += (byte & 127) * 2 ** (7 * count);
        if (!(byte & 128)) break;
      }
      if (count === 5) throw new Error('invalid frame length varint');
      if (count === this.pending.length) break;
      if (size === 0 || size > 1024 * 1024) throw new Error('invalid frame size');
      const start = count + 1;
      if (this.pending.length < start + size) break;
      frames.push(this.pending.subarray(start, start + size));
      this.pending = this.pending.subarray(start + size);
    }
    return frames;
  }
  finish(): void {
    if (this.pending.length) throw new Error('truncated frame');
  }
}
