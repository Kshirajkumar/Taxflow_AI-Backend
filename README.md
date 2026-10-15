# Taxflow backend deployment repository

This folder is the standalone Node/Express backend for Taxflow. It is intentionally separate from `apps/desktop`, so it can be pushed to its own Git repository and deployed as a Render Web Service.

## Render settings

- Runtime: Node
- Build command: `npm ci`
- Start command: `npm start`
- Health check path: `/health`
- Root directory: repository root

`render.yaml` contains the non-secret defaults and declares the required secret environment variables. Add the real values in Render. Never commit `.env`, tokens, database URLs, or service-role keys.

## First deployment

After the service is deployed and its environment variables are present, open the Render Shell and run:

```sh
npm run migrate
```

Then verify `/health` returns `service: "taxflow-intake"`.

Configure the Telegram bot webhook to:

```text
https://YOUR-TAXFLOW-API.onrender.com/api/v1/integrations/telegram/webhook
```

The Telegram bot token and webhook secret must be the same values used by the bot configuration. The desktop app must use this service URL as `VITE_API_URL`.

## Local verification

```sh
npm ci
npm test
npm start
```

Do not run migrations against production until the database URL and target project have been verified.
