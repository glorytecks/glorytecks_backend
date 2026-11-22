import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

/**
 * Outbound HTTP for the technical SEO audit, built so the crawler can only
 * ever reach the site it was configured for.
 *
 *   • https only, default port only, no credentials in the URL, no IP-literal
 *     hosts, and the host must be on an explicit allowlist the caller passes;
 *   • every address a host resolves to is checked against private, loopback,
 *     link-local (cloud metadata), carrier-NAT, multicast and reserved ranges,
 *     inside the connection's own lookup — the address that is checked is the
 *     address that is connected to, so a DNS answer cannot change in between;
 *   • redirects are never followed here: the caller sees each Location and
 *     decides, against the same allowlist, whether to take the next hop;
 *   • every request has a deadline and a body-size cap, and bodies are only
 *     read when asked for.
 *
 * No dependency: node:http(s) with a custom `lookup`.
 */

/* ── Addresses ────────────────────────────────────────────────────────────── */

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including 169.254.169.254 (cloud metadata)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and the broadcast address
];

const v4ToInt = (ip: string): number => ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;

function v4Blocked(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

/** Expand an IPv6 address to eight 16-bit groups. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0];
  // A trailing dotted IPv4 (::ffff:1.2.3.4) becomes two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const n = v4ToInt(dotted[1]);
    s = s.slice(0, -dotted[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  if (s.split('::').length > 2) return null;
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  if (fill < 0) return null;
  const groups = [...left, ...Array(fill).fill('0'), ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function v6Blocked(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return true; // unparseable: refuse
  const embeddedV4 = () => `${g[6] >>> 8}.${g[6] & 0xff}.${g[7] >>> 8}.${g[7] & 0xff}`;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4Blocked(embeddedV4()); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return true; // deprecated IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b) return v4Blocked(embeddedV4()); // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2002) return v4Blocked(`${g[1] >>> 8}.${g[1] & 0xff}.${g[2] >>> 8}.${g[2] & 0xff}`); // 6to4
  return false;
}

/** True when an address must never be connected to: not a public unicast address. */
export function isBlockedAddress(ip: string): boolean {
  const kind = net.isIP(ip.replace(/^\[|\]$/g, ''));
  if (kind === 4) return v4Blocked(ip);
  if (kind === 6) return v6Blocked(ip.replace(/^\[|\]$/g, ''));
  return true;
}

/* ── URLs ─────────────────────────────────────────────────────────────────── */

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

const BLOCKED_NAMES = /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata|metadata\.google\.internal)$/;

/**
 * May the audit request this URL? Only https on the default port, to an
 * approved host by name. `approvedHosts` are exact host names.
 */
export function checkAuditUrl(raw: string, approvedHosts: readonly string[], { allowHttp = false } = {}): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid absolute URL' };
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    return { ok: false, reason: `${url.protocol.replace(':', '')} is not allowed, only https` };
  }
  if (url.username || url.password) return { ok: false, reason: 'credentials in the URL are not allowed' };
  if (url.port) return { ok: false, reason: `port ${url.port} is not allowed` };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (net.isIP(host.replace(/^\[|\]$/g, ''))) return { ok: false, reason: 'IP address hosts are not allowed' };
  if (BLOCKED_NAMES.test(host)) return { ok: false, reason: `${host} is a local or internal name` };
  if (!approvedHosts.map((h) => h.toLowerCase()).includes(host)) {
    return { ok: false, reason: `${host} is not an approved host` };
  }
  return { ok: true, url };
}

/* ── Requests ─────────────────────────────────────────────────────────────── */

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

const systemResolver: Resolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

