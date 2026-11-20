# Integration tests

These tests drive a **real** Worker, `GameRoom` Durable Object and local D1 over HTTP and WebSockets, the
same way the browser client does. Each test file boots its own `wrangler dev` against a throwaway database
(`support/server.ts`), so it starts from an empty room, never touches your `.wrangler` dev state, and needs
no network access, secrets or Google account (session tokens are signed with a test secret).

```
bun run test:integration                                   # everything (about 3 minutes)
cd apps/server && bun test ./integration/capacity.integration.test.ts --timeout 120000   # one file
```

These also run in CI (`.github/workflows/ci.yml`) on every push, in parallel with typecheck and the unit tests, and
`bun run deploy:prod` runs them before it migrates or deploys anything.

| File | Covers |
|---|---|
| `matchmaking` | auth failures, fill-first shards, roster/join/leave messages, shard isolation, reconnecting to the same room, second-tab takeover, forged identity header |
| `battle` | zone encounters and who leads, fresh D1 stats in combat, turn rules, HEAL/FLEE, exactly-once rewards, rematch rules |
| `stats-failure` | invalid D1 data: no battle, one notice per player, automatic recovery, refused joins |
| `timeouts` | AFK auto-attack, forfeit after two missed turns, rewards for the other player, resuming a battle after a drop |
| `rate-limit` | sign-in, join and reconnect-ticket limits: 429 with `Retry-After`, per-client and per-user buckets |
| `reward-outage` | D1 down when a battle ends: players still told, reward retried with backoff, credited exactly once after recovery, survives its players leaving |
| `capacity` | rollover at the soft cap (40), reconnects and new joins at the hard cap (50), `409`/`503` responses |

`support/client.ts` has a small scripted `GameClient` (join, walk into a building, autoplay turns, wait for a
message) that new tests can reuse.

The D1 outage in `reward-outage` is simulated by renaming the `reward_claims` table in the Worker's local database
(the local D1 cannot be made to fail otherwise). Not covered: a real D1 outage on Cloudflare and real Google sign-in.

Note: Bun's WebSocket client reports a server-initiated close only after about 10 seconds (Chromium: about
2 seconds), so close-code assertions wait longer than a browser would.
