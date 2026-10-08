import Redis from "iovalkey";
import { env } from "../../config/env";
import { createValkeyStore, valkeyOptions, type RateLimitStore } from "./store";

let store: RateLimitStore | undefined;

/** The process-wide Valkey-backed store, connected on first use. */
export function getRateLimitStore(): RateLimitStore {
  if (!store) {
    const client = new Redis(env.REDIS_URL, valkeyOptions);
    // Without a listener iovalkey prints "Unhandled error event" per reconnect.
    client.on("error", (error: Error) => console.error("valkey:", error.message));
    store = createValkeyStore(client);
  }
  return store;
}
