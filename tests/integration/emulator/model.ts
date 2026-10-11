export interface VoiceExpectation {
  frequencyHz?: number;
  minRms?: number;
  maxRms?: number;
}
export interface TvState {
  pairedClients: number;
  pairingSessions: number;
  remoteConnections: number;
  connected: boolean;
  ready: boolean;
  cursor: { x: number; y: number };
  screen: 'home' | 'app' | 'search';
  selected: number;
  playing: boolean;
  powered: boolean;
  volume: number;
  text: string;
  imeCounter: number;
  fieldCounter: number;
  app: string;
  voice: {
    sessionId: number;
    phase: 'idle' | 'offered' | 'streaming' | 'ended';
    bytes: number;
    samples: number;
    rms: number;
    frequencyHz: number;
    valid: boolean;
  };
  keyEvents: { code: number; direction: number }[];
  errors: string[];
  pingReplies: number;
}
export class TvModel {
  readonly state: TvState = {
    pairedClients: 0,
    pairingSessions: 0,
    remoteConnections: 0,
    connected: false,
    ready: false,
    cursor: { x: 2, y: 2 },
    screen: 'home',
    selected: 0,
    playing: false,
    powered: true,
    volume: 20,
    text: '',
    imeCounter: 1,
    fieldCounter: 1,
    app: 'com.synthetic.tv.home',
    voice: {
      sessionId: 0,
      phase: 'idle',
      bytes: 0,
      samples: 0,
      rms: 0,
      frequencyHz: 0,
      valid: false,
    },
    keyEvents: [],
    errors: [],
    pingReplies: 0,
  };
  private held = new Set<number>();
  private pcm: Buffer[] = [];
  constructor(private readonly expectation: VoiceExpectation = {}) {}
  key(code: number, direction: number): boolean {
    if (![1, 2, 3].includes(direction)) throw new Error('invalid Android key direction');
    if (direction === 1) {
      if (this.held.has(code)) throw new Error('duplicate key down');
      this.held.add(code);
    } else if (direction === 2 && !this.held.delete(code))
      throw new Error('key up without key down');
    this.state.keyEvents.push({ code, direction });
    if (direction === 2) return false;
    switch (code) {
      case 19:
        this.state.cursor.y = Math.max(0, this.state.cursor.y - 1);
        break;
      case 20:
        this.state.cursor.y = Math.min(4, this.state.cursor.y + 1);
        break;
      case 21:
        this.state.cursor.x = Math.max(0, this.state.cursor.x - 1);
        break;
      case 22:
        this.state.cursor.x = Math.min(4, this.state.cursor.x + 1);
        break;
      case 23:
        this.state.selected++;
        this.state.screen = 'app';
        break;
      case 3:
        this.state.screen = 'home';
        this.state.app = 'com.synthetic.tv.home';
        break;
      case 4:
        this.state.screen = 'home';
        break;
      case 24:
        this.state.volume = Math.min(100, this.state.volume + 1);
        break;
      case 25:
        this.state.volume = Math.max(0, this.state.volume - 1);
        break;
      case 26:
        this.state.powered = !this.state.powered;
        break;
      case 85:
        this.state.playing = !this.state.playing;
        break;
      case 84:
        this.state.screen = 'search';
        return true;
      case 66:
        this.state.selected++;
        break;
      case 67:
        this.state.text = Array.from(this.state.text).slice(0, -1).join('');
        break;
      default:
        throw new Error(`unsupported Android key code ${code}`);
    }
    return false;
  }
  text(text: string, imeCounter: number, fieldCounter: number): void {
    if (imeCounter !== this.state.imeCounter || fieldCounter !== this.state.fieldCounter)
      throw new Error('stale IME counters');
    this.state.text = text;
    this.state.imeCounter++;
  }
  offerVoice(): number {
    if (['offered', 'streaming'].includes(this.state.voice.phase))
      throw new Error('voice session already active');
    const id = this.state.voice.sessionId + 1;
    this.pcm = [];
    this.state.voice = {
      sessionId: id,
      phase: 'offered',
      bytes: 0,
      samples: 0,
      rms: 0,
      frequencyHz: 0,
      valid: false,
    };
    return id;
  }
  voiceBegin(id: number): void {
    if (id !== this.state.voice.sessionId || this.state.voice.phase !== 'offered')
      throw new Error('invalid voice begin/session');
    this.state.voice.phase = 'streaming';
  }
  voicePayload(id: number, samples: Buffer): void {
    if (id !== this.state.voice.sessionId || this.state.voice.phase !== 'streaming')
      throw new Error('voice payload outside active session');
    if (!samples.length || samples.length % 2 || samples.length > 20 * 1024)
      throw new Error('invalid PCM16LE chunk size');
    this.pcm.push(Buffer.from(samples));
    this.state.voice.bytes += samples.length;
    this.state.voice.samples += samples.length / 2;
  }
  voiceEnd(id: number): void {
    if (id !== this.state.voice.sessionId || this.state.voice.phase !== 'streaming')
      throw new Error('invalid voice end/session');
    const pcm = Buffer.concat(this.pcm);
    let energy = 0,
      active = 0,
      crossings = 0,
      previous = 0;
    for (let offset = 0; offset < pcm.length; offset += 2) {
      const sample = pcm.readInt16LE(offset) / 32768;
      // Padded trailing silence is allowed by the production remote transport.
      if (Math.abs(sample) > 0.002) {
        energy += sample * sample;
        active++;
      }
      if (previous < 0 && sample >= 0) crossings++;
      previous = sample;
    }
    const nonzeroRatio = 0.99; // sine samples close to zero are intentionally excluded above
    const seconds = active / nonzeroRatio / 8000;
    const rms = active ? Math.sqrt(energy / active) : 0;
    const frequency = seconds ? crossings / seconds : 0;
    const expected = this.expectation.frequencyHz ?? 440;
    const valid =
      active >= 800 &&
      rms >= (this.expectation.minRms ?? 0.12) &&
      rms <= (this.expectation.maxRms ?? 0.25) &&
      Math.abs(frequency - expected) < 35;
    Object.assign(this.state.voice, {
      phase: 'ended',
      samples: pcm.length / 2,
      rms,
      frequencyHz: frequency,
      valid,
    });
    this.pcm = [];
    if (!valid)
      throw new Error(
        `invalid PCM signal: rms=${rms.toFixed(3)}, frequency=${frequency.toFixed(1)}Hz, active=${active}`
      );
  }
  disconnect(): void {
    this.held.clear();
    this.state.connected = false;
    this.state.ready = false;
    if (['offered', 'streaming'].includes(this.state.voice.phase)) {
      this.state.errors.push('voice session interrupted by disconnect');
      this.state.voice.phase = 'idle';
      this.pcm = [];
    }
  }
}
