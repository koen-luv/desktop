# Listen-party relay

Turns the listen-party invite into a six-digit code.

A WebRTC offer is 1–3 KB even compressed, so a six-digit code can never carry it.
This worker parks the offer and the guest's answer for **10 minutes** in one
Durable Object per room and hands out a six-digit key instead:

```
host  POST /rooms            { offer }   -> { code: "482913" }
guest GET  /rooms/:code                   -> { offer }
guest PUT  /rooms/:code/answer { answer }
host  GET  /rooms/:code/answer            -> { answer }
      DELETE /rooms/:code                 (freed on connect or leave)
```

Durable Objects (not KV) because the host polls immediately after the guest
writes: reads are strongly consistent and the room deletes itself from an alarm
when it expires.

## Deploy

Currently deployed at **https://liner-party.lucabatarcian.workers.dev** and wired
in as the `VITE_PARTY_RELAY_URL` repository variable, so release builds pick it
up automatically.

```bash
cd party-worker
npx wrangler login          # once
npx wrangler deploy         # prints https://liner-party.<you>.workers.dev
```

No secrets or bindings to create — the Durable Object namespace comes from
`wrangler.toml`. A free Cloudflare plan covers this comfortably (a party costs a
handful of requests).

## Point the app at it

```bash
VITE_PARTY_RELAY_URL=https://liner-party.<you>.workers.dev
```

Set it in `.env.local` for local builds and as a repository **variable**
(`VITE_PARTY_RELAY_URL`) so the release workflow bakes it into the desktop,
Android and iOS builds. Leave it unset and the app keeps the original manual
invite/answer code exchange — nothing breaks, the UI just stays as it was.

## Notes

- Anyone with the six-digit code can fetch the waiting offer for ten minutes;
  the offer only reveals ICE candidates, and the room disappears on connection.
- `POST /rooms` body limit is 16 KB, which is far above a compressed offer.
- Requests are not rate limited. If the endpoint is abused, add a Cloudflare
  rate-limiting rule for `POST /rooms`.
