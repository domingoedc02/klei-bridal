import Redis from "iovalkey";
import { env } from "../../config/env";
import { logger } from "../observability/logger";
import { createValkeyStore, valkeyOptions, type RateLimitStore } from "./store";

let store: RateLimitStore | undefined;
let client: Redis | undefined;

/** The process-wide Valkey client, connected on first use. */
export function getValkeyClient(): Redis {
  if (!client) {
    client = new Redis(env.REDIS_URL, valkeyOptions);
    // Without a listener iovalkey prints "Unhandled error event" per reconnect.
    client.on("error", (error: Error) => logger.error({ err: error }, "valkey_error"));
  }
  return client;
}

/** The process-wide Valkey-backed store, connected on first use. */
export function getRateLimitStore(): RateLimitStore {
  if (!store) store = createValkeyStore(getValkeyClient());
  return store;
}
