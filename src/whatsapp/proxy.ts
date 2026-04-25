import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { Agent } from "node:http";
import { config } from "../config.js";
import { logger } from "../logger.js";

/*
  Build a Node http.Agent for the configured PROXY_URL, picking the right
  implementation based on the URL scheme:

    socks://       → SocksProxyAgent (defaults to SOCKS5)
    socks5://      → SocksProxyAgent
    socks4://      → SocksProxyAgent (lib supports v4 if scheme says so)
    http://        → HttpsProxyAgent
    https://       → HttpsProxyAgent

  Returns null if no proxy is configured. Cached so we reuse one connection
  pool across the WS + media-fetch agents.
*/

let _agent: Agent | null = null;

export function proxyAgent(): Agent | null {
  if (_agent) return _agent;
  if (!config.PROXY_URL) return null;

  const url = config.PROXY_URL;
  const scheme = url.split(":")[0]?.toLowerCase() ?? "";

  if (scheme.startsWith("socks")) {
    _agent = new SocksProxyAgent(url) as unknown as Agent;
    logger.info({ scheme }, "WhatsApp proxy enabled (SOCKS)");
  } else if (scheme === "http" || scheme === "https") {
    _agent = new HttpsProxyAgent(url) as unknown as Agent;
    logger.info({ scheme }, "WhatsApp proxy enabled (HTTP)");
  } else {
    logger.warn({ scheme }, "Unknown PROXY_URL scheme — ignoring proxy");
    return null;
  }

  return _agent;
}
