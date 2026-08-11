import { networkInterfaces } from 'node:os';

/**
 * Where this bridge can be reached from — as a URL somebody can actually type.
 *
 * Binding to every interface is the easy half. The hard half is that the
 * machine running the bridge is the one machine that never needs the answer,
 * and whoever does need it is holding a tablet in another room. So the
 * addresses are worked out here, printed at startup and shown on the homepage,
 * rather than left as an `ipconfig` somebody has to run under pressure on a
 * Sunday morning.
 */

/** A bind address meaning "every interface", which is never a host to type. */
export function isWildcard(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '';
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * Private ranges first, in the order a mandir network is likely to use them.
 * A Docker or VPN interface answers too, but typing it into a tablet gets
 * nowhere, so it sorts below anything that looks like the real LAN.
 */
function rank(address: string): number {
  if (address.startsWith('192.168.')) return 0;
  if (address.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  return 3;
}

/** Every non-internal IPv4 this machine answers on, best candidate first. */
export function lanAddresses(interfaces = networkInterfaces()): string[] {
  const found: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      // Node reports 4 today and 'IPv4' in older typings; accept both.
      const ipv4 = entry.family === 'IPv4' || (entry.family as unknown as number) === 4;
      if (!ipv4 || entry.internal) continue;
      if (!found.includes(entry.address)) found.push(entry.address);
    }
  }
  return found.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * The hosts to offer for a given bind address, LAN before loopback.
 *
 * LAN first because the homepage's first job is to be opened somewhere else;
 * the address of the machine you are already sitting at is the one you do not
 * need. A bound host that is not a wildcard is offered as itself and nothing
 * more — it is the only one that would work.
 */
export function reachableHosts(host: string, addresses = lanAddresses()): string[] {
  if (!isWildcard(host)) return [host];
  return [...addresses, '127.0.0.1'];
}

/**
 * Whether a request came from the same building, near enough.
 *
 * Loopback, the three RFC 1918 ranges, link-local and carrier-grade NAT. Read
 * off the socket rather than any header, because X-Forwarded-For is a claim
 * anybody can make and this decides who is handed the token.
 */
export function isPrivateAddress(address: string | undefined): boolean {
  if (!address) return false;
  // Node reports IPv4 over a dual-stack socket as ::ffff:192.168.1.5.
  const plain = address.startsWith('::ffff:') ? address.slice(7) : address;

  if (plain === '::1' || plain === '127.0.0.1' || plain.startsWith('127.')) return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/i.test(plain) || /^fe[89ab][0-9a-f]:/i.test(plain)) return true;

  const octets = plain.split('.');
  if (octets.length !== 4) return false;
  const [a, b] = octets.map(Number) as [number, number];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;

  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** The host to print in a URL: never 0.0.0.0, which nothing can dial. */
export function displayHost(host: string, addresses = lanAddresses()): string {
  if (!isWildcard(host)) return host;
  return addresses[0] ?? '127.0.0.1';
}
