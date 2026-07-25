import { describe, expect, it } from "vitest";
import {
  formatConnectionProtocolLabel,
  formatNetworkIdentifier,
  formatProtocolIdentifier,
  trafficIdentifierSearchValues,
} from "./traffic-presentation";

describe("Traffic identifier presentation", () => {
  it.each([
    ["tcp", "TCP"],
    ["TCP", "TCP"],
    ["udp", "UDP"],
    ["UDP", "UDP"],
  ])("formats known network identifier %s as %s", (raw, expected) => {
    expect(formatNetworkIdentifier(raw)).toBe(expected);
  });

  it.each([
    ["http", "HTTP"],
    ["HTTPS", "HTTPS"],
    ["socks4", "SOCKS4"],
    ["socks5", "SOCKS5"],
    ["Quic", "QUIC"],
    ["tls", "TLS"],
    ["Tun", "TUN"],
    ["tuic", "TUIC"],
    ["Redir", "REDIR"],
    ["TProxy", "TPROXY"],
  ])("formats known protocol identifier %s as %s", (raw, expected) => {
    expect(formatProtocolIdentifier(raw)).toBe(expected);
  });

  it("preserves unknown and user-provided identifiers without partial inference", () => {
    expect(formatNetworkIdentifier("custom Transport")).toBe("custom Transport");
    expect(formatProtocolIdentifier("https-like/custom")).toBe("https-like/custom");
    expect(formatProtocolIdentifier("私有协议")).toBe("私有协议");
  });

  it("formats the shared connection label without mutating raw DTO values", () => {
    const connection = { network: "tcp", protocol: "HTTPS" };

    expect(formatConnectionProtocolLabel(connection)).toBe("TCP · HTTPS");
    expect(connection).toEqual({ network: "tcp", protocol: "HTTPS" });
    expect(trafficIdentifierSearchValues(connection)).toEqual({
      network: ["tcp", "TCP"],
      protocol: ["HTTPS"],
    });
  });
});
