# Slack app manifest

`manifest.template.yml` is the canonical source of truth for the Sym Slack app —
scopes, events, display info, and feature flags.

## Rendering

The template uses `${SLACK_PUBLIC_BASE_URL}` for the public HTTPS base
(redirect URL + events endpoint). Render it with:

```sh
SLACK_PUBLIC_BASE_URL=https://snowdrop-....ngrok-free.dev pnpm manifest:render
# writes slack/manifest.yml
```

`slack/manifest.yml` is git-ignored. Copy the rendered output into the
[Slack app config](https://api.slack.com/apps) → _App Manifest_ tab, or use
the Slack CLI:

```sh
slack manifest update --app <APP_ID> --manifest slack/manifest.yml
```

## Dev workflow

In dev, `SLACK_PUBLIC_BASE_URL` is the ngrok tunnel URL from your `.env`. In
prod, it's the public service URL (set in your Dokploy environment).
