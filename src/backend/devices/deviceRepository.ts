import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { SavedDevice } from '../../shared/types';
import type { IFileSystem } from '../core/fileSystem';
import type { IPathProvider } from '../core/pathProvider';

interface PersistedData {
  devices?: SavedDevice[];
}

const DEFAULT_DATA: PersistedData = {
  devices: [],
};

/**
 * Persists the user's saved device list. Extracted from `src/main/device/store.ts`
 * The original module-level helpers (`readDevices`, `writeDevices`,
 * `clearDeviceStore`) become thin wrappers around an instance of this class so
 * existing call sites keep working unchanged.
 *
 * The store is just `<userData>/devices.json`. Behaviour preserved exactly:
 *
 *   - missing file (ENOENT) → empty list, not an error
 *   - JSON without a `devices` key → empty list (older format compatibility)
 *   - `clear()` is best-effort; ENOENT is swallowed, other errors bubble up
 */
export class DeviceRepository {
  constructor(
    private readonly fs: IFileSystem,
    private readonly paths: IPathProvider,
    private readonly fileName = 'devices.json'
  ) {}

  /** Absolute path to the on-disk store. Exposed for debug logging / tests. */
  storePath(): string {
    return this.paths.getAppDataPath(this.fileName);
  }

  async read(): Promise<SavedDevice[]> {
    const storePath = this.storePath();
    if (!(await this.fs.exists(storePath))) {
      return [];
    }
    const raw = await this.fs.readFile(storePath, 'utf8');
    const parsed = JSON.parse(raw) as PersistedData;
    return parsed.devices ?? [];
  }

  async write(devices: SavedDevice[]): Promise<void> {
    const storePath = this.storePath();
    await this.fs.mkdir(path.dirname(storePath), { recursive: true });
    const temporary = path.join(
      path.dirname(storePath),
      `.${path.basename(storePath)}.${randomUUID()}.tmp`
    );
    try {
      await this.fs.writeFile(
        temporary,
        JSON.stringify({ ...DEFAULT_DATA, devices }, null, 2),
        'utf8'
      );
      await this.fs.rename(temporary, storePath);
    } catch (error) {
      // A partial write may have created the temporary file. Cleanup must not
      // replace the original write/rename error.
      try {
        await this.fs.rm(temporary, { force: true });
      } catch {
        // Best-effort cleanup of this write's temporary file only.
      }
      throw error;
    }
  }

  async clear(): Promise<void> {
    await this.fs.rm(this.storePath(), { force: true });
  }
}
