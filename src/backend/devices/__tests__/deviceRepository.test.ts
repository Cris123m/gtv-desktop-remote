import { beforeEach, describe, expect, it } from 'vitest';

import type { SavedDevice } from '../../../shared/types';
import type { IFileSystem } from '../../core/fileSystem';
import type { IPathProvider } from '../../core/pathProvider';
import { DeviceRepository } from '../deviceRepository';

const STORE_DIR = '/app-data';

const paths: IPathProvider = {
  getCertStateDir: () => STORE_DIR,
  getAppDataPath: (...segments) => [STORE_DIR, ...segments].join('/'),
};

function makeFakeFs(
  seed?: Record<string, string>
): IFileSystem & { dump: () => Record<string, string> } {
  const files = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    readFile: (p, _enc) => {
      const v = files.get(p);
      if (v === undefined) {
        return Promise.reject(Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' }));
      }
      return Promise.resolve(v);
    },
    writeFile: (p, contents, _enc) => {
      files.set(p, contents);
      return Promise.resolve();
    },
    mkdir: () => Promise.resolve(),
    rm: (p, _opts) => {
      files.delete(p);
      return Promise.resolve();
    },
    rmRecursive: () => Promise.resolve(),
    rename: (from, to) => {
      const contents = files.get(from);
      if (contents === undefined) {
        return Promise.reject(Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' }));
      }
      files.set(to, contents);
      files.delete(from);
      return Promise.resolve();
    },
    exists: (p) => Promise.resolve(files.has(p)),
    dump: () => Object.fromEntries(files),
  };
}

function makeGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const PAIRED_DEVICE: SavedDevice = {
  id: 'd1',
  isPaired: true,
  name: 'Living Room TV',
  host: '192.168.1.5',
  adbPort: 5555,
  pairingPort: 6467,
};

describe('DeviceRepository', () => {
  let fs: ReturnType<typeof makeFakeFs>;
  let repo: DeviceRepository;

  beforeEach(() => {
    fs = makeFakeFs();
    repo = new DeviceRepository(fs, paths);
  });

  describe('storePath', () => {
    it('returns devices.json under the app data dir by default', () => {
      expect(repo.storePath()).toBe('/app-data/devices.json');
    });

    it('respects a custom file name', () => {
      const custom = new DeviceRepository(fs, paths, 'my-devices.json');
      expect(custom.storePath()).toBe('/app-data/my-devices.json');
    });
  });

  describe('read', () => {
    it('returns an empty list when the file does not exist (ENOENT)', async () => {
      await expect(repo.read()).resolves.toEqual([]);
    });

    it('returns the devices array from a valid file', async () => {
      fs = makeFakeFs({
        '/app-data/devices.json': JSON.stringify({ devices: [PAIRED_DEVICE] }),
      });
      repo = new DeviceRepository(fs, paths);
      const devices = await repo.read();
      expect(devices).toEqual([PAIRED_DEVICE]);
    });

    it('returns an empty list when JSON has no `devices` key (legacy format)', async () => {
      fs = makeFakeFs({ '/app-data/devices.json': JSON.stringify({}) });
      repo = new DeviceRepository(fs, paths);
      await expect(repo.read()).resolves.toEqual([]);
    });

    it('returns an empty list when `devices` is null', async () => {
      fs = makeFakeFs({
        '/app-data/devices.json': JSON.stringify({ devices: null }),
      });
      repo = new DeviceRepository(fs, paths);
      await expect(repo.read()).resolves.toEqual([]);
    });
  });

  describe('write', () => {
    it('persists devices under the canonical key', async () => {
      await repo.write([PAIRED_DEVICE]);
      const raw = fs.dump()['/app-data/devices.json'];
      expect(raw).toBeDefined();
      expect(JSON.parse(raw ?? '{}')).toEqual({ devices: [PAIRED_DEVICE] });
    });

    it('round-trips through read', async () => {
      await repo.write([PAIRED_DEVICE]);
      await expect(repo.read()).resolves.toEqual([PAIRED_DEVICE]);
    });

    it.each([false, true])(
      'exposes only complete state while a partial write is held (existing store: %s)',
      async (hasExistingStore) => {
        const previous = hasExistingStore ? [PAIRED_DEVICE] : [];
        if (hasExistingStore) await repo.write(previous);
        const next = [{ ...PAIRED_DEVICE, name: 'Bedroom TV' }];
        const started = makeGate();
        const release = makeGate();
        const writeFile = fs.writeFile.bind(fs);
        fs.writeFile = async (filePath, contents, encoding) => {
          await writeFile(filePath, contents.slice(0, 10), encoding);
          started.resolve();
          await release.promise;
          await writeFile(filePath, contents, encoding);
        };

        const writing = repo.write(next);
        await started.promise;
        try {
          await expect(repo.read()).resolves.toEqual(previous);
        } finally {
          release.resolve();
          await writing;
        }
        await expect(repo.read()).resolves.toEqual(next);
        expect(Object.keys(fs.dump())).toEqual([repo.storePath()]);
      }
    );

    it('keeps overlapping writers isolated until each complete replacement', async () => {
      await repo.write([PAIRED_DEVICE]);
      const first = [{ ...PAIRED_DEVICE, name: 'First TV' }];
      const second = [{ ...PAIRED_DEVICE, name: 'Second TV' }];
      const started = [makeGate(), makeGate()] as const;
      const release = [makeGate(), makeGate()] as const;
      const writeFile = fs.writeFile.bind(fs);
      let writeIndex = 0;
      fs.writeFile = async (filePath, contents, encoding) => {
        const index = writeIndex++;
        await writeFile(filePath, contents, encoding);
        const startGate = started[index];
        const releaseGate = release[index];
        if (!startGate || !releaseGate) throw new Error('Unexpected additional writer');
        startGate.resolve();
        await releaseGate.promise;
      };

      const firstWrite = repo.write(first);
      await started[0].promise;
      // A second repository also shares the canonical store.
      const secondWrite = new DeviceRepository(fs, paths).write(second);
      await started[1].promise;
      try {
        await expect(repo.read()).resolves.toEqual([PAIRED_DEVICE]);
        release[1].resolve();
        await secondWrite;
        await expect(repo.read()).resolves.toEqual(second);
        release[0].resolve();
        await firstWrite;
        await expect(repo.read()).resolves.toEqual(first);
        expect(Object.keys(fs.dump())).toEqual([repo.storePath()]);
      } finally {
        release.forEach((gate) => {
          gate.resolve();
        });
        await Promise.all([firstWrite, secondWrite]);
      }
    });

    it.each(['write', 'rename'] as const)(
      'preserves the previous state and cleans up after a failed %s',
      async (failureStage) => {
        await repo.write([PAIRED_DEVICE]);
        await fs.writeFile('/app-data/unrelated-file', 'keep me', 'utf8');
        const previousFiles = fs.dump();
        const failure = new Error(`Failed ${failureStage}`);
        if (failureStage === 'write') {
          const writeFile = fs.writeFile.bind(fs);
          fs.writeFile = async (filePath, contents, encoding) => {
            await writeFile(filePath, contents.slice(0, 10), encoding);
            throw failure;
          };
        } else {
          fs.rename = () => Promise.reject(failure);
        }

        await expect(repo.write([])).rejects.toBe(failure);
        await expect(repo.read()).resolves.toEqual([PAIRED_DEVICE]);
        expect(fs.dump()).toEqual(previousFiles);
      }
    );

    it('does not mask the replacement error when temporary cleanup also fails', async () => {
      await repo.write([PAIRED_DEVICE]);
      const failure = new Error('Replacement failed');
      fs.rename = () => Promise.reject(failure);
      fs.rm = () => Promise.reject(new Error('Cleanup failed'));

      await expect(repo.write([])).rejects.toBe(failure);
      await expect(repo.read()).resolves.toEqual([PAIRED_DEVICE]);
    });
  });

  describe('clear', () => {
    it('removes the file', async () => {
      await repo.write([PAIRED_DEVICE]);
      await repo.clear();
      expect(fs.dump()['/app-data/devices.json']).toBeUndefined();
    });

    it('is a no-op when the file is absent', async () => {
      await expect(repo.clear()).resolves.toBeUndefined();
    });
  });
});
