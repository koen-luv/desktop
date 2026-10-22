# Discord presence from the cloud

The desktop app (and the Android/iOS builds, when a Discord desktop client is
reachable) talks to Discord's **local** RPC endpoint. That endpoint only exists
next to a running Discord desktop client, so a phone can never reach it: the
Kotlin/Swift clients can probe `127.0.0.1:6463-6472` forever and find nothing.

Presence from a phone therefore has to be published by something that owns a
Discord connection. This is the same model PreMiD's hosted service uses: the
app reports playback to Liner's backend, and the backend keeps the activity up
to date through the [Discord Social SDK](https://docs.discord.com/developers/discord-social-sdk).

The client half is implemented in `src/features/discord/cloud.ts` and
`src/features/discord/store/discordCloudStore.ts`; this document is the
contract the backend has to implement.

## Linking flow

No client secret and no custom URL scheme is needed, which keeps the flow
identical on desktop, Android and iOS.

1. The app calls `POST /v1/me/discord/link` and receives a one-time browser URL
   plus a poll handle.
2. The app opens that URL in the system browser.
3. The backend runs the Discord OAuth2 authorization-code exchange on its
   registered redirect URI, stores the tokens for the Liner account, and marks
   the session as linked.
4. The app polls `GET /v1/me/discord/link/{id}` until `linked`, `expired` or
   `error`, then starts reporting playback.

Unlinking (`DELETE /v1/me/discord`) clears the stored tokens, revokes them with
Discord and removes the activity.

## Endpoints

All endpoints require the normal Liner bearer token and return JSON.

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| `GET` | `/v1/me/discord` | — | `{ "linked": boolean, "username"?: string }` |
| `POST` | `/v1/me/discord/link` | — | `{ "id": string, "url": string, "expiresInMs"?: number }` |
| `GET` | `/v1/me/discord/link/{id}` | — | `{ "status": "pending" \| "linked" \| "expired" \| "error", "username"?: string, "message"?: string }` |
| `DELETE` | `/v1/me/discord` | — | `204` |
| `POST` | `/v1/me/discord/presence` | `DiscordPresenceNotification` | `204` |

`404` and `501` from any of them make the client treat cloud presence as
unavailable for that server and hide the account controls, so the endpoints can
be rolled out gradually.

### `DiscordPresenceNotification`

Exactly the payload the desktop client builds (`src/shared/contracts/discord.ts`):

```json
{
  "status": "playing",
  "track": {
    "id": "dQw4w9WgXcQ",
    "title": "Track title",
    "artist": "Artist",
    "artistId": "UC…",
    "album": "Album",
    "coverUrl": "https://…",
    "durationMs": 213000
  },
  "positionMs": 42000,
  "durationMs": 213000,
  "artistImageUrl": "https://…",
  "settings": {
    "enabled": true,
    "statusDisplayType": "artist",
    "showArtwork": true,
    "showArtistSmallImage": true,
    "showTime": true,
    "showPaused": true,
    "showButton": true,
    "showDownloadButton": true
  }
}
```

The client already rate limits itself (one update per 4 s, only on track,
status, seek, artwork or setting changes, `status: "idle"` + `track: null` to
clear). The backend should still tolerate repeats and out-of-order pushes.

## Backend responsibilities

- Enable the Social SDK for the Liner Discord application in the Developer
  Portal and ask for `identify` (and the default presence scopes,
  `sdk.social_layer_presence`) in the OAuth request.
- Build `SET_ACTIVITY` from the notification exactly like `electron/discord.ts`
  does locally: `statusDisplayType` picks the header (artist / title / both /
  app name), `showArtwork` and `showArtistSmallImage` gate the assets,
  `showTime` adds the start/end timestamps from `positionMs`/`durationMs`,
  `showPaused` clears the presence when paused, and the two buttons use
  `https://link.tryliner.fun/track?id=…` and `https://tryliner.fun`.
- Drop the activity when the user unlinks, when the token stops working, or
  after a few minutes without a heartbeat-free update from an app that was
  killed during playback.
- Keep refresh tokens encrypted at rest; never ship the client secret in the
  app.
