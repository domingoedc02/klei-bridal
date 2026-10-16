import { z } from "zod";

/** `POST /e/:token/channel` body (spec/api). Matches the enquiries_chat_channel_check constraint. */
export const CHAT_CHANNELS = ["messenger", "whatsapp", "viber"] as const;

export const chatChannelSchema = z.object({ channel: z.enum(CHAT_CHANNELS) }).strict();

export type ChatChannel = (typeof CHAT_CHANNELS)[number];
