import { createV2OpencodeClient } from "./v2/client.js";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { config } from "../config.js";

const getAuth = () => {
  if (!config.opencode.password) {
    return undefined;
  }
  const credentials = `${config.opencode.username}:${config.opencode.password}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
};

const createClient =
  config.opencode.serverVersion === "v2" ? createV2OpencodeClient : createOpencodeClient;

const auth = getAuth();

export const opencodeClient = createClient({
  baseUrl: config.opencode.apiUrl,
  headers: auth ? { Authorization: auth } : undefined,
});
