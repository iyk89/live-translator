import { describe, expect, it } from "vitest";
import { createPinnedLookup, isPublicAddress } from "./network-policy";

describe("outbound address policy", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.8.9.10", "loopback range"],
    ["0.0.0.0", "unspecified"],
    ["10.1.2.3", "private"],
    ["172.16.0.5", "private"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "cloud metadata (link-local)"],
    ["100.100.100.200", "carrier-grade NAT (Alibaba metadata)"],
    ["192.0.0.192", "IETF reserved (Oracle metadata)"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["198.18.0.1", "benchmarking"],
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fe80::1", "IPv6 link-local"],
    ["fc00::1", "IPv6 unique local"],
    ["fd00:ec2::254", "AWS IPv6 metadata"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:10.0.0.1", "IPv4-mapped private"],
    ["64:ff9b::a00:1", "NAT64 of a private address"],
    ["2002:0a00:0001::1", "6to4 of a private address"],
    ["not-an-ip", "garbage"],
  ])("blocks %s (%s)", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["151.101.3.42", "8.8.8.8", "2606:4700:4700::1111", "::ffff:151.101.3.42"])("allows public %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("pinned DNS lookup", () => {
  const lookupWith = (answers: Array<Array<{ address: string; family: number }>>) => {
    let call = 0;
    return createPinnedLookup(isPublicAddress, (_host, _options, callback) => callback(null, answers[Math.min(call++, answers.length - 1)]!));
  };
  const run = (lookup: ReturnType<typeof createPinnedLookup>, all: boolean) =>
    new Promise<{ error: Error | null; address: unknown }>((resolve) =>
      lookup("papers.example", { all }, (error, address) => resolve({ error, address })),
    );

  it("returns validated public addresses to the socket", async () => {
    const lookup = lookupWith([[{ address: "151.101.3.42", family: 4 }]]);
    expect(await run(lookup, false)).toEqual({ error: null, address: "151.101.3.42" });
    expect(await run(lookup, true)).toEqual({ error: null, address: [{ address: "151.101.3.42", family: 4 }] });
  });

  it("rejects the whole answer if any address is private", async () => {
    const lookup = lookupWith([[{ address: "151.101.3.42", family: 4 }, { address: "10.0.0.8", family: 4 }]]);
    const result = await run(lookup, true);
    expect(result.error?.name).toBe("BlockedDestinationError");
  });

  it("re-validates every resolution, so a rebinding answer is refused", async () => {
    const lookup = lookupWith([[{ address: "151.101.3.42", family: 4 }], [{ address: "127.0.0.1", family: 4 }]]);
    expect((await run(lookup, false)).error).toBeNull();
    expect((await run(lookup, false)).error?.name).toBe("BlockedDestinationError");
  });
});
