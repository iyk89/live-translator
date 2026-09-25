import dns from "node:dns";
import net from "node:net";
import ipaddr from "ipaddr.js";

/**
 * Outbound address policy for link import. Only globally routable unicast
 * addresses are allowed; loopback, private, link-local (including cloud
 * metadata at 169.254.169.254), carrier-grade NAT, unique-local, multicast,
 * reserved, and IPv4-embedding IPv6 ranges are rejected.
 */
export function isPublicAddress(address: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return false;
  }
  if (parsed.kind() === "ipv6") {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) return isPublicAddress(v6.toIPv4Address().toString());
  }
  return parsed.range() === "unicast";
}

export class BlockedDestinationError extends Error {
  readonly code = "EBLOCKEDDESTINATION";
  constructor(hostname: string) {
    super(`Destination ${hostname} is not a public address`);
    this.name = "BlockedDestinationError";
  }
}

type LookupAddress = { address: string; family: number };
type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
type Resolver = (hostname: string, options: dns.LookupAllOptions, callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

const defaultResolver: Resolver = (hostname, options, callback) => dns.lookup(hostname, options, callback);

/**
 * A `lookup` for http(s).request that resolves once, validates every address,
 * and hands exactly those addresses to the socket. Because validation and
 * connection use the same answer, a DNS rebinding flip between "check" and
 * "connect" is not possible.
 */
export function createPinnedLookup(
  allowAddress: (address: string) => boolean = isPublicAddress,
  resolver: Resolver = defaultResolver,
) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    resolver(hostname, { family: options.family ?? 0, hints: options.hints, all: true, verbatim: true }, (err, addresses) => {
      if (err) {
        callback(err, "", 0);
        return;
      }
      const list = Array.isArray(addresses) ? addresses : [];
      if (list.length === 0 || list.some((entry) => !allowAddress(entry.address))) {
        callback(new BlockedDestinationError(hostname) as unknown as NodeJS.ErrnoException, "", 0);
        return;
      }
      if (options.all) callback(null, list);
      else callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

/** Strips IPv6 brackets from URL.hostname. */
export function bareHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function isIpLiteral(hostname: string): boolean {
  return net.isIP(bareHostname(hostname)) !== 0;
}
