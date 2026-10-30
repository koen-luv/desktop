# Shared playlist worker

This Cloudflare Worker stores collaborative playlist copies and their member
lists in D1. It authenticates every request by validating the caller's Liner
access token against the primary API. Playlist creation reads the caller's
private source playlist through that API; invited editors can then edit the
shared copy independently of the source playlist.

## Deploy

1. Create a D1 database and set its name and ID in `wrangler.toml`.
2. Run `wrangler d1 migrations apply liner --remote`.
3. Deploy with `wrangler deploy`.
4. Set `VITE_SHARED_PLAYLISTS_URL` to the deployed Worker URL when building the
   app.

The source playlist is copied when shared; later edits to the original private
playlist do not automatically sync to that shared copy.
