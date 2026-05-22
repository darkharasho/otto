# Otto Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Otto skeleton — Electron app + global hotkey + minimal React chat UI + Claude Agent SDK + SQLite persistence, Linux-only, no real tools beyond a stub `echo` tool that exercises the tool-call rendering path end-to-end.

**Architecture:** Three-process Electron split. Main (Node) hosts the Agent SDK, SQLite, window/hotkey management, and per-OS adapters. Preload exposes a typed `window.otto` bridge. Renderer (React + Vite + Tailwind, zustand state) renders the command bar that grows into a panel showing streamed assistant turns and tool-call cards. Spec: `docs/superpowers/specs/2026-05-22-otto-skeleton-design.md`.

**Tech Stack:** Electron, TypeScript, electron-vite, React 18, Vite, Tailwind CSS, zustand, `better-sqlite3` (prebuilt binaries), `@anthropic-ai/claude-agent-sdk`, Vitest, React Testing Library, Playwright (`@playwright/test`), electron-builder, `electron-log`.

---

## File Structure

Will be built across tasks below; the final tree:

```
src/
  main/
    index.ts                  # Task 22: app entry
    window.ts                 # Task 7: bar/panel sizing + show/hide
    hotkey.ts                 # Task 8: global shortcut + toggle
    logger.ts                 # Task 3
    agent/
      session.ts              # Task 9: SDK session manager
      tools.ts                # Task 10: stub echo tool
    db/
      db.ts                   # Task 4: open db, run migrations
      migrations/001_init.sql # Task 4
      repo.ts                 # Task 5: sessions + messages repo
    ipc/
      handlers.ts             # Task 11
      events.ts               # Task 11: emit helpers
    platform/
      index.ts                # Task 6: PlatformAdapter interface + factory
      linux.ts                # Task 6
  preload/
    index.ts                  # Task 12
  renderer/
    main.tsx                  # Task 21
    App.tsx                   # Task 21
    index.html                # Task 1
    index.css                 # Task 1 (Tailwind entry)
    state/
      store.ts                # Task 13
    ipc.ts                    # Task 14
    components/
      CommandBar.tsx          # Task 15
      Panel.tsx               # Task 18
      MessageList.tsx         # Task 17
      Message.tsx             # Task 16 (User/Assistant variants)
      ToolCallCard.tsx        # Task 16
      SessionSwitcher.tsx     # Task 19
      StatusFooter.tsx        # Task 20
      ErrorCard.tsx           # Task 16
  shared/
    ipc-contract.ts           # Task 2
    messages.ts               # Task 2
tests/
  integration/
    smoke.spec.ts             # Task 23
electron.vite.config.ts       # Task 1
electron-builder.yml          # Task 24
package.json                  # Task 1
tsconfig.json                 # Task 1
tsconfig.node.json            # Task 1
tailwind.config.ts            # Task 1
postcss.config.js             # Task 1
vitest.config.ts              # Task 1
playwright.config.ts          # Task 23
.eslintrc.cjs                 # Task 1
```

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.node.json`, `electron.vite.config.ts`, `tailwind.config.ts`, `postcss.config.js`, `vitest.config.ts`, `.eslintrc.cjs`, `src/renderer/index.html`, `src/renderer/index.css`, `src/main/index.ts` (stub), `src/preload/index.ts` (stub), `src/renderer/main.tsx` (stub)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "otto",
  "version": "0.0.1",
  "description": "General-purpose computer coworking agent",
  "main": "out/main/index.js",
  "private": true,
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron-vite preview",
    "package": "electron-vite build && electron-builder",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "playwright test",
    "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.node.json",
    "lint": "eslint . --ext .ts,.tsx"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.1.0",
    "better-sqlite3": "^11.5.0",
    "electron-log": "^5.2.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "zustand": "^5.0.1"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0",
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.0.1",
    "@testing-library/user-event": "^14.5.2",
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^22.9.0",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@typescript-eslint/eslint-plugin": "^8.15.0",
    "@typescript-eslint/parser": "^8.15.0",
    "@vitejs/plugin-react": "^4.3.3",
    "autoprefixer": "^10.4.20",
    "electron": "^33.2.0",
    "electron-builder": "^25.1.8",
    "electron-vite": "^2.3.0",
    "eslint": "^8.57.1",
    "eslint-plugin-react": "^7.37.2",
    "eslint-plugin-react-hooks": "^5.0.0",
    "jsdom": "^25.0.1",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.15",
    "typescript": "^5.6.3",
    "vite": "^5.4.11",
    "vitest": "^2.1.5"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`** (renderer + shared)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"],
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["src/shared/*"],
      "@renderer/*": ["src/renderer/*"]
    }
  },
  "include": ["src/renderer/**/*", "src/shared/**/*", "src/preload/**/*"]
}
```

- [ ] **Step 3: Create `tsconfig.node.json`** (main process)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "outDir": "out/main",
    "types": ["node"],
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["src/shared/*"]
    }
  },
  "include": ["src/main/**/*", "src/shared/**/*"]
}
```

- [ ] **Step 4: Create `electron.vite.config.ts`**

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { outDir: 'out/main', rollupOptions: { input: 'src/main/index.ts' } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { outDir: 'out/preload', rollupOptions: { input: 'src/preload/index.ts' } },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer'),
      },
    },
    build: { outDir: 'out/renderer', rollupOptions: { input: 'src/renderer/index.html' } },
  },
});
```

- [ ] **Step 5: Create `tailwind.config.ts`**

```ts
import type { Config } from 'tailwindcss';

