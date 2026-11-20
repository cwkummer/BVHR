/**
 * Validation of required Worker secrets/config, kept free of runtime imports so it can be unit tested.
 */

/** HS256 needs a high-entropy key; anything shorter is realistically brute-forceable offline. */
export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Returns the JWT signing secret, throwing if it is missing or too short to be safe. Generate one with
 * e.g. `openssl rand -base64 48`.
 */
export function requireJwtSecret(env: { JWT_SECRET?: string }): string {
  const secret = env.JWT_SECRET?.trim();
  if (!secret || secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET is missing or shorter than ${MIN_JWT_SECRET_LENGTH} characters`);
  }
  return secret;
}

/**
 * Returns the Google OAuth client id that ID token audiences must match, throwing if it is missing.
 */
export function requireGoogleClientId(env: { GOOGLE_CLIENT_ID?: string }): string {
  const id = env.GOOGLE_CLIENT_ID?.trim();
  if (!id) throw new Error("GOOGLE_CLIENT_ID is missing");
  return id;
}
