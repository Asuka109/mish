import type { TrafficConnectionDto } from "@mish/contracts";

const canonicalNetworkIdentifiers: Readonly<Record<string, string>> = {
  tcp: "TCP",
  udp: "UDP",
};

const canonicalProtocolIdentifiers: Readonly<Record<string, string>> = {
  http: "HTTP",
  https: "HTTPS",
  quic: "QUIC",
  redir: "REDIR",
  socks4: "SOCKS4",
  socks5: "SOCKS5",
  tls: "TLS",
  tproxy: "TPROXY",
  tun: "TUN",
  tuic: "TUIC",
};

export function formatNetworkIdentifier(identifier: string) {
  return canonicalNetworkIdentifiers[identifier.toLocaleLowerCase()] ?? identifier;
}

export function formatProtocolIdentifier(identifier: string) {
  return canonicalProtocolIdentifiers[identifier.toLocaleLowerCase()] ?? identifier;
}

export function formatConnectionProtocolLabel(
  connection: Pick<TrafficConnectionDto, "network" | "protocol">,
) {
  return `${formatNetworkIdentifier(connection.network)} · ${formatProtocolIdentifier(connection.protocol)}`;
}

export function trafficIdentifierSearchValues(
  connection: Pick<TrafficConnectionDto, "network" | "protocol">,
) {
  return {
    network: uniqueValues(connection.network, formatNetworkIdentifier(connection.network)),
    protocol: uniqueValues(connection.protocol, formatProtocolIdentifier(connection.protocol)),
  };
}

function uniqueValues(raw: string, formatted: string) {
  return raw === formatted ? [raw] : [raw, formatted];
}