export interface FetchOptions {
  method?: 'GET' | 'HEAD';
  /** Read the body (GET only). Without it the response is closed after its headers. */
  readBody?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface FetchResult {
  status: number;
  location: string | null;
  contentType: string;
  xRobotsTag: string | null;
  body: string | null;
  /** The body was cut at maxBytes. */
  truncated: boolean;
  ms: number;
}

/** A failure to get any HTTP answer. `reason` is safe to show and store. */
export class FetchFailure extends Error {
  constructor(
    public readonly reason: string,
    /** Worth trying again later (timeouts, resets) as opposed to a refusal by policy. */
    public readonly transient: boolean,
  ) {
    super(reason);
  }
}

export interface Transport {
  fetch(url: string, opts?: FetchOptions): Promise<FetchResult>;
}

export interface TransportOptions {
  resolver?: Resolver;
  /** Tests only: let a local fixture server answer. Never set from configuration. */
  allowPrivateAddresses?: boolean;
  /** Tests only: plain http to a local fixture server. */
  allowHttp?: boolean;
  userAgent?: string;
}

export const AUDIT_USER_AGENT = 'GloryTecksSEOAudit/1.0 (+admin technical SEO audit)';

export function createTransport(options: TransportOptions = {}): Transport {
  const resolver = options.resolver ?? systemResolver;
  const blockPrivate = !options.allowPrivateAddresses;
  const userAgent = options.userAgent ?? AUDIT_USER_AGENT;

  // The lookup the socket itself uses: resolve, refuse any blocked address,
  // connect to the address that was checked.
  const lookup = (
    hostname: string,
    opts: { all?: boolean } | number,
    cb: (err: NodeJS.ErrnoException | null, address?: string | { address: string; family: number }[], family?: number) => void,
  ) => {
    resolver(hostname).then(
      (addresses) => {
        if (addresses.length === 0) return cb(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }));
        if (blockPrivate && addresses.some((a) => isBlockedAddress(a.address))) {
          return cb(Object.assign(new Error('resolves to a private or reserved address'), { code: 'EBLOCKED' }));
        }
        const first = addresses[0];
        if (typeof opts === 'object' && opts?.all) return cb(null, [first]);
        return cb(null, first.address, first.family);
      },
      (err: NodeJS.ErrnoException) => cb(err),
    );
  };

  return {
    fetch(raw, { method = 'GET', readBody = false, maxBytes = 2_000_000, timeoutMs = 6000 } = {}) {
      return new Promise<FetchResult>((resolve, reject) => {
        let url: URL;
        try {
          url = new URL(raw);
        } catch {
          return reject(new FetchFailure('not a valid URL', false));
        }
        const isHttps = url.protocol === 'https:';
        if (!isHttps && !(options.allowHttp && url.protocol === 'http:')) {
          return reject(new FetchFailure('only https is allowed', false));
        }
        // Node connects to an IP-literal host without calling `lookup`, so the
        // address check below would never see it. Check it here instead.
        const literal = url.hostname.replace(/^\[|\]$/g, '');
        if (blockPrivate && net.isIP(literal) && isBlockedAddress(literal)) {
          return reject(new FetchFailure('the host is a private or reserved address', false));
        }
        const started = Date.now();
        const mod = isHttps ? https : http;
        let settled = false;
        const fail = (reason: string, transient: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          reject(new FetchFailure(reason, transient));
        };

        const req = mod.request(
          url,
          {
            method,
            agent: false,
            lookup: lookup as never,
            headers: {
              'user-agent': userAgent,
              accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'accept-encoding': 'identity',
            },
          },
          (res) => {
            const status = res.statusCode ?? 0;
            const header = (name: string) => {
              const v = res.headers[name];
              return Array.isArray(v) ? v.join(', ') : (v ?? null);
            };
            const base = {
              status,
              location: header('location'),
              contentType: header('content-type') ?? '',
              xRobotsTag: header('x-robots-tag'),
            };
            if (!readBody || method === 'HEAD') {
              res.destroy();
              settled = true;
              clearTimeout(deadline);
              return resolve({ ...base, body: null, truncated: false, ms: Date.now() - started });
            }
            const chunks: Buffer[] = [];
            let size = 0;
            let truncated = false;
            res.on('data', (chunk: Buffer) => {
              if (truncated) return;
              size += chunk.length;
              if (size > maxBytes) {
                truncated = true;
                chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
                res.destroy();
                finish();
                return;
              }
              chunks.push(chunk);
            });
            const finish = () => {
              if (settled) return;
              settled = true;
              clearTimeout(deadline);
              resolve({ ...base, body: Buffer.concat(chunks).toString('utf8'), truncated, ms: Date.now() - started });
            };
            res.on('end', finish);
            res.on('error', () => (truncated ? finish() : fail('the connection broke while reading', true)));
          },
        );

        const deadline = setTimeout(() => {
          fail(`no answer within ${Math.round(timeoutMs / 100) / 10} s`, true);
          req.destroy();
        }, timeoutMs);

        req.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EBLOCKED') return fail('the host resolves to a private or reserved address', false);
          if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return fail('the host name does not resolve', err.code === 'EAI_AGAIN');
          if (err.code === 'ECONNREFUSED') return fail('the connection was refused', true);
          if (err.code === 'ECONNRESET') return fail('the connection was reset', true);
          if (/CERT|SSL|TLS/i.test(err.code ?? err.message)) return fail('the TLS certificate was not accepted', false);
          return fail('the request failed', true);
        });
        req.end();
      });
    },
  };
}
