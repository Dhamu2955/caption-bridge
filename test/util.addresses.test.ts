import type { NetworkInterfaceInfo } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  displayHost,
  isLoopback,
  isPrivateAddress,
  isWildcard,
  lanAddresses,
  reachableHosts,
} from '../src/util/addresses.js';

/** Only the three fields the helper reads; the rest of NetworkInterfaceInfo
 *  would be noise in every case below. */
const iface = (address: string, internal = false, family = 'IPv4') =>
  ({ address, internal, family }) as unknown as NetworkInterfaceInfo;

describe('addresses', () => {
  it('treats every wildcard bind as un-dialable', () => {
    expect(isWildcard('0.0.0.0')).toBe(true);
    expect(isWildcard('::')).toBe(true);
    expect(isWildcard('192.168.1.5')).toBe(false);
  });

  it('recognises loopback under all three spellings', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) expect(isLoopback(host)).toBe(true);
    expect(isLoopback('0.0.0.0')).toBe(false);
  });

  it('ignores loopback and IPv6 interfaces', () => {
    const found = lanAddresses({
      lo0: [iface('127.0.0.1', true), iface('::1', true, 'IPv6')],
      en0: [iface('192.168.1.42'), iface('fe80::1', false, 'IPv6')],
    });
    expect(found).toEqual(['192.168.1.42']);
  });

  it('puts the address most likely to be the mandir LAN first', () => {
    // A Docker bridge and a VPN answer too, and typing either into a tablet
    // gets nowhere — so the home network sorts above them.
    const found = lanAddresses({
      docker0: [iface('172.17.0.1')],
      tun0: [iface('100.64.0.3')],
      en0: [iface('192.168.1.42')],
    });
    expect(found[0]).toBe('192.168.1.42');
    expect(found).toContain('172.17.0.1');
  });

  it('offers the LAN before loopback when bound to everything', () => {
    expect(reachableHosts('0.0.0.0', ['192.168.1.42'])).toEqual(['192.168.1.42', '127.0.0.1']);
  });

  it('offers only the bound host when it is not a wildcard', () => {
    // Someone who set 127.0.0.1 deliberately must not be told the LAN works.
    expect(reachableHosts('127.0.0.1', ['192.168.1.42'])).toEqual(['127.0.0.1']);
  });

  it('never prints 0.0.0.0 as a host', () => {
    expect(displayHost('0.0.0.0', ['192.168.1.42'])).toBe('192.168.1.42');
    expect(displayHost('0.0.0.0', [])).toBe('127.0.0.1');
    expect(displayHost('192.168.1.9', [])).toBe('192.168.1.9');
  });
});

describe('who counts as being on this network', () => {
  // This decides who is handed the URL token, so the boundary is worth pinning
  // down: everything inside is a machine in the building, everything outside
  // arrived through a router that should never have forwarded the port.
  it('accepts loopback, however it is spelled', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.1.1']) {
      expect(isPrivateAddress(address)).toBe(true);
    }
  });

  it('accepts every private IPv4 range, including through a dual-stack socket', () => {
    for (const address of [
      '10.0.0.7',
      '192.168.1.42',
      '172.16.4.1',
      '172.31.255.254',
      '169.254.1.1',
      '::ffff:192.168.1.42',
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
  });

  it('refuses a public address', () => {
    for (const address of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '203.0.113.9', '2001:db8::1']) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });

  it('refuses a missing or unparseable address', () => {
    for (const address of [undefined, '', 'not-an-address', '192.168.1']) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });
});
