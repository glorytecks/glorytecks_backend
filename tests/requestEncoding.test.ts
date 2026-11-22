import './setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import zlib from 'zlib';
import { AddressInfo } from 'net';
import app from '../src/app';

/**
 * Compressed request bodies are refused, not decompressed (security audit,
 * 2026-11-14, F-02).
 *
 * The body parsers run before routing and before authentication, so whatever
 * they do with a body they do for anyone. With decompression on, a malformed
 * gzip stream from a stranger answered 500 and wrote an error to the log, and
 * body-parser before 1.20.9 could be made to end the process with one request
 * (GHSA-27r3-jxmh-p828). No client of this API compresses its requests, so the
 * parsers are created with `inflate: false`: an encoded body gets 415 and no
 * decompression stream is ever created.
 *
 * Driven through the real app, so removing the option from app.ts fails here.
 */

let server: http.Server;
let base: string;

test.before(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.after(() => server.close());

interface Reply {
  status: number;
  body: { success?: boolean; message?: string; code?: string; stack?: string };
  raw: string;
}

/** A lead a visitor could post. Valid, so an accepted request gets as far as the (stubbed, unreachable) database. */
const LEAD = JSON.stringify({ name: 'Local test', phone: '9999999999' });

let ipCounter = 10;

function post(path: string, body: Buffer, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        // A fresh address per request, so the hourly form limit never answers for the parser.
        headers: { 'Content-Length': body.length, 'X-Forwarded-For': `203.0.113.${ipCounter++}`, ...headers },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed = {};
          try {
            parsed = JSON.parse(raw);
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, raw });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const JSON_TYPE = { 'Content-Type': 'application/json' };

test('a plain JSON body is read as before', async () => {
  const res = await post('/api/v1/public/demo-requests', Buffer.from(LEAD), JSON_TYPE);
  // Past the parser and the validator: the stubbed database is what answers.
  assert.equal(res.status, 503);
  assert.notEqual(res.body.code, 'UNSUPPORTED_MEDIA_TYPE');
});

test('an explicit identity encoding is still a plain body', async () => {
  const res = await post('/api/v1/public/demo-requests', Buffer.from(LEAD), { ...JSON_TYPE, 'Content-Encoding': 'identity' });
  assert.equal(res.status, 503);
});

for (const [encoding, compress] of [
  ['gzip', zlib.gzipSync],
  ['deflate', zlib.deflateSync],
  ['br', zlib.brotliCompressSync],
] as const) {
  test(`a ${encoding} body is refused with 415 and is never decompressed`, async () => {
    const res = await post('/api/v1/public/demo-requests', compress(Buffer.from(LEAD)), { ...JSON_TYPE, 'Content-Encoding': encoding });
    assert.equal(res.status, 415);
    assert.equal(res.body.success, false);
    assert.equal(res.body.code, 'UNSUPPORTED_MEDIA_TYPE');
    assert.equal(res.body.message, 'Unsupported request encoding');
    assert.equal(res.body.stack, undefined);
  });
}

test('a compressed frame followed by trailing bytes is a 415, not a server error', async () => {
  const frame = zlib.gzipSync(Buffer.from(LEAD));
  const body = Buffer.concat([frame, Buffer.from('trailing-bytes-after-the-frame')]);
  const res = await post('/api/v1/public/demo-requests', body, { ...JSON_TYPE, 'Content-Encoding': 'gzip' });
  assert.equal(res.status, 415);
  assert.ok(!res.raw.includes('incorrect header check'), 'the decoder was never run, so its error cannot appear');
});

test('bytes that are not a compressed stream at all are refused the same way', async () => {
  const res = await post('/api/v1/public/demo-requests', Buffer.from('this is not gzip'), { ...JSON_TYPE, 'Content-Encoding': 'gzip' });
  assert.equal(res.status, 415);
});

test('the refusal happens before authentication, on admin routes too', async () => {
  const res = await post('/api/v1/auth/login', zlib.gzipSync(Buffer.from('{"email":"a@b.test","password":"x"}')), {
    ...JSON_TYPE,
    'Content-Encoding': 'gzip',
  });
  assert.equal(res.status, 415);
});

test('a form-encoded body is held to the same rule', async () => {
  const res = await post('/api/v1/public/demo-requests', zlib.gzipSync(Buffer.from('name=Local+test&phone=9999999999')), {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Encoding': 'gzip',
  });
  assert.equal(res.status, 415);
});

test('the server keeps answering after every one of those', async () => {
  const res = await post('/api/v1/public/demo-requests', Buffer.from(LEAD), JSON_TYPE);
  assert.equal(res.status, 503);
});
