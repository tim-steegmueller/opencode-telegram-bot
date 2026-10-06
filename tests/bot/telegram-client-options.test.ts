import { Agent as HttpsAgent } from "https";
import { describe, expect, it, vi } from "vitest";
import { createTelegramBotOptions } from "../../src/bot/telegram-client-options.js";
import { logger } from "../../src/utils/logger.js";

function makeTelegramConfig(overrides: Partial<Parameters<typeof createTelegramBotOptions>[0]> = {}) {
  return {
    apiRoot: "",
    proxySecret: "",
    proxyUrl: "",
    forceIpv4: false,
    ...overrides,
  };
}

describe("createTelegramBotOptions", () => {
  it.each([
    {
      apiRoot: "https://synthetic-user:synthetic-password@synthetic-api.example.com",
      proxyUrl: "",
    },
    {
      apiRoot:
        "https://synthetic-api.example.com/synthetic-private-path?key=synthetic-query#synthetic-fragment",
      proxyUrl: "",
    },
    {
      apiRoot: "",
      proxyUrl:
        "https://synthetic-user:synthetic-password@synthetic-proxy.example.com:8443/synthetic-private-path?key=synthetic-query#synthetic-fragment",
    },
    {
      apiRoot: "",
      proxyUrl:
        "socks5://synthetic-user:synthetic-password@synthetic-proxy.example.com:1080/synthetic-private-path?key=synthetic-query#synthetic-fragment",
    },
  ])("does not log private endpoint URL components: $apiRoot $proxyUrl", (endpoint) => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const options = createTelegramBotOptions(makeTelegramConfig(endpoint));

    expect(info).toHaveBeenCalled();
    expect(JSON.stringify(info.mock.calls)).not.toContain("synthetic-");
    if (endpoint.apiRoot) expect(options.client?.apiRoot).toBe(endpoint.apiRoot);
    else expect(options.client?.baseFetchConfig?.agent).toBeDefined();
  });

  it("does not configure an agent for direct Telegram API requests by default", () => {
    const options = createTelegramBotOptions(makeTelegramConfig());

    expect(options.client).toBeUndefined();
  });

  it("configures an IPv4 HTTPS agent for direct Telegram API requests when enabled", () => {
    const options = createTelegramBotOptions(makeTelegramConfig({ forceIpv4: true }));
    const agent = options.client?.baseFetchConfig?.agent;

    expect(agent).toBeInstanceOf(HttpsAgent);
    expect((agent as HttpsAgent).options.family).toBe(4);
    expect(options.client?.baseFetchConfig?.compress).toBe(true);
  });

  it("keeps reverse-proxy options when IPv4 mode is enabled", () => {
    const options = createTelegramBotOptions(
      makeTelegramConfig({
        apiRoot: "https://tg-proxy.example.com",
        proxySecret: "secret-abc",
        forceIpv4: true,
      }),
    );

    expect(options.client?.apiRoot).toBe("https://tg-proxy.example.com");
    expect(options.client?.fetch).toBeTypeOf("function");
    expect(options.client?.baseFetchConfig?.agent).toBeInstanceOf(HttpsAgent);
  });

  it("keeps forward proxy wiring when IPv4 mode is also enabled", () => {
    const options = createTelegramBotOptions(
      makeTelegramConfig({
        proxyUrl: "https://proxy.example.com:8443",
        forceIpv4: true,
      }),
    );

    expect(options.client?.baseFetchConfig?.agent).not.toBeInstanceOf(HttpsAgent);
    expect(options.client?.baseFetchConfig?.compress).toBe(true);
  });
});