export default {
  content: ['src/renderer/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        bg: '#0d0d0e',
        surface: '#17181a',
        border: '#2a2b2e',
        text: '#e9eaec',
        muted: '#8b8d92',
        accent: '#7c7dff',
        danger: '#ef4444',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
```

- [ ] **Step 6: Create `postcss.config.js`**

```js
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 7: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/renderer/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

- [ ] **Step 8: Create `src/renderer/test-setup.ts`**

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 9: Create `.eslintrc.cjs`**

```js
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
  ],
  settings: { react: { version: '18.3' } },
  rules: {
    'react/react-in-jsx-scope': 'off',
    'react/prop-types': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  },
  ignorePatterns: ['out/', 'dist/', 'node_modules/', '.superpowers/'],
};
```

- [ ] **Step 10: Create `src/renderer/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Otto</title>
    <link rel="stylesheet" href="./index.css" />
  </head>
  <body class="bg-transparent text-text font-sans antialiased">
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 11: Create `src/renderer/index.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html, body, #root { height: 100%; }
body { background: transparent; }
```

- [ ] **Step 12: Create stubs so electron-vite can build**

`src/main/index.ts`:
```ts
import { app } from 'electron';

app.whenReady().then(() => {
  // wired in Task 22
});
```

`src/preload/index.ts`:
```ts
// wired in Task 12
export {};
```

`src/renderer/main.tsx`:
```tsx
import { createRoot } from 'react-dom/client';

const root = createRoot(document.getElementById('root')!);
root.render(<div className="p-4">Otto skeleton boot</div>);
```

- [ ] **Step 13: Install deps and verify scaffold builds**

Run: `npm install`
Run: `npm run typecheck`
Expected: PASS (no errors).
Run: `npm run build`
Expected: PASS — produces `out/main`, `out/preload`, `out/renderer`.

- [ ] **Step 14: Commit**

```bash
git add .
git commit -m "feat: scaffold electron-vite + react + tailwind + vitest"
```

---

## Task 2: Shared Types — IPC Contract and Message Shapes

**Files:**
- Create: `src/shared/ipc-contract.ts`, `src/shared/messages.ts`
- Test: `src/shared/messages.test.ts`

- [ ] **Step 1: Write the failing test for message helpers**

`src/shared/messages.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  isUserMessage,
  isAssistantMessage,
  isToolMessage,
  newUserMessage,
  newAssistantMessage,
  type Message,
} from './messages';

describe('messages', () => {
  it('creates a user message with text content', () => {
    const m = newUserMessage('hello');
    expect(m.role).toBe('user');
    expect(m.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(m.id).toMatch(/^msg_/);
    expect(typeof m.createdAt).toBe('number');
  });

  it('creates an assistant message that starts empty and is not cancelled', () => {
    const m = newAssistantMessage();
    expect(m.role).toBe('assistant');
    expect(m.content).toEqual([]);
    expect(m.cancelled).toBe(false);
  });

  it('discriminates message roles', () => {
    const u: Message = newUserMessage('hi');
    const a: Message = newAssistantMessage();
    expect(isUserMessage(u)).toBe(true);
    expect(isAssistantMessage(a)).toBe(true);
    expect(isToolMessage(u)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/shared/messages.test.ts`
Expected: FAIL with "Cannot find module './messages'".

- [ ] **Step 3: Create `src/shared/messages.ts`**

```ts
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; callId: string; name: string; input: unknown }
  | { type: 'tool_result'; callId: string; result: unknown; isError?: boolean };

export interface BaseMessage {
  id: string;
  sessionId: string | null;
  seq: number;
  createdAt: number;
  content: ContentBlock[];
}

export interface UserMessage extends BaseMessage {
  role: 'user';
}

export interface AssistantMessage extends BaseMessage {
  role: 'assistant';
  cancelled: boolean;
  errored: boolean;
}

export interface ToolMessage extends BaseMessage {
  role: 'tool';
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

export interface SessionMeta {
  id: string;
  title: string | null;
  createdAt: number;
  lastActive: number;
  model: string;
  status: 'active' | 'idle' | 'ended';
}

let counter = 0;
function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function newUserMessage(text: string): UserMessage {
  return {
    id: newId('msg'),
    sessionId: null,
    seq: 0,
    createdAt: Date.now(),
    role: 'user',
    content: [{ type: 'text', text }],
  };
}

export function newAssistantMessage(): AssistantMessage {
  return {
    id: newId('msg'),
    sessionId: null,
    seq: 0,
    createdAt: Date.now(),
    role: 'assistant',
    content: [],
    cancelled: false,
    errored: false,
  };
}

export const isUserMessage = (m: Message): m is UserMessage => m.role === 'user';
export const isAssistantMessage = (m: Message): m is AssistantMessage => m.role === 'assistant';
export const isToolMessage = (m: Message): m is ToolMessage => m.role === 'tool';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/shared/messages.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Create `src/shared/ipc-contract.ts`** (no test — pure type declarations)

```ts
import type { Message, SessionMeta } from './messages';

export type ErrorKind =
  | 'auth-missing'
  | 'sdk-stream'
  | 'cancelled'
  | 'internal';

export interface StructuredError {
  kind: ErrorKind;
  message: string;
  retryable: boolean;
}

export interface SessionStartArgs {
  resume?: string;
}
export interface SessionStartResult {
  sessionId: string;
}

export interface SessionSendArgs {
  sessionId: string;
  text: string;
}

export interface SessionCancelArgs {
  sessionId: string;
}

export interface SessionLoadArgs {
  sessionId: string;
}

export type IpcRequest =
  | { channel: 'session.start'; args: SessionStartArgs; result: SessionStartResult }
  | { channel: 'session.send'; args: SessionSendArgs; result: void }
  | { channel: 'session.cancel'; args: SessionCancelArgs; result: void }
  | { channel: 'session.list'; args: void; result: SessionMeta[] }
  | { channel: 'session.load'; args: SessionLoadArgs; result: Message[] }
  | { channel: 'window.collapseToBar'; args: void; result: void };

export type IpcChannel = IpcRequest['channel'];

export type SessionEvent =
  | { type: 'message-start'; sessionId: string; messageId: string }
  | { type: 'text-delta'; sessionId: string; messageId: string; text: string }
  | { type: 'tool-call-start'; sessionId: string; messageId: string; callId: string; name: string; input: unknown }
  | { type: 'tool-call-result'; sessionId: string; messageId: string; callId: string; result: unknown; isError: boolean }
  | { type: 'message-end'; sessionId: string; messageId: string }
  | { type: 'error'; sessionId: string; error: StructuredError }
  | { type: 'done'; sessionId: string };

export const SESSION_EVENT_CHANNEL = 'session.event';

export interface OttoBridge {
  invoke<C extends IpcChannel>(
    channel: C,
    args: Extract<IpcRequest, { channel: C }>['args']
  ): Promise<Extract<IpcRequest, { channel: C }>['result']>;
  onSessionEvent(handler: (event: SessionEvent) => void): () => void;
}

declare global {
  interface Window {
    otto: OttoBridge;
  }
}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/
git commit -m "feat(shared): add message types and ipc contract"
```

---

## Task 3: Logger

**Files:**
- Create: `src/main/logger.ts`

- [ ] **Step 1: Create `src/main/logger.ts`**

```ts
import log from 'electron-log';
import path from 'node:path';
import os from 'node:os';

const configDir = process.env.XDG_CONFIG_HOME
  ? path.join(process.env.XDG_CONFIG_HOME, 'otto')
  : path.join(os.homedir(), '.config', 'otto');

log.transports.file.resolvePathFn = () => path.join(configDir, 'logs', 'main.log');
log.transports.file.maxSize = 5 * 1024 * 1024; // 5 MB rotate
log.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : 'info';
log.transports.file.level = 'info';

export const logger = log;
export const ottoConfigDir = configDir;
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/logger.ts
git commit -m "feat(main): add file logger via electron-log"
```

---

## Task 4: SQLite Database + Migrations

**Files:**
- Create: `src/main/db/db.ts`, `src/main/db/migrations/001_init.sql`
- Test: `src/main/db/db.test.ts`

- [ ] **Step 1: Write the failing test**

`src/main/db/db.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from './db';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'otto-db-'));
  tmpDirs.push(d);
  return d;
}

describe('openDatabase', () => {
  it('creates schema on first open and reports version 1', () => {
    const dir = freshDir();
    const db = openDatabase(path.join(dir, 'otto.db'));
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(row.version).toBe(1);
    db.close();
  });

  it('is idempotent across reopens', () => {
    const dir = freshDir();
    const p = path.join(dir, 'otto.db');
    openDatabase(p).close();
    const db = openDatabase(p);
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(row.version).toBe(1);
    db.close();
  });

  it('exposes sessions and messages tables', () => {
    const dir = freshDir();
    const db = openDatabase(path.join(dir, 'otto.db'));
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('sessions');
    expect(names).toContain('messages');
    expect(names).toContain('schema_version');
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/main/db/db.test.ts`
Expected: FAIL ("Cannot find module './db'").

- [ ] **Step 3: Create `src/main/db/migrations/001_init.sql`**

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  title        TEXT,
  created_at   INTEGER NOT NULL,
  last_active  INTEGER NOT NULL,
  model        TEXT NOT NULL,
  status       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,
  content      TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);
```

- [ ] **Step 4: Create `src/main/db/db.ts`**

```ts
import Database, { type Database as DB } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: fs.readFileSync(path.join(__dirname, 'migrations', '001_init.sql'), 'utf8'),
  },
];

export function openDatabase(dbPath: string): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function runMigrations(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
  const current = row.v ?? 0;
  const insert = db.prepare('INSERT INTO schema_version(version) VALUES (?)');
  const txn = db.transaction(() => {
    for (const m of MIGRATIONS) {
      if (m.version > current) {
        db.exec(m.sql);
        insert.run(m.version);
      }
    }
  });
  txn();
}
```

> Note: `__dirname` works because the main process is bundled to CommonJS (`tsconfig.node.json` sets `module: CommonJS`). In tests, Vitest reads the file via the same path because the migrations folder lives next to the source.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- src/main/db/db.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/main/db/
git commit -m "feat(db): open sqlite with migrations to v1"
```

---

## Task 5: SQLite Repo — Sessions and Messages

**Files:**
- Create: `src/main/db/repo.ts`
- Test: `src/main/db/repo.test.ts`

- [ ] **Step 1: Write the failing test**

`src/main/db/repo.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from './db';
import { Repo } from './repo';
import { newUserMessage, newAssistantMessage } from '@shared/messages';

let dir: string;
let db: Database;
let repo: Repo;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-repo-'));
  db = openDatabase(path.join(dir, 'otto.db'));
  repo = new Repo(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Repo.sessions', () => {
  it('creates and lists sessions ordered by last_active desc', () => {
    repo.createSession({ id: 's1', model: 'm', createdAt: 1, lastActive: 10 });
    repo.createSession({ id: 's2', model: 'm', createdAt: 2, lastActive: 20 });
    const list = repo.listSessions();
    expect(list.map((s) => s.id)).toEqual(['s2', 's1']);
  });

  it('updates last_active and status', () => {
    repo.createSession({ id: 's1', model: 'm', createdAt: 1, lastActive: 10 });
    repo.updateSessionActivity('s1', 99, 'ended');
    const [s] = repo.listSessions();
    expect(s.lastActive).toBe(99);
    expect(s.status).toBe('ended');
  });

  it('sets a title once', () => {
    repo.createSession({ id: 's1', model: 'm', createdAt: 1, lastActive: 1 });
    repo.setSessionTitleIfMissing('s1', 'first prompt');
    repo.setSessionTitleIfMissing('s1', 'second prompt');
    const [s] = repo.listSessions();
    expect(s.title).toBe('first prompt');
  });
});

describe('Repo.messages', () => {
  it('appends messages with monotonically increasing seq within a session', () => {
    repo.createSession({ id: 's1', model: 'm', createdAt: 1, lastActive: 1 });
    const u = { ...newUserMessage('hi'), sessionId: 's1' };
    const a = { ...newAssistantMessage(), sessionId: 's1' };
    repo.appendMessage(u);
    repo.appendMessage(a);
    const loaded = repo.loadMessages('s1');
    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.seq).toBe(0);
    expect(loaded[1]!.seq).toBe(1);
    expect(loaded[0]!.role).toBe('user');
    expect(loaded[1]!.role).toBe('assistant');
  });

  it('round-trips content json', () => {
    repo.createSession({ id: 's1', model: 'm', createdAt: 1, lastActive: 1 });
    const a = {
      ...newAssistantMessage(),
      sessionId: 's1',
      content: [
        { type: 'text' as const, text: 'hello' },
        { type: 'tool_use' as const, callId: 'c1', name: 'echo', input: { msg: 'hi' } },
      ],
    };
    repo.appendMessage(a);
    const [loaded] = repo.loadMessages('s1');
    expect(loaded!.content).toEqual(a.content);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/main/db/repo.test.ts`
Expected: FAIL ("Cannot find module './repo'").

- [ ] **Step 3: Create `src/main/db/repo.ts`**

```ts
import type { Database } from 'better-sqlite3';
import type { Message, SessionMeta, ContentBlock } from '@shared/messages';

export interface CreateSessionArgs {
  id: string;
  model: string;
  createdAt: number;
  lastActive: number;
}

interface SessionRow {
  id: string;
  title: string | null;
  created_at: number;
  last_active: number;
  model: string;
  status: 'active' | 'idle' | 'ended';
}

interface MessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  created_at: number;
}

export class Repo {
  constructor(private readonly db: Database) {}

  createSession(args: CreateSessionArgs): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, created_at, last_active, model, status)
         VALUES (?, NULL, ?, ?, ?, 'active')`
      )
      .run(args.id, args.createdAt, args.lastActive, args.model);
  }

  setSessionTitleIfMissing(id: string, title: string): void {
    this.db
      .prepare(`UPDATE sessions SET title = ? WHERE id = ? AND title IS NULL`)
      .run(title, id);
  }

  updateSessionActivity(id: string, lastActive: number, status: SessionMeta['status']): void {
    this.db
      .prepare(`UPDATE sessions SET last_active = ?, status = ? WHERE id = ?`)
      .run(lastActive, status, id);
  }

  listSessions(limit = 100): SessionMeta[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions ORDER BY last_active DESC LIMIT ?`)
      .all(limit) as SessionRow[];
    return rows.map(rowToMeta);
  }

  getSession(id: string): SessionMeta | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
    return row ? rowToMeta(row) : null;
  }

  appendMessage(m: Message & { sessionId: string }): Message {
    const nextSeq = this.nextSeq(m.sessionId);
    const stored: Message = { ...m, seq: nextSeq };
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, seq, role, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(stored.id, m.sessionId, nextSeq, stored.role, JSON.stringify(messageBody(stored)), stored.createdAt);
    return stored;
  }

  loadMessages(sessionId: string): Message[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC`)
      .all(sessionId) as MessageRow[];
    return rows.map((r) => rowToMessage(r));
  }

  private nextSeq(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT MAX(seq) AS m FROM messages WHERE session_id = ?`)
      .get(sessionId) as { m: number | null };
    return (row.m ?? -1) + 1;
  }
}

function rowToMeta(row: SessionRow): SessionMeta {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    lastActive: row.last_active,
    model: row.model,
    status: row.status,
  };
}

interface MessageBody {
  content: ContentBlock[];
  cancelled?: boolean;
  errored?: boolean;
}

function messageBody(m: Message): MessageBody {
  if (m.role === 'assistant') {
    return { content: m.content, cancelled: m.cancelled, errored: m.errored };
  }
  return { content: m.content };
}

function rowToMessage(row: MessageRow): Message {
  const body = JSON.parse(row.content) as MessageBody;
  const base = {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    createdAt: row.created_at,
    content: body.content,
  };
  if (row.role === 'assistant') {
    return {
      ...base,
      role: 'assistant',
      cancelled: body.cancelled ?? false,
      errored: body.errored ?? false,
    };
  }
  if (row.role === 'tool') return { ...base, role: 'tool' };
  return { ...base, role: 'user' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/main/db/repo.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/db/repo.ts src/main/db/repo.test.ts
git commit -m "feat(db): add Repo for sessions and messages"
```

---

## Task 6: Platform Adapter Interface and Linux Implementation

**Files:**
- Create: `src/main/platform/index.ts`, `src/main/platform/linux.ts`
- Test: `src/main/platform/platform.test.ts`

- [ ] **Step 1: Write the failing test**

`src/main/platform/platform.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getPlatformAdapter } from './index';
import { LinuxAdapter } from './linux';

describe('getPlatformAdapter', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the Linux adapter on linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const adapter = getPlatformAdapter();
    expect(adapter).toBeInstanceOf(LinuxAdapter);
  });
});

describe('LinuxAdapter.detectDisplayServer', () => {
  it('reports wayland when XDG_SESSION_TYPE=wayland', () => {
    vi.stubEnv('XDG_SESSION_TYPE', 'wayland');
    const a = new LinuxAdapter();
    expect(a.detectDisplayServer()).toBe('wayland');
  });

  it('reports x11 when XDG_SESSION_TYPE=x11', () => {
    vi.stubEnv('XDG_SESSION_TYPE', 'x11');
    const a = new LinuxAdapter();
    expect(a.detectDisplayServer()).toBe('x11');
  });

  it('reports unknown when not set', () => {
    vi.stubEnv('XDG_SESSION_TYPE', '');
    const a = new LinuxAdapter();
    expect(a.detectDisplayServer()).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/main/platform/platform.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `src/main/platform/index.ts`**

```ts
import { LinuxAdapter } from './linux';

export type DisplayServer = 'x11' | 'wayland' | 'unknown';

export interface PlatformAdapter {
  readonly name: 'linux' | 'darwin' | 'win32';
  detectDisplayServer(): DisplayServer;
  defaultHotkey(): string;
}

export function getPlatformAdapter(): PlatformAdapter {
  if (process.platform === 'linux') return new LinuxAdapter();
  throw new Error(`Otto skeleton supports linux only (current: ${process.platform})`);
}
```

- [ ] **Step 4: Create `src/main/platform/linux.ts`**

```ts
import type { DisplayServer, PlatformAdapter } from './index';

export class LinuxAdapter implements PlatformAdapter {
  readonly name = 'linux';

  detectDisplayServer(): DisplayServer {
    const s = (process.env.XDG_SESSION_TYPE ?? '').toLowerCase();
    if (s === 'wayland') return 'wayland';
    if (s === 'x11') return 'x11';
    return 'unknown';
  }

  defaultHotkey(): string {
    return 'Control+Alt+Space';
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- src/main/platform/platform.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/main/platform/
git commit -m "feat(platform): add PlatformAdapter interface + Linux impl"
```

---

## Task 7: Window Manager

**Files:**
- Create: `src/main/window.ts`

> No automated test — this module thinly wraps Electron `BrowserWindow` calls. Behavior is verified by the Playwright smoke test in Task 23 and the manual checklist.

- [ ] **Step 1: Create `src/main/window.ts`**

```ts
import { BrowserWindow, screen, app } from 'electron';
import path from 'node:path';
import { logger } from './logger';

export type WindowMode = 'bar' | 'panel';

const BAR_WIDTH = 640;
const BAR_HEIGHT = 56;
const PANEL_MIN_HEIGHT = 320;
const PANEL_TOP_MARGIN = 64;
const PANEL_MAX_DISPLAY_RATIO = 0.7;

export class WindowManager {
  private window: BrowserWindow | null = null;
  private mode: WindowMode = 'bar';

  create(preloadPath: string, rendererUrl: string): BrowserWindow {
    const win = new BrowserWindow({
      width: BAR_WIDTH,
      height: BAR_HEIGHT,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: true,
      skipTaskbar: true,
      focusable: true,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.removeMenu();

    if (rendererUrl.startsWith('http')) {
      win.loadURL(rendererUrl);
    } else {
      win.loadFile(rendererUrl);
    }

    this.window = win;
    return win;
  }

  show(mode: WindowMode = 'bar'): void {
    if (!this.window) return;
    this.applyMode(mode);
    this.repositionTopCenter();
    this.window.show();
    this.window.focus();
  }

  hide(): void {
    this.window?.hide();
  }

  toggle(mode: WindowMode = 'bar'): void {
    if (!this.window) return;
    if (this.window.isVisible()) this.hide();
    else this.show(mode);
  }

  setMode(mode: WindowMode): void {
    this.applyMode(mode);
  }

  getMode(): WindowMode {
    return this.mode;
  }

  isVisible(): boolean {
    return this.window?.isVisible() ?? false;
  }

  destroy(): void {
    this.window?.destroy();
    this.window = null;
  }

  private applyMode(mode: WindowMode): void {
    if (!this.window) return;
    this.mode = mode;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const maxPanelHeight = Math.floor(display.workArea.height * PANEL_MAX_DISPLAY_RATIO);
    const height =
      mode === 'bar' ? BAR_HEIGHT : Math.max(PANEL_MIN_HEIGHT, Math.min(maxPanelHeight, 520));
    const { x, y } = this.topCenter(display.workArea, BAR_WIDTH);
    this.window.setBounds({ x, y, width: BAR_WIDTH, height });
    logger.debug(`window mode → ${mode} (${BAR_WIDTH}x${height} @ ${x},${y})`);
  }

  private repositionTopCenter(): void {
    if (!this.window) return;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const bounds = this.window.getBounds();
    const { x, y } = this.topCenter(display.workArea, bounds.width);
    this.window.setBounds({ ...bounds, x, y });
  }

  private topCenter(workArea: Electron.Rectangle, width: number): { x: number; y: number } {
    const x = Math.round(workArea.x + (workArea.width - width) / 2);
    const y = workArea.y + PANEL_TOP_MARGIN;
    return { x, y };
  }
}

export function rendererEntry(): string {
  if (process.env.ELECTRON_RENDERER_URL) return process.env.ELECTRON_RENDERER_URL;
  return path.join(app.getAppPath(), 'out', 'renderer', 'index.html');
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/window.ts
git commit -m "feat(main): add WindowManager with bar/panel modes"
```

---

## Task 8: Global Hotkey Registration

**Files:**
- Create: `src/main/hotkey.ts`

- [ ] **Step 1: Create `src/main/hotkey.ts`**

```ts
import { globalShortcut } from 'electron';
import { logger } from './logger';
import type { PlatformAdapter } from './platform';

export interface HotkeyState {
  registered: boolean;
  failureReason: string | null;
}

export class HotkeyManager {
  private state: HotkeyState = { registered: false, failureReason: null };

  constructor(
    private readonly platform: PlatformAdapter,
    private readonly onTrigger: () => void
  ) {}

  register(): HotkeyState {
    const accelerator = this.platform.defaultHotkey();
    const display = this.platform.name === 'linux' ? this.platform.detectDisplayServer() : 'n/a';

    if (this.platform.name === 'linux' && display === 'wayland') {
      const msg = 'Wayland detected — global hotkey may not fire. Use a desktop shortcut to launch `otto toggle` (deferred).';
      logger.warn(msg);
      this.state = { registered: false, failureReason: msg };
      return this.state;
    }

    const ok = globalShortcut.register(accelerator, this.onTrigger);
    if (!ok) {
      const msg = `Failed to register hotkey ${accelerator}. Another application may hold it.`;
      logger.warn(msg);
      this.state = { registered: false, failureReason: msg };
      return this.state;
    }
    this.state = { registered: true, failureReason: null };
    logger.info(`hotkey registered: ${accelerator}`);
    return this.state;
  }

  unregisterAll(): void {
    globalShortcut.unregisterAll();
  }

  getState(): HotkeyState {
    return this.state;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/hotkey.ts
git commit -m "feat(main): add HotkeyManager wrapping globalShortcut"
```

---

## Task 9: Agent SDK Session Manager

**Files:**
- Create: `src/main/agent/session.ts`
- Test: `src/main/agent/session.test.ts`

> The Agent SDK is mocked in tests. The session manager talks to it via a narrow `SdkClient` interface so the test can drive a fake.

- [ ] **Step 1: Write the failing test**

`src/main/agent/session.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db/db';
import { Repo } from '../db/repo';
import { SessionManager, type SdkClient, type SdkTurn } from './session';
import type { SessionEvent } from '@shared/ipc-contract';

let dir: string;
let repo: Repo;
let manager: SessionManager;
let events: SessionEvent[];
let sdkTurn: SdkTurn | null;
let fakeSdk: SdkClient;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-sess-'));
  const db = openDatabase(path.join(dir, 'otto.db'));
  repo = new Repo(db);
  events = [];
  sdkTurn = null;
  fakeSdk = {
    startSession: vi.fn(async () => ({ id: 'sdk-1' })),
    sendTurn: vi.fn((_sid, _text, signal) => {
      const t: SdkTurn = {
        async *events() {
          yield { type: 'message-start' };
          yield { type: 'text-delta', text: 'hel' };
          yield { type: 'text-delta', text: 'lo' };
          yield { type: 'message-end' };
          yield { type: 'done' };
        },
        signal,
      };
      sdkTurn = t;
      return t;
    }),
  };
  manager = new SessionManager(repo, fakeSdk, 'claude-sonnet-4-6', (e) => events.push(e));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SessionManager', () => {
  it('starts a session and persists it', async () => {
    const { sessionId } = await manager.start({});
    expect(sessionId).toBe('sdk-1');
    expect(repo.getSession(sessionId)?.model).toBe('claude-sonnet-4-6');
  });

  it('streams text deltas through and persists the assembled assistant message', async () => {
    const { sessionId } = await manager.start({});
    await manager.send({ sessionId, text: 'hi' });
    const textEvents = events.filter((e) => e.type === 'text-delta');
    expect(textEvents).toHaveLength(2);
    const msgs = repo.loadMessages(sessionId);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1]!.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('records tool_use and tool_result blocks on the assistant message', async () => {
    fakeSdk.sendTurn = vi.fn((_sid, _text, signal) => ({
      signal,
      async *events() {
        yield { type: 'message-start' };
        yield { type: 'tool-call-start', callId: 'c1', name: 'echo', input: { msg: 'hi' } };
        yield { type: 'tool-call-result', callId: 'c1', result: 'hi', isError: false };
        yield { type: 'message-end' };
        yield { type: 'done' };
      },
    }));
    const { sessionId } = await manager.start({});
    await manager.send({ sessionId, text: 'use echo' });
    const msgs = repo.loadMessages(sessionId);
    const assistant = msgs.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toEqual([
      { type: 'tool_use', callId: 'c1', name: 'echo', input: { msg: 'hi' } },
      { type: 'tool_result', callId: 'c1', result: 'hi', isError: false },
    ]);
  });

  it('emits an error event when the SDK throws and persists the message as errored', async () => {
    fakeSdk.sendTurn = vi.fn((_sid, _text, signal) => ({
      signal,
      async *events() {
        yield { type: 'message-start' };
        yield { type: 'text-delta', text: 'partial' };
        throw new Error('boom');
      },
    }));
    const { sessionId } = await manager.start({});
    await manager.send({ sessionId, text: 'fail' });
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeTruthy();
    const assistant = repo.loadMessages(sessionId).find((m) => m.role === 'assistant');
    expect(assistant && 'errored' in assistant && assistant.errored).toBe(true);
  });

  it('cancellation aborts the in-flight turn and marks the message cancelled', async () => {
    fakeSdk.sendTurn = vi.fn((_sid, _text, signal) => ({
      signal,
      async *events() {
        yield { type: 'message-start' };
        yield { type: 'text-delta', text: 'part' };
        await new Promise((r) => setTimeout(r, 10));
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        yield { type: 'text-delta', text: 'ial' };
        yield { type: 'message-end' };
        yield { type: 'done' };
      },
    }));
    const { sessionId } = await manager.start({});
    const p = manager.send({ sessionId, text: 'long' });
    setTimeout(() => manager.cancel({ sessionId }), 1);
    await p;
    const assistant = repo.loadMessages(sessionId).find((m) => m.role === 'assistant');
    expect(assistant && 'cancelled' in assistant && assistant.cancelled).toBe(true);
  });

  it('sets session title from the first user message', async () => {
    const { sessionId } = await manager.start({});
    await manager.send({ sessionId, text: 'first prompt here' });
    expect(repo.getSession(sessionId)?.title).toBe('first prompt here');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/main/agent/session.test.ts`
Expected: FAIL ("Cannot find module './session'").

- [ ] **Step 3: Create `src/main/agent/session.ts`**

```ts
import type { Repo } from '../db/repo';
import type { SessionEvent, StructuredError } from '@shared/ipc-contract';
import {
  newAssistantMessage,
  newUserMessage,
  type AssistantMessage,
  type ContentBlock,
} from '@shared/messages';

export type SdkStreamEvent =
  | { type: 'message-start' }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-start'; callId: string; name: string; input: unknown }
  | { type: 'tool-call-result'; callId: string; result: unknown; isError: boolean }
  | { type: 'message-end' }
  | { type: 'done' };

export interface SdkTurn {
  signal: AbortSignal;
  events(): AsyncIterable<SdkStreamEvent>;
}

export interface SdkClient {
  startSession(args: { resume?: string; model: string }): Promise<{ id: string }>;
  sendTurn(sessionId: string, text: string, signal: AbortSignal): SdkTurn;
}

type Emitter = (event: SessionEvent) => void;

export class SessionManager {
  private readonly aborts = new Map<string, AbortController>();
  private activeSessionId: string | null = null;

  constructor(
    private readonly repo: Repo,
    private readonly sdk: SdkClient,
    private readonly defaultModel: string,
    private readonly emit: Emitter
  ) {}

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  async start(args: { resume?: string }): Promise<{ sessionId: string }> {
    const sdkSession = await this.sdk.startSession({ resume: args.resume, model: this.defaultModel });
    const now = Date.now();
    if (!this.repo.getSession(sdkSession.id)) {
      this.repo.createSession({
        id: sdkSession.id,
        model: this.defaultModel,
        createdAt: now,
        lastActive: now,
      });
    } else {
      this.repo.updateSessionActivity(sdkSession.id, now, 'active');
    }
    this.activeSessionId = sdkSession.id;
    return { sessionId: sdkSession.id };
  }

  async send(args: { sessionId: string; text: string }): Promise<void> {
    const { sessionId, text } = args;
    const user = this.repo.appendMessage({ ...newUserMessage(text), sessionId });
    this.repo.setSessionTitleIfMissing(sessionId, text.slice(0, 80));
    this.repo.updateSessionActivity(sessionId, Date.now(), 'active');

    const assistant: AssistantMessage = { ...newAssistantMessage(), sessionId };
    const controller = new AbortController();
    this.aborts.set(sessionId, controller);
    this.activeSessionId = sessionId;

    this.emit({ type: 'message-start', sessionId, messageId: assistant.id });

    let pendingToolCalls = new Map<string, { name: string; input: unknown }>();

    try {
      const turn = this.sdk.sendTurn(sessionId, text, controller.signal);
      for await (const ev of turn.events()) {
        switch (ev.type) {
          case 'message-start':
            // already emitted
            break;
          case 'text-delta': {
            appendText(assistant.content, ev.text);
            this.emit({ type: 'text-delta', sessionId, messageId: assistant.id, text: ev.text });
            break;
          }
          case 'tool-call-start': {
            assistant.content.push({ type: 'tool_use', callId: ev.callId, name: ev.name, input: ev.input });
            pendingToolCalls.set(ev.callId, { name: ev.name, input: ev.input });
            this.emit({
              type: 'tool-call-start',
              sessionId,
              messageId: assistant.id,
              callId: ev.callId,
              name: ev.name,
              input: ev.input,
            });
            break;
          }
          case 'tool-call-result': {
            assistant.content.push({
              type: 'tool_result',
              callId: ev.callId,
              result: ev.result,
              isError: ev.isError,
            });
            pendingToolCalls.delete(ev.callId);
            this.emit({
              type: 'tool-call-result',
              sessionId,
              messageId: assistant.id,
              callId: ev.callId,
              result: ev.result,
              isError: ev.isError,
            });
            break;
          }
          case 'message-end': {
            this.emit({ type: 'message-end', sessionId, messageId: assistant.id });
            break;
          }
          case 'done': {
            this.emit({ type: 'done', sessionId });
            break;
          }
        }
        if (controller.signal.aborted) throw new AbortLikeError();
      }
    } catch (err) {
      if (isAbort(err)) {
        assistant.cancelled = true;
      } else {
        assistant.errored = true;
        const structured = toStructuredError(err);
        this.emit({ type: 'error', sessionId, error: structured });
      }
    } finally {
      this.aborts.delete(sessionId);
      this.repo.appendMessage(assistant);
      this.repo.updateSessionActivity(sessionId, Date.now(), assistant.errored ? 'idle' : 'active');
      void user;
    }
  }

  cancel(args: { sessionId: string }): void {
    this.aborts.get(args.sessionId)?.abort();
  }
}

class AbortLikeError extends Error {
  name = 'AbortError';
}

function isAbort(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

function appendText(content: ContentBlock[], text: string): void {
  const last = content[content.length - 1];
  if (last && last.type === 'text') {
    last.text += text;
    return;
  }
  content.push({ type: 'text', text });
}

function toStructuredError(err: unknown): StructuredError {
  const message = err instanceof Error ? err.message : String(err);
  if (message.toLowerCase().includes('auth') || message.toLowerCase().includes('unauthorized')) {
    return { kind: 'auth-missing', message, retryable: true };
  }
  return { kind: 'sdk-stream', message, retryable: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/main/agent/session.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/
git commit -m "feat(agent): add SessionManager with streaming, cancel, error paths"
```

---

## Task 10: Real SDK Client + Stub Echo Tool

**Files:**
- Create: `src/main/agent/tools.ts`, `src/main/agent/sdk-client.ts`

> This task wraps the real `@anthropic-ai/claude-agent-sdk` behind the `SdkClient` interface introduced in Task 9. The exact SDK call sites depend on the package's current API; the wrapper isolates that so tests stay decoupled. The skeleton registers a single `echo` tool that exercises the tool-call rendering path end-to-end.

- [ ] **Step 1: Create `src/main/agent/tools.ts`**

```ts
import { z } from 'zod';

export interface OttoTool {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  run(input: unknown): Promise<unknown>;
}

export const echoTool: OttoTool = {
  name: 'echo',
  description: 'Echoes back its input. Used to verify the tool-call pipeline.',
  schema: z.object({ msg: z.string() }),
  async run(input) {
    const parsed = echoTool.schema.parse(input) as { msg: string };
    return parsed.msg;
  },
};

export const stubTools: OttoTool[] = [echoTool];
```

> Add `zod` to dependencies: run `npm install zod@^3.23.0` and commit `package.json`/lockfile in this task's final step.

- [ ] **Step 2: Create `src/main/agent/sdk-client.ts`**

```ts
import { query as agentQuery } from '@anthropic-ai/claude-agent-sdk';
import type { SdkClient, SdkStreamEvent, SdkTurn } from './session';
import { stubTools } from './tools';
import { logger } from '../logger';

const SYSTEM_PROMPT =
  'You are Otto, a desktop coworking agent. In this skeleton build no real tools exist yet; the only available tool is `echo` for pipeline testing. Be concise.';

export function createRealSdkClient(): SdkClient {
  let sessionCounter = 0;

  return {
    async startSession({ resume }) {
      const id = resume ?? `otto-${Date.now().toString(36)}-${(sessionCounter += 1).toString(36)}`;
      logger.info(`sdk session start: ${id}`);
      return { id };
    },

    sendTurn(sessionId, text, signal): SdkTurn {
      const tools = stubTools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema,
        handler: async (input: unknown) => t.run(input),
      }));

      const iter = agentQuery({
        prompt: text,
        options: {
          systemPrompt: SYSTEM_PROMPT,
          model: 'claude-sonnet-4-6',
          tools,
          abortSignal: signal,
          sessionId,
        },
      });

      async function* events(): AsyncIterable<SdkStreamEvent> {
        yield { type: 'message-start' };
        try {
          for await (const ev of iter as AsyncIterable<unknown>) {
            const mapped = mapSdkEvent(ev);
            if (mapped) yield mapped;
          }
        } finally {
          yield { type: 'message-end' };
          yield { type: 'done' };
        }
      }

      return { signal, events };
    },
  };
}

function mapSdkEvent(raw: unknown): SdkStreamEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as { type?: string };
  switch (e.type) {
    case 'text':
    case 'content_block_delta': {
      const text = (raw as { text?: string }).text ?? '';
      if (!text) return null;
      return { type: 'text-delta', text };
    }
    case 'tool_use':
    case 'tool_call': {
      const r = raw as { id?: string; name?: string; input?: unknown };
      return { type: 'tool-call-start', callId: r.id ?? '', name: r.name ?? '', input: r.input };
    }
    case 'tool_result': {
      const r = raw as { tool_use_id?: string; content?: unknown; is_error?: boolean };
      return {
        type: 'tool-call-result',
        callId: r.tool_use_id ?? '',
        result: r.content,
        isError: !!r.is_error,
      };
    }
    default:
      return null;
  }
}
```

> The Agent SDK's exact event shape is library-version-specific. The `mapSdkEvent` function is the seam to adjust if event names change at runtime — log unknown events during dev to find any gaps.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
npm install zod@^3.23.0
git add package.json package-lock.json src/main/agent/tools.ts src/main/agent/sdk-client.ts
git commit -m "feat(agent): add stub echo tool and real SDK client wrapper"
```

---

## Task 11: IPC Handlers

**Files:**
- Create: `src/main/ipc/handlers.ts`, `src/main/ipc/events.ts`

- [ ] **Step 1: Create `src/main/ipc/events.ts`**

```ts
import { BrowserWindow } from 'electron';
import { SESSION_EVENT_CHANNEL, type SessionEvent } from '@shared/ipc-contract';

export function emitSessionEvent(event: SessionEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(SESSION_EVENT_CHANNEL, event);
  }
}
```

- [ ] **Step 2: Create `src/main/ipc/handlers.ts`**

```ts
import { ipcMain } from 'electron';
import type { Repo } from '../db/repo';
import type { SessionManager } from '../agent/session';
import type { WindowManager } from '../window';
import type {
  SessionStartArgs,
  SessionStartResult,
  SessionSendArgs,
  SessionCancelArgs,
  SessionLoadArgs,
} from '@shared/ipc-contract';
import type { Message, SessionMeta } from '@shared/messages';
import { logger } from '../logger';

export function registerIpcHandlers(deps: {
  repo: Repo;
  sessions: SessionManager;
  window: WindowManager;
}): void {
  const { repo, sessions, window } = deps;

  ipcMain.handle('session.start', async (_e, args: SessionStartArgs): Promise<SessionStartResult> => {
    return sessions.start(args);
  });

  ipcMain.handle('session.send', async (_e, args: SessionSendArgs): Promise<void> => {
    await sessions.send(args);
  });

  ipcMain.handle('session.cancel', async (_e, args: SessionCancelArgs): Promise<void> => {
    sessions.cancel(args);
  });

  ipcMain.handle('session.list', async (): Promise<SessionMeta[]> => {
    return repo.listSessions();
  });

  ipcMain.handle('session.load', async (_e, args: SessionLoadArgs): Promise<Message[]> => {
    return repo.loadMessages(args.sessionId);
  });

  ipcMain.handle('window.collapseToBar', async (): Promise<void> => {
    window.setMode('bar');
  });

  logger.info('ipc handlers registered');
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/
git commit -m "feat(ipc): register typed handlers and event emitter"
```

---

## Task 12: Preload Bridge

**Files:**
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Replace `src/preload/index.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron';
import {
  SESSION_EVENT_CHANNEL,
  type IpcChannel,
  type IpcRequest,
  type OttoBridge,
  type SessionEvent,
} from '@shared/ipc-contract';

const bridge: OttoBridge = {
  invoke<C extends IpcChannel>(channel: C, args: Extract<IpcRequest, { channel: C }>['args']) {
    return ipcRenderer.invoke(channel, args) as Promise<Extract<IpcRequest, { channel: C }>['result']>;
  },
  onSessionEvent(handler) {
    const listener = (_e: Electron.IpcRendererEvent, payload: SessionEvent) => handler(payload);
    ipcRenderer.on(SESSION_EVENT_CHANNEL, listener);
    return () => ipcRenderer.removeListener(SESSION_EVENT_CHANNEL, listener);
  },
};

contextBridge.exposeInMainWorld('otto', bridge);
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(preload): expose typed otto bridge via contextBridge"
```

---

## Task 13: Renderer Zustand Store

**Files:**
- Create: `src/renderer/state/store.ts`
- Test: `src/renderer/state/store.test.ts`

- [ ] **Step 1: Write the failing test**

`src/renderer/state/store.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useOttoStore } from './store';

beforeEach(() => {
  useOttoStore.getState().reset();
});

describe('useOttoStore', () => {
  it('starts in bar mode with no active session', () => {
    const s = useOttoStore.getState();
    expect(s.windowMode).toBe('bar');
    expect(s.activeSession).toBeNull();
  });

  it('transitions to panel mode', () => {
    useOttoStore.getState().setWindowMode('panel');
    expect(useOttoStore.getState().windowMode).toBe('panel');
  });

  it('begins a new active session with empty messages', () => {
    useOttoStore.getState().beginSession('s1');
    expect(useOttoStore.getState().activeSession).toEqual({
      id: 's1',
      messages: [],
      streaming: false,
      error: null,
    });
  });

  it('handles message-start by appending an empty assistant placeholder', () => {
    useOttoStore.getState().beginSession('s1');
    useOttoStore.getState().applyEvent({
      type: 'message-start',
      sessionId: 's1',
      messageId: 'm1',
    });
    const a = useOttoStore.getState().activeSession!;
    expect(a.streaming).toBe(true);
    expect(a.messages).toHaveLength(1);
    expect(a.messages[0]).toMatchObject({ id: 'm1', role: 'assistant', content: [] });
  });

  it('appends text deltas to the active assistant message', () => {
    useOttoStore.getState().beginSession('s1');
    useOttoStore.getState().applyEvent({ type: 'message-start', sessionId: 's1', messageId: 'm1' });
    useOttoStore.getState().applyEvent({ type: 'text-delta', sessionId: 's1', messageId: 'm1', text: 'he' });
    useOttoStore.getState().applyEvent({ type: 'text-delta', sessionId: 's1', messageId: 'm1', text: 'llo' });
    const a = useOttoStore.getState().activeSession!;
    expect(a.messages[0]!.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('appends tool_use and tool_result blocks', () => {
    useOttoStore.getState().beginSession('s1');
    useOttoStore.getState().applyEvent({ type: 'message-start', sessionId: 's1', messageId: 'm1' });
    useOttoStore.getState().applyEvent({
      type: 'tool-call-start',
      sessionId: 's1',
      messageId: 'm1',
      callId: 'c1',
      name: 'echo',
      input: { msg: 'hi' },
    });
    useOttoStore.getState().applyEvent({
      type: 'tool-call-result',
      sessionId: 's1',
      messageId: 'm1',
      callId: 'c1',
      result: 'hi',
      isError: false,
    });
    const a = useOttoStore.getState().activeSession!;
    expect(a.messages[0]!.content).toEqual([
      { type: 'tool_use', callId: 'c1', name: 'echo', input: { msg: 'hi' } },
      { type: 'tool_result', callId: 'c1', result: 'hi', isError: false },
    ]);
  });

  it('records errors and clears them on next send', () => {
    useOttoStore.getState().beginSession('s1');
    useOttoStore.getState().applyEvent({
      type: 'error',
      sessionId: 's1',
      error: { kind: 'sdk-stream', message: 'boom', retryable: true },
    });
    expect(useOttoStore.getState().activeSession!.error?.message).toBe('boom');
    useOttoStore.getState().appendUserMessage('m2', 'retry');
    expect(useOttoStore.getState().activeSession!.error).toBeNull();
  });

  it('appends a user message immediately on send', () => {
    useOttoStore.getState().beginSession('s1');
    useOttoStore.getState().appendUserMessage('m1', 'hello');
    const a = useOttoStore.getState().activeSession!;
    expect(a.messages).toHaveLength(1);
    expect(a.messages[0]).toMatchObject({ role: 'user' });
    expect(a.messages[0]!.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('marks streaming false on done', () => {
    useOttoStore.getState().beginSession('s1');
    useOttoStore.getState().applyEvent({ type: 'message-start', sessionId: 's1', messageId: 'm1' });
    useOttoStore.getState().applyEvent({ type: 'done', sessionId: 's1' });
    expect(useOttoStore.getState().activeSession!.streaming).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/renderer/state/store.test.ts`
Expected: FAIL ("Cannot find module './store'").

- [ ] **Step 3: Create `src/renderer/state/store.ts`**

```ts
import { create } from 'zustand';
import type { SessionEvent, StructuredError } from '@shared/ipc-contract';
import type { AssistantMessage, ContentBlock, Message, SessionMeta, UserMessage } from '@shared/messages';

export type WindowMode = 'bar' | 'panel';

export interface ActiveSessionState {
  id: string;
  messages: Message[];
  streaming: boolean;
  error: StructuredError | null;
}

interface OttoState {
  windowMode: WindowMode;
  activeSession: ActiveSessionState | null;
  sessions: SessionMeta[];

  setWindowMode(mode: WindowMode): void;
  beginSession(id: string): void;
  loadSession(id: string, messages: Message[]): void;
  appendUserMessage(id: string, text: string): void;
  applyEvent(event: SessionEvent): void;
  setSessions(list: SessionMeta[]): void;
  reset(): void;
}

const initial = {
  windowMode: 'bar' as WindowMode,
  activeSession: null as ActiveSessionState | null,
  sessions: [] as SessionMeta[],
};

export const useOttoStore = create<OttoState>((set, get) => ({
  ...initial,

  setWindowMode(mode) {
    set({ windowMode: mode });
  },

  beginSession(id) {
    set({ activeSession: { id, messages: [], streaming: false, error: null } });
  },

  loadSession(id, messages) {
    set({ activeSession: { id, messages, streaming: false, error: null } });
  },

  appendUserMessage(id, text) {
    const session = get().activeSession;
    if (!session) return;
    const msg: UserMessage = {
      id,
      sessionId: session.id,
      seq: session.messages.length,
      createdAt: Date.now(),
      role: 'user',
      content: [{ type: 'text', text }],
    };
    set({
      activeSession: {
        ...session,
        messages: [...session.messages, msg],
        error: null,
      },
    });
  },

  applyEvent(event) {
    const session = get().activeSession;
    if (!session || event.sessionId !== session.id) return;

    switch (event.type) {
      case 'message-start': {
        const placeholder: AssistantMessage = {
          id: event.messageId,
          sessionId: session.id,
          seq: session.messages.length,
          createdAt: Date.now(),
          role: 'assistant',
          content: [],
          cancelled: false,
          errored: false,
        };
        set({
          activeSession: {
            ...session,
            messages: [...session.messages, placeholder],
            streaming: true,
          },
        });
        return;
      }
      case 'text-delta': {
        const next = updateAssistant(session, event.messageId, (m) => {
          const content = m.content.slice();
          const last = content[content.length - 1];
          if (last && last.type === 'text') {
            content[content.length - 1] = { type: 'text', text: last.text + event.text };
          } else {
            content.push({ type: 'text', text: event.text });
          }
          return { ...m, content };
        });
        set({ activeSession: next });
        return;
      }
      case 'tool-call-start': {
        const next = updateAssistant(session, event.messageId, (m) => ({
          ...m,
          content: [
            ...m.content,
            { type: 'tool_use' as const, callId: event.callId, name: event.name, input: event.input },
          ],
        }));
        set({ activeSession: next });
        return;
      }
      case 'tool-call-result': {
        const next = updateAssistant(session, event.messageId, (m) => ({
          ...m,
          content: [
            ...m.content,
            {
              type: 'tool_result' as const,
              callId: event.callId,
              result: event.result,
              isError: event.isError,
            },
          ],
        }));
        set({ activeSession: next });
        return;
      }
      case 'message-end':
        return;
      case 'error': {
        set({
          activeSession: { ...session, error: event.error, streaming: false },
        });
        return;
      }
      case 'done': {
        set({ activeSession: { ...session, streaming: false } });
        return;
      }
    }
  },

  setSessions(list) {
    set({ sessions: list });
  },

  reset() {
    set({ ...initial });
  },
}));

function updateAssistant(
  session: ActiveSessionState,
  messageId: string,
  fn: (m: AssistantMessage) => AssistantMessage
): ActiveSessionState {
  const messages = session.messages.map((m) =>
    m.role === 'assistant' && m.id === messageId ? fn(m) : m
  );
  return { ...session, messages };
}

export type { ContentBlock };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/renderer/state/store.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/state/
git commit -m "feat(renderer): add zustand store with event reducer"
```

---

## Task 14: Renderer IPC Wrapper

**Files:**
- Create: `src/renderer/ipc.ts`

- [ ] **Step 1: Create `src/renderer/ipc.ts`**

```ts
import type { IpcChannel, IpcRequest, SessionEvent } from '@shared/ipc-contract';

export const ipc = {
  invoke<C extends IpcChannel>(
    channel: C,
    args: Extract<IpcRequest, { channel: C }>['args']
  ): Promise<Extract<IpcRequest, { channel: C }>['result']> {
    return window.otto.invoke(channel, args);
  },
  onSessionEvent(handler: (e: SessionEvent) => void): () => void {
    return window.otto.onSessionEvent(handler);
  },
};
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/ipc.ts
git commit -m "feat(renderer): add typed ipc wrapper"
```

---

## Task 15: CommandBar Component

**Files:**
- Create: `src/renderer/components/CommandBar.tsx`
- Test: `src/renderer/components/CommandBar.test.tsx`

- [ ] **Step 1: Write the failing test**

`src/renderer/components/CommandBar.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommandBar } from './CommandBar';

describe('CommandBar', () => {
  it('renders an input with a placeholder', () => {
    render(<CommandBar onSubmit={() => {}} />);
    expect(screen.getByPlaceholderText(/ask otto/i)).toBeInTheDocument();
  });

  it('calls onSubmit with trimmed text on Enter and clears the input', async () => {
    const onSubmit = vi.fn();
    render(<CommandBar onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText(/ask otto/i) as HTMLInputElement;
    await userEvent.type(input, '  hello  {Enter}');
    expect(onSubmit).toHaveBeenCalledWith('hello');
    expect(input.value).toBe('');
  });

  it('does not submit empty input', async () => {
    const onSubmit = vi.fn();
    render(<CommandBar onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText(/ask otto/i);
    await userEvent.type(input, '{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/renderer/components/CommandBar.test.tsx`
Expected: FAIL ("Cannot find module './CommandBar'").

- [ ] **Step 3: Create `src/renderer/components/CommandBar.tsx`**

```tsx
import { useRef, useState, type FormEvent, useEffect } from 'react';

interface Props {
  onSubmit(text: string): void;
  autoFocus?: boolean;
  busy?: boolean;
}

export function CommandBar({ onSubmit, autoFocus = true, busy = false }: Props) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue('');
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex items-center gap-3 px-4 py-3 rounded-xl bg-surface border border-border shadow-2xl"
    >
      <span className="text-muted text-sm select-none">⌘</span>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Ask Otto to do something…"
        disabled={busy}
        className="flex-1 bg-transparent outline-none text-text placeholder:text-muted text-base"
      />
      <kbd className="text-xs text-muted border border-border rounded px-1.5 py-0.5">↵</kbd>
    </form>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/renderer/components/CommandBar.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/CommandBar.tsx src/renderer/components/CommandBar.test.tsx
git commit -m "feat(renderer): add CommandBar component"
```

---

## Task 16: Message and ToolCallCard Components + ErrorCard

**Files:**
- Create: `src/renderer/components/Message.tsx`, `src/renderer/components/ToolCallCard.tsx`, `src/renderer/components/ErrorCard.tsx`
- Test: `src/renderer/components/Message.test.tsx`, `src/renderer/components/ToolCallCard.test.tsx`

- [ ] **Step 1: Write failing tests for Message**

`src/renderer/components/Message.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageView } from './Message';
import type { Message } from '@shared/messages';

const baseUser: Message = {
  id: 'm1',
  sessionId: 's1',
  seq: 0,
  createdAt: 0,
  role: 'user',
  content: [{ type: 'text', text: 'hi otto' }],
};

const baseAssistant: Message = {
  id: 'm2',
  sessionId: 's1',
  seq: 1,
  createdAt: 0,
  role: 'assistant',
  content: [{ type: 'text', text: 'hi user' }],
  cancelled: false,
  errored: false,
};

describe('MessageView', () => {
  it('renders a user message right-aligned with text', () => {
    render(<MessageView message={baseUser} />);
    expect(screen.getByText('hi otto')).toBeInTheDocument();
    expect(screen.getByTestId('message-user')).toBeInTheDocument();
  });

  it('renders an assistant message with text', () => {
    render(<MessageView message={baseAssistant} />);
    expect(screen.getByText('hi user')).toBeInTheDocument();
    expect(screen.getByTestId('message-assistant')).toBeInTheDocument();
  });

  it('renders a tool_use block as a ToolCallCard', () => {
    const m: Message = {
      ...baseAssistant,
      content: [
        { type: 'tool_use', callId: 'c1', name: 'echo', input: { msg: 'hi' } },
        { type: 'tool_result', callId: 'c1', result: 'hi', isError: false },
      ],
    };
    render(<MessageView message={m} />);
    expect(screen.getByText('echo')).toBeInTheDocument();
  });

  it('marks an errored assistant message', () => {
    render(<MessageView message={{ ...baseAssistant, errored: true } as Message} />);
    expect(screen.getByTestId('message-assistant')).toHaveClass('opacity-60');
  });
});
```

- [ ] **Step 2: Write failing test for ToolCallCard**

`src/renderer/components/ToolCallCard.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolCallCard } from './ToolCallCard';

describe('ToolCallCard', () => {
  it('shows tool name, status running when no result, and toggles details', async () => {
    render(<ToolCallCard name="echo" input={{ msg: 'hi' }} result={undefined} isError={false} />);
    expect(screen.getByText('echo')).toBeInTheDocument();
    expect(screen.getByText(/running/i)).toBeInTheDocument();
    expect(screen.queryByTestId('toolcall-details')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /echo/i }));
    expect(screen.getByTestId('toolcall-details')).toBeInTheDocument();
  });

  it('shows done with result', () => {
    render(<ToolCallCard name="echo" input={{ msg: 'hi' }} result="hi" isError={false} />);
    expect(screen.getByText(/done/i)).toBeInTheDocument();
  });

  it('shows error status when isError', () => {
    render(<ToolCallCard name="echo" input={{ msg: 'hi' }} result="oops" isError={true} />);
    expect(screen.getByText(/error/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test -- src/renderer/components/Message.test.tsx src/renderer/components/ToolCallCard.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Create `src/renderer/components/ToolCallCard.tsx`**

```tsx
import { useState } from 'react';

interface Props {
  name: string;
  input: unknown;
  result: unknown;
  isError: boolean;
}

export function ToolCallCard({ name, input, result, isError }: Props) {
  const [open, setOpen] = useState(false);
  const status: 'running' | 'done' | 'error' =
    result === undefined ? 'running' : isError ? 'error' : 'done';

  const statusColor = {
    running: 'text-muted',
    done: 'text-accent',
    error: 'text-danger',
  }[status];

  return (
    <div className="my-2 rounded-lg border border-border bg-bg/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-surface/40"
      >
        <span className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted">⚙</span>
          <span className="font-medium">{name}</span>
        </span>
        <span className={`uppercase tracking-wide text-[10px] ${statusColor}`}>{status}</span>
      </button>
      {open && (
        <div data-testid="toolcall-details" className="px-3 pb-3 text-xs font-mono space-y-2">
          <div>
            <div className="text-muted mb-1">input</div>
            <pre className="bg-bg/60 rounded p-2 overflow-x-auto">{JSON.stringify(input, null, 2)}</pre>
          </div>
          {result !== undefined && (
            <div>
              <div className="text-muted mb-1">result</div>
              <pre className="bg-bg/60 rounded p-2 overflow-x-auto">{JSON.stringify(result, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Create `src/renderer/components/Message.tsx`**

```tsx
import type { Message as MessageType, ContentBlock } from '@shared/messages';
import { ToolCallCard } from './ToolCallCard';

interface Props {
  message: MessageType;
}

export function MessageView({ message }: Props) {
  if (message.role === 'user') {
    return (
      <div
        data-testid="message-user"
        className="flex justify-end my-3"
      >
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent/20 border border-accent/30 px-4 py-2 text-sm">
          {renderText(message.content)}
        </div>
      </div>
    );
  }

  if (message.role === 'assistant') {
    const cls = ['my-3', message.errored ? 'opacity-60' : '', message.cancelled ? 'opacity-70 italic' : ''].join(' ');
    return (
      <div data-testid="message-assistant" className={cls}>
        {renderBlocks(message.content)}
        {message.cancelled && <div className="text-xs text-muted mt-1">(cancelled)</div>}
        {message.errored && <div className="text-xs text-danger mt-1">(error)</div>}
      </div>
    );
  }

  return (
    <div data-testid="message-tool" className="my-3 text-xs text-muted font-mono">
      {renderBlocks(message.content)}
    </div>
  );
}

function renderText(content: ContentBlock[]): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function renderBlocks(content: ContentBlock[]) {
  const elements: React.ReactNode[] = [];
  const toolResults = new Map<string, { result: unknown; isError: boolean }>();

  for (const b of content) {
    if (b.type === 'tool_result') toolResults.set(b.callId, { result: b.result, isError: b.isError ?? false });
  }

  let textBuffer = '';
  for (let i = 0; i < content.length; i += 1) {
    const b = content[i]!;
    if (b.type === 'text') {
      textBuffer += b.text;
      continue;
    }
    if (textBuffer) {
      elements.push(<p key={`t-${i}`} className="text-sm leading-relaxed whitespace-pre-wrap">{textBuffer}</p>);
      textBuffer = '';
    }
    if (b.type === 'tool_use') {
      const res = toolResults.get(b.callId);
      elements.push(
        <ToolCallCard
          key={b.callId}
          name={b.name}
          input={b.input}
          result={res?.result}
          isError={res?.isError ?? false}
        />
      );
    }
  }
  if (textBuffer) {
    elements.push(<p key="t-tail" className="text-sm leading-relaxed whitespace-pre-wrap">{textBuffer}</p>);
  }
  return <>{elements}</>;
}
```

- [ ] **Step 6: Create `src/renderer/components/ErrorCard.tsx`**

```tsx
import type { StructuredError } from '@shared/ipc-contract';

interface Props {
  error: StructuredError;
  onRetry?: () => void;
}

export function ErrorCard({ error, onRetry }: Props) {
  const headline =
    error.kind === 'auth-missing'
      ? 'Sign in to Claude Code, then retry.'
      : error.message;

  return (
    <div className="my-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
      <div className="text-danger font-medium">{headline}</div>
      {error.kind !== 'auth-missing' && (
        <div className="text-xs text-muted mt-1 font-mono">{error.message}</div>
      )}
      {error.retryable && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 text-xs text-accent hover:underline"
        >
          Retry
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run test -- src/renderer/components/Message.test.tsx src/renderer/components/ToolCallCard.test.tsx`
Expected: PASS (7 tests total).

- [ ] **Step 8: Commit**

```bash
git add src/renderer/components/Message.tsx src/renderer/components/Message.test.tsx \
        src/renderer/components/ToolCallCard.tsx src/renderer/components/ToolCallCard.test.tsx \
        src/renderer/components/ErrorCard.tsx
git commit -m "feat(renderer): add Message, ToolCallCard, ErrorCard components"
```

---

## Task 17: MessageList

**Files:**
- Create: `src/renderer/components/MessageList.tsx`

> Virtualization is overkill for the skeleton; a plain scroller suffices. Swap to a virtualizer later if message counts hurt.

- [ ] **Step 1: Create `src/renderer/components/MessageList.tsx`**

```tsx
import { useEffect, useRef } from 'react';
import type { Message } from '@shared/messages';
import { MessageView } from './Message';

interface Props {
  messages: Message[];
  streaming: boolean;
}

export function MessageList({ messages, streaming }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streaming]);

  return (
    <div className="flex-1 overflow-y-auto px-4">
      {messages.map((m) => (
        <MessageView key={m.id} message={m} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/MessageList.tsx
git commit -m "feat(renderer): add MessageList with autoscroll"
```

---

## Task 18: Panel

**Files:**
- Create: `src/renderer/components/Panel.tsx`

- [ ] **Step 1: Create `src/renderer/components/Panel.tsx`**

```tsx
import { type ReactNode } from 'react';

interface Props {
  header: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}

export function Panel({ header, footer, children }: Props) {
  return (
    <div className="flex flex-col h-full w-full rounded-xl bg-surface border border-border shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-bg/50">
        {header}
      </div>
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
      <div className="border-t border-border px-3 py-2 bg-bg/40">{footer}</div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/Panel.tsx
git commit -m "feat(renderer): add Panel layout shell"
```

---

## Task 19: SessionSwitcher

**Files:**
- Create: `src/renderer/components/SessionSwitcher.tsx`

- [ ] **Step 1: Create `src/renderer/components/SessionSwitcher.tsx`**

```tsx
import { useState } from 'react';
import type { SessionMeta } from '@shared/messages';

interface Props {
  sessions: SessionMeta[];
  activeSessionId: string | null;
  onSelect(id: string): void;
  onNew(): void;
}

export function SessionSwitcher({ sessions, activeSessionId, onSelect, onNew }: Props) {
  const [open, setOpen] = useState(false);
  const active = sessions.find((s) => s.id === activeSessionId);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-muted hover:text-text px-2 py-1 rounded hover:bg-surface/60"
      >
        {active?.title?.slice(0, 30) ?? 'Otto'} ▾
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 w-72 max-h-80 overflow-y-auto rounded-lg border border-border bg-surface shadow-xl z-10">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onNew();
            }}
            className="w-full text-left px-3 py-2 text-sm hover:bg-bg/40 border-b border-border"
          >
            + New session
          </button>
          {sessions.length === 0 && (
            <div className="px-3 py-3 text-xs text-muted">No past sessions</div>
          )}
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setOpen(false);
                onSelect(s.id);
              }}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-bg/40 ${
                s.id === activeSessionId ? 'bg-accent/10' : ''
              }`}
            >
              <div className="truncate">{s.title ?? '(untitled)'}</div>
              <div className="text-[10px] text-muted">{new Date(s.lastActive).toLocaleString()}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/SessionSwitcher.tsx
git commit -m "feat(renderer): add SessionSwitcher popover"
```

---

## Task 20: StatusFooter

**Files:**
- Create: `src/renderer/components/StatusFooter.tsx`

- [ ] **Step 1: Create `src/renderer/components/StatusFooter.tsx`**

```tsx
interface Props {
  model: string;
  sessionId: string | null;
  streaming: boolean;
}

export function StatusFooter({ model, sessionId, streaming }: Props) {
  return (
    <div className="flex items-center justify-between text-[10px] text-muted">
      <div className="flex items-center gap-2">
        <span className="px-1.5 py-0.5 rounded bg-bg/60 border border-border">{model}</span>
        {sessionId && <span className="font-mono truncate max-w-[200px]">{sessionId}</span>}
      </div>
      <div>{streaming ? 'thinking…' : ''}</div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/StatusFooter.tsx
git commit -m "feat(renderer): add StatusFooter"
```

---

## Task 21: App Wiring

**Files:**
- Modify: `src/renderer/main.tsx`
- Create: `src/renderer/App.tsx`

- [ ] **Step 1: Replace `src/renderer/main.tsx`**

```tsx
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
```

- [ ] **Step 2: Create `src/renderer/App.tsx`**

```tsx
import { useEffect, useCallback } from 'react';
import { ipc } from './ipc';
import { useOttoStore } from './state/store';
import { CommandBar } from './components/CommandBar';
import { Panel } from './components/Panel';
import { MessageList } from './components/MessageList';
import { SessionSwitcher } from './components/SessionSwitcher';
import { StatusFooter } from './components/StatusFooter';
import { ErrorCard } from './components/ErrorCard';

const MODEL = 'claude-sonnet-4-6';

export function App() {
  const windowMode = useOttoStore((s) => s.windowMode);
  const activeSession = useOttoStore((s) => s.activeSession);
  const sessions = useOttoStore((s) => s.sessions);
  const setWindowMode = useOttoStore((s) => s.setWindowMode);
  const beginSession = useOttoStore((s) => s.beginSession);
  const loadSession = useOttoStore((s) => s.loadSession);
  const appendUserMessage = useOttoStore((s) => s.appendUserMessage);
  const applyEvent = useOttoStore((s) => s.applyEvent);
  const setSessions = useOttoStore((s) => s.setSessions);

  useEffect(() => {
    return ipc.onSessionEvent((e) => applyEvent(e));
  }, [applyEvent]);

  useEffect(() => {
    void ipc.invoke('session.list', undefined).then(setSessions);
  }, [setSessions]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (windowMode === 'panel') {
        setWindowMode('bar');
        void ipc.invoke('window.collapseToBar', undefined);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [windowMode, setWindowMode]);

  const handleSubmit = useCallback(
    async (text: string) => {
      setWindowMode('panel');
      let sessionId = activeSession?.id;
      if (!sessionId) {
        const { sessionId: newId } = await ipc.invoke('session.start', {});
        sessionId = newId;
        beginSession(newId);
      }
      appendUserMessage(crypto.randomUUID(), text);
      await ipc.invoke('session.send', { sessionId, text });
      void ipc.invoke('session.list', undefined).then(setSessions);
    },
    [activeSession, beginSession, appendUserMessage, setWindowMode, setSessions]
  );

  const handleSelectSession = useCallback(
    async (id: string) => {
      const messages = await ipc.invoke('session.load', { sessionId: id });
      loadSession(id, messages);
      setWindowMode('panel');
    },
    [loadSession, setWindowMode]
  );

  const handleNewSession = useCallback(async () => {
    const { sessionId } = await ipc.invoke('session.start', {});
    beginSession(sessionId);
    setWindowMode('panel');
  }, [beginSession, setWindowMode]);

  if (windowMode === 'bar') {
    return (
      <div className="w-screen h-screen p-1">
        <CommandBar onSubmit={handleSubmit} />
      </div>
    );
  }

  return (
    <div className="w-screen h-screen p-1">
      <Panel
        header={
          <SessionSwitcher
            sessions={sessions}
            activeSessionId={activeSession?.id ?? null}
            onSelect={handleSelectSession}
            onNew={handleNewSession}
          />
        }
        footer={
          <div className="flex flex-col gap-2">
            <CommandBar onSubmit={handleSubmit} busy={activeSession?.streaming ?? false} />
            <StatusFooter
              model={MODEL}
              sessionId={activeSession?.id ?? null}
              streaming={activeSession?.streaming ?? false}
            />
          </div>
        }
      >
        <MessageList
          messages={activeSession?.messages ?? []}
          streaming={activeSession?.streaming ?? false}
        />
        {activeSession?.error && (
          <div className="px-4">
            <ErrorCard error={activeSession.error} />
          </div>
        )}
      </Panel>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/App.tsx src/renderer/main.tsx
git commit -m "feat(renderer): wire App with bar/panel modes and IPC"
```

---

## Task 22: Main Entry — Wire Everything

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Replace `src/main/index.ts`**

```ts
import { app, dialog } from 'electron';
import path from 'node:path';
import { logger, ottoConfigDir } from './logger';
import { openDatabase } from './db/db';
import { Repo } from './db/repo';
import { WindowManager, rendererEntry } from './window';
import { HotkeyManager } from './hotkey';
import { getPlatformAdapter } from './platform';
import { SessionManager } from './agent/session';
import { createRealSdkClient } from './agent/sdk-client';
import { registerIpcHandlers } from './ipc/handlers';
import { emitSessionEvent } from './ipc/events';

const SMART_RESUME_WINDOW_MS = 30 * 60 * 1000;

async function bootstrap() {
  app.commandLine.appendSwitch('disable-features', 'Wayland'); // best-effort

  await app.whenReady();

  let db;
  try {
    db = openDatabase(path.join(ottoConfigDir, 'otto.db'));
  } catch (err) {
    logger.error('failed to open database', err);
    dialog.showErrorBox('Otto', `Database open failed: ${err instanceof Error ? err.message : err}`);
    app.exit(1);
    return;
  }

  const repo = new Repo(db);
  const platform = getPlatformAdapter();
  const window = new WindowManager();
  const sdk = createRealSdkClient();
  const sessions = new SessionManager(repo, sdk, 'claude-sonnet-4-6', emitSessionEvent);

  const preloadPath = path.join(app.getAppPath(), 'out', 'preload', 'index.js');
  window.create(preloadPath, rendererEntry());

  registerIpcHandlers({ repo, sessions, window });

  const hotkey = new HotkeyManager(platform, () => {
    const mode = shouldResume(repo, sessions) ? 'panel' : 'bar';
    window.toggle(mode);
  });
  const hotkeyState = hotkey.register();
  if (!hotkeyState.registered) {
    logger.warn(`hotkey not registered: ${hotkeyState.failureReason}`);
  }

  app.on('window-all-closed', () => {
    // keep running in background; quit via tray/menu (future)
  });

  app.on('before-quit', () => {
    hotkey.unregisterAll();
    db.close();
  });

  process.on('unhandledRejection', (reason) => logger.error('unhandledRejection', reason));
  process.on('uncaughtException', (err) => logger.error('uncaughtException', err));
}

function shouldResume(repo: Repo, sessions: SessionManager): boolean {
  const active = sessions.getActiveSessionId();
  if (!active) return false;
  const meta = repo.getSession(active);
  if (!meta) return false;
  return meta.status === 'active' || Date.now() - meta.lastActive < SMART_RESUME_WINDOW_MS;
}

bootstrap().catch((err) => {
  logger.error('bootstrap failed', err);
  app.exit(1);
});
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS — produces `out/main`, `out/preload`, `out/renderer`.

- [ ] **Step 3: Manual smoke (dev mode)**

Run: `npm run dev`
Expected: app launches; press `Ctrl+Alt+Space` → bar appears; typing "say hi" + Enter streams a response from Claude (assuming local Claude Code is signed in); Esc collapses; Esc again hides; reopening within 30 min shows the same session.

Document any deviations and fix before committing.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(main): wire bootstrap (db, sdk, window, hotkey, ipc)"
```

---

## Task 23: Playwright Integration Smoke Test

**Files:**
- Create: `playwright.config.ts`, `tests/integration/smoke.spec.ts`

> The smoke test launches the packaged Electron app, fires the hotkey programmatically by sending it through the renderer (since global hotkeys aren't reliably testable via Playwright), types a prompt, and asserts streaming UI updates. The real SDK is bypassed by setting `OTTO_FAKE_SDK=1`, which `sdk-client.ts` honors below.

- [ ] **Step 1: Update `src/main/agent/sdk-client.ts`** to support a fake mode for tests

Add at the top, after imports:
```ts
import type { SdkStreamEvent } from './session';

function createFakeSdkClient(): SdkClient {
  let counter = 0;
  return {
    async startSession() {
      counter += 1;
      return { id: `fake-${counter}` };
    },
    sendTurn(_sid, text, signal) {
      async function* events(): AsyncIterable<SdkStreamEvent> {
        yield { type: 'message-start' };
        for (const ch of `echo: ${text}`) {
          if (signal.aborted) return;
          yield { type: 'text-delta', text: ch };
          await new Promise((r) => setTimeout(r, 5));
        }
        yield { type: 'tool-call-start', callId: 'c1', name: 'echo', input: { msg: text } };
        yield { type: 'tool-call-result', callId: 'c1', result: text, isError: false };
        yield { type: 'message-end' };
        yield { type: 'done' };
      }
      return { signal, events };
    },
  };
}
```

Change the export:
```ts
export function createRealSdkClient(): SdkClient {
  if (process.env.OTTO_FAKE_SDK === '1') return createFakeSdkClient();
  // …existing real implementation below…
}
```

- [ ] **Step 2: Create `playwright.config.ts`**

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/integration',
  timeout: 30_000,
  fullyParallel: false,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
  },
});
```

- [ ] **Step 3: Create `tests/integration/smoke.spec.ts`**

```ts
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

test('skeleton smoke: send prompt, see streaming text + tool card', async () => {
  const cfg = mkdtempSync(path.join(tmpdir(), 'otto-e2e-'));
  const app = await electron.launch({
    args: [path.join(process.cwd(), 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      OTTO_FAKE_SDK: '1',
      XDG_CONFIG_HOME: cfg,
      NODE_ENV: 'test',
    },
  });

  const page = await app.firstWindow();
  await page.waitForSelector('input[placeholder*="Ask Otto" i]');

  // Window may start hidden; force show via Electron API for the test
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.show();
  });

  await page.fill('input[placeholder*="Ask Otto" i]', 'hi');
  await page.press('input[placeholder*="Ask Otto" i]', 'Enter');

  await expect(page.getByTestId('message-user')).toContainText('hi');
  await expect(page.getByTestId('message-assistant')).toContainText('echo: hi', { timeout: 5000 });
  await expect(page.getByText('echo', { exact: true })).toBeVisible();

  await app.close();
  rmSync(cfg, { recursive: true, force: true });
});
```

- [ ] **Step 4: Build then run integration tests**

Run: `npm run build`
Run: `npx playwright install chromium`
Run: `npm run test:integration`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts tests/ src/main/agent/sdk-client.ts
git commit -m "test(integration): add playwright smoke covering streaming + tool card"
```

---

## Task 24: electron-builder Config + Linux Build

**Files:**
- Create: `electron-builder.yml`

- [ ] **Step 1: Create `electron-builder.yml`**

```yaml
appId: dev.otto.app
productName: Otto
directories:
  output: dist
  buildResources: build
files:
  - out/**
  - package.json
linux:
  target:
    - AppImage
    - deb
  category: Utility
  artifactName: ${productName}-${version}-${arch}.${ext}
asarUnpack:
  - "**/node_modules/better-sqlite3/**"
```

- [ ] **Step 2: Run a packaging build**

Run: `npm run package`
Expected: PASS — produces `dist/Otto-0.0.1-x86_64.AppImage` and `.deb`.

If `better-sqlite3` fails to load from the AppImage, verify `asarUnpack` covers the native module. The package's prebuilt binary should resolve at runtime; a rebuild is unnecessary.

- [ ] **Step 3: Commit**

```bash
git add electron-builder.yml
git commit -m "build: add electron-builder linux config (AppImage + deb)"
```

---

## Task 25: Final Manual Verification

**Files:** none — runtime smoke.

- [ ] **Step 1: Run the packaged AppImage**

```bash
./dist/Otto-0.0.1-x86_64.AppImage
```

- [ ] **Step 2: Walk the manual checklist (from spec)**

- [ ] Hotkey `Ctrl+Alt+Space` toggles window show/hide.
- [ ] Typing a prompt → streaming text appears as deltas.
- [ ] Echo tool call renders a `ToolCallCard` with name/args/result. (Trigger by prompting Otto to "use the echo tool with msg='hello'".)
- [ ] Esc collapses panel → bar; Esc again hides.
- [ ] Close + reopen → session resumes if within 30 min.
- [ ] Past sessions visible in switcher; clicking loads them.
- [ ] Restart app → sessions still present.
- [ ] If `~/.claude` creds are missing, an error card shows the auth message.

Document any failure as a follow-up commit; the skeleton is "done" only when all checks pass.

- [ ] **Step 3: Commit any fixes from the walkthrough**

Per-fix commit messages as appropriate (e.g., `fix(window): correct top-center on multi-monitor`).

---

## Self-Review Notes

Mapped each spec section to tasks:
- **Goals / Architecture / Directory Layout** → Tasks 1, 6, 22 (scaffold + platform + bootstrap).
- **Components (Renderer + Main)** → Tasks 7 (window), 8 (hotkey), 9–10 (agent), 11 (ipc), 12 (preload), 13–21 (renderer).
- **IPC Contract / Turn Lifecycle / Smart-Resume / Stub Tool** → Tasks 2, 9, 10, 22, 21.
- **Persistence (schema, write/read points)** → Tasks 4, 5; write points exercised in 9; reads in 11/21.
- **Window Behavior** → Task 7 (modes, positioning, top-center); show/hide & Esc in Tasks 8/21.
- **Linux Specifics (Wayland warning)** → Task 6, 8.
- **Error Handling** (all six cases) → SDK errors in Task 9; hotkey failure in Task 8; SQLite open failure in Task 22; cancellation in Task 9; unhandled rejections in Task 22; renderer crash relies on Electron defaults — noted.
- **Logging** → Task 3.
- **Testing (Unit / Component / Integration)** → Tasks 4, 5, 6, 9, 13, 15, 16 (unit + component); Task 23 (integration).
- **Manual Verification Checklist** → Task 25.

No placeholders, no "TBD", no "similar to task N". Method names cross-checked (`beginSession`, `loadSession`, `appendUserMessage`, `applyEvent`, `appendMessage`, `loadMessages`, `getActiveSessionId`) are consistent across tasks.

Open seam noted in Task 10: the Agent SDK's exact event shape may need adjustments to `mapSdkEvent` once the real package's event names are observed in dev.
