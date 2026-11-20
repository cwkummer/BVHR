/**
 * Typed HTTP/RPC client helpers for communicating with the Hono server worker.
 * Uses Hono's `hc<AppType>` client so request paths, JSON payloads, and response types
 * stay synchronized with the backend route definitions without duplicating schemas.
 */
import { hc, type InferResponseType } from "hono/client";
import type { AppType } from "../../../server/src/index";

export type { AppType };

/**
 * Creates a Hono RPC client targeting the same origin ("/").
 * When `authToken` is provided, attaches a `Bearer` Authorization header to every request
 * so session-authenticated endpoints (/api/me, /api/join, /api/ws-ticket) can verify identity.
 */
export function createApiClient(authToken?: string) {
  return hc<AppType>("/", {
    headers: (): Record<string, string> =>
      authToken ? { Authorization: `Bearer ${authToken}` } : {}
  });
}

/**
 * Unauthenticated RPC client instance used for public endpoints such as `/api/auth/google`.
 */
export const publicApiClient = createApiClient();

// Inferred 200 OK response types derived directly from the server route definitions.
export type GoogleAuthSuccess = InferResponseType<typeof publicApiClient.api.auth.google.$post, 200>;
export type JoinRoomSuccess = InferResponseType<typeof publicApiClient.api.join.$post, 200>;
export type WsTicketSuccess = InferResponseType<typeof publicApiClient.api["ws-ticket"]["$post"], 200>;

/**
 * Extracts a human-readable error message from a failed `fetch`/Hono `Response`.
 * Attempts to parse a JSON `{ error: string }` payload first, falling back to plain response
 * text or the caller-supplied `fallback` string if the body is empty or unreadable.
 */
export async function readApiError(res: Response, fallback: string): Promise<string> {
  const text = await res.text();
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error;
    }
  } catch {
    // Response body is not valid JSON; return raw text below.
  }
  return text;
}
