# Bot Discord de Moderação e Atendimento

Bot em JavaScript para Discord com moderação, proteções anti-abuso, tickets privados e logs persistentes.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/discord-bot run dev` — connect the Discord bot
- `pnpm --filter @workspace/discord-bot test` — run bot unit tests
- `pnpm --filter @workspace/discord-bot run check` — syntax-check bot modules
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required secret: `DISCORD_BOT_TOKEN` — configured through Replit Secrets

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Bot: discord.js v14 with Node.js built-in SQLite

## Where things live

- `artifacts/discord-bot/src` — commands, bot events, ticket handling, moderation, security and SQLite storage
- `artifacts/discord-bot/README.md` — Discord Developer Portal, permissions, intents and command guide
- `artifacts/discord-bot/data/` — local runtime database (ignored by Git and deployment bundles)

## Architecture decisions

- Keep the bot as an independent background workflow so its Discord gateway connection does not block the shared API server.
- Store server-scoped settings, moderation cases and ticket lifecycle in SQLite; rate windows stay in memory and reset on process restart.
- DM sends target one explicitly chosen user at a time, with preview and confirmation, rather than an unsolicited bulk broadcast.

## Product

The bot provides configurable protection against raids, spam and unauthorized invites; persistent moderation cases; private support tickets; and per-server audit logs.

## User preferences

The bot interface, operational documentation and slash command descriptions are in Portuguese.

## Gotchas

- Enable Discord's Server Members and Message Content privileged intents in the Developer Portal before expecting entry and spam detections.
- Discord role hierarchy still applies even when the bot has the matching permission.
- Global slash-command registration may take time to propagate; `DISCORD_DEV_GUILD_ID` enables faster development-server registration.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
