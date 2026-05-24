#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// `usocket` (transitive of the Linux-only dbus-next) is a POSIX native module
// — its uwrap.cc includes <sys/ioctl.h>, which doesn't exist on Windows, so
// electron-builder install-app-deps fails when @electron/rebuild walks into
// it. Strip it out before the rebuild step so install-app-deps never sees it.
// dbus-next itself is only loaded by the Linux input adapter, so removing its
// native bindings on Windows is safe.
if (process.platform === 'win32') {
  const pnpmStore = join(process.cwd(), 'node_modules', '.pnpm');
  try {
    for (const entry of readdirSync(pnpmStore)) {
      if (!entry.startsWith('usocket@')) continue;
      const full = join(pnpmStore, entry);
      if (statSync(full).isDirectory()) {
        rmSync(full, { recursive: true, force: true });
        console.log(`[postinstall] removed ${entry} (POSIX-only)`);
      }
    }
  } catch (err) {
    console.warn(`[postinstall] usocket cleanup skipped: ${err.message}`);
  }
}

let r = spawnSync('pnpm', ['exec', 'electron-builder', 'install-app-deps'], {
  stdio: 'inherit',
  shell: true,
});
if (r.status !== 0) process.exit(r.status);

r = spawnSync('node', ['scripts/fetch-embedding-model.mjs'], {
  stdio: 'inherit',
  shell: true,
});
process.exit(r.status ?? 1);
