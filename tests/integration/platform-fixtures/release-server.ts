import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

export class ReleaseServer {
  server: Server;
  url = '';
  version = '1.6.5';
  mode:
    | 'available'
    | 'none'
    | 'check-failure'
    | 'download-failure'
    | 'invalid-archive'
    | 'no-asset'
    | 'dmg' = 'available';
  asset = Buffer.alloc(0);
  requests: string[] = [];
  constructor(readonly profile: string) {
    this.server = createServer((request, response) => {
      this.requests.push(request.url ?? '');
      if (request.url === '/latest') {
        if (this.mode === 'check-failure') {
          response.writeHead(503);
          response.end();
          return;
        }
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            tag_name: this.mode === 'none' ? 'v1.6.4' : `v${this.version}`,
            html_url: `${this.url}/release`,
            assets:
              this.mode === 'no-asset'
                ? []
                : [
                    {
                      name: `GTV-Remote-${this.version}-mac-arm64.${this.mode === 'dmg' ? 'dmg' : 'zip'}`,
                      browser_download_url: `${this.url}/asset`,
                      size: this.asset.length,
                    },
                    {
                      name: `GTV-Remote-${this.version}-mac-x64.${this.mode === 'dmg' ? 'dmg' : 'zip'}`,
                      browser_download_url: `${this.url}/asset`,
                      size: this.asset.length,
                    },
                  ],
          })
        );
      } else if (request.url === '/asset') {
        if (this.mode === 'download-failure') {
          response.writeHead(503);
          response.end();
          return;
        }
        const bytes = this.mode === 'invalid-archive' ? Buffer.from('not a ZIP') : this.asset;
        response.setHeader('content-length', bytes.length);
        response.end(bytes);
      } else {
        response.writeHead(404);
        response.end();
      }
    });
  }
  async start() {
    const source = path.join(this.profile, 'release-source');
    await ReleaseServer.bundle(path.join(source, 'GTV Remote.app'), this.version);
    const archive = path.join(this.profile, 'release.zip');
    execFileSync('zip', ['-qr', archive, 'GTV Remote.app'], { cwd: source });
    this.asset = await readFile(archive);
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback server address');
    this.url = `http://127.0.0.1:${address.port}`;
  }
  static async bundle(bundle: string, version: string) {
    await mkdir(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
    await writeFile(
      path.join(bundle, 'Contents', 'Info.plist'),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`
    );
    await writeFile(
      path.join(bundle, 'Contents', 'MacOS', 'GTV Remote'),
      `synthetic executable metadata ${version}`
    );
  }
  async stop() {
    if (!this.server.listening) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}
