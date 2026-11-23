// Kept free of imports so bridge-secrets.mjs can run before anything else.
export const VAPID_ENV = "CONDUIT_VAPID_PRIVATE_KEY";

/** Read the VAPID private key once and remove it from the environment. */
export function takeVapidKeyFromEnv(env = process.env) {
  const v = env[VAPID_ENV];
  delete env[VAPID_ENV];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
