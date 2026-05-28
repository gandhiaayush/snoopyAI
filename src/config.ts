import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const optionalNonEmptyString = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.string().min(1).optional()
);

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.string().default("development"),

  TWILIO_ACCOUNT_SID: z.string().min(1),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_PHONE_NUMBER: z.string().min(1),
  TWILIO_WEBHOOK_BASE: z.string().url().transform((url) => url.replace(/\/+$/, "")),

  GEMINI_API_KEY: optionalNonEmptyString,
  ANTHROPIC_API_KEY: optionalNonEmptyString,
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_REALTIME_MODEL: z.string().default("gpt-realtime-2"),
  OPENAI_REALTIME_VOICE: z.string().default("marin"),
  OPENAI_REALTIME_MAX_OUTPUT_TOKENS: z.preprocess(
    (value) => (value === "" || value === undefined ? undefined : value),
    z.coerce.number().optional()
  ),
  OPENAI_REALTIME_VAD_SILENCE_MS: z.coerce.number().default(450),

  NOTION_API_KEY: z.string().min(1),
  ORDERS_DATA_SOURCE_ID: z.string().min(1),
  PRICING_DATA_SOURCE_ID: z.string().min(1),
  CALLBACKS_DATABASE_ID: z.string().min(1),
  CALLBACKS_DATA_SOURCE_ID: z.string().min(1),
  ARCHIVE_DATA_SOURCE_ID: z.string().min(1),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  OWNER_PHONE_NUMBER: z.string().min(1),
  OWNER_NAME: z.string().default("Business Owner"),

  MAX_TURNS_PER_CALL: z.coerce.number().default(15),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Missing or invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

if (
  parsed.data.NODE_ENV === "production" &&
  !parsed.data.TWILIO_WEBHOOK_BASE.startsWith("https://")
) {
  console.error("Invalid production configuration:");
  console.error({
    TWILIO_WEBHOOK_BASE: ["Must start with https:// when NODE_ENV=production"],
  });
  process.exit(1);
}

export const config = parsed.data;
