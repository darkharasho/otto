// src/main/voice/__fixtures__/fake-whisper-server.mjs
// Mimics whisper-server's HTTP surface: GET / -> 200, POST /inference -> JSON.
// Usage: node fake-whisper-server.mjs --port N [--delay-ms N] [--crash-after-start]
import http from 'node:http';

const argv = process.argv.slice(2);
const get = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
const port = Number(get('--port'));
const delayMs = Number(get('--delay-ms') ?? 0);
const crashAfterStart = argv.includes('--crash-after-start');

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/inference') {
    let size = 0;
    req.on('data', (c) => (size += c.length));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ text: ` transcribed ${size} bytes ` }));
    });
    return;
  }
  res.end('ok');
});

setTimeout(() => {
  server.listen(port, '127.0.0.1', () => {
    if (crashAfterStart) setTimeout(() => process.exit(7), 500);
  });
}, delayMs);
