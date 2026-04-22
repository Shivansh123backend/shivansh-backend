# Shivansh — AI Calling SaaS Platform

## Overview

Production-grade AI-powered calling SaaS platform. Includes a complete Node.js/Express backend with JWT auth, RBAC, PostgreSQL database, multi-provider telephony (VoIP/Telnyx/Twilio), BullMQ job queue, WebSocket monitoring, and a React admin dashboard built with a dark terminal aesthetic.

## Admin Dashboard

- **Login**: `admin@example.com` / `Admin@12345`
- **Theme**: Deep space dark + electric cyan (#00FFFF) — terminal/command-center aesthetic
- **Pages**: Dashboard (live stats), Campaigns (start/stop), AI Agents, Leads (filtered), Call Records (CDR with transcripts), Phone Numbers, Team (users)
- **Auth**: JWT stored in localStorage; shared React context for logout propagation
- **Stack**: React + Vite + Wouter + TanStack Query + shadcn/ui + Tailwind CSS
- **Location**: `artifacts/dashboard/`

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod
- **Queue**: BullMQ (requires Redis)
- **Real-time**: Socket.IO (WebSocket)
- **Auth**: JWT + bcrypt
- **Build**: esbuild (CJS bundle)

## Architecture

```
artifacts/api-server/src/
├── config/             # Central configuration (JWT, Redis, queue settings)
├── lib/
│   ├── jwt.ts          # Token sign/verify
│   ├── audit.ts        # Audit log writer
│   ├── errors.ts       # Global error handler, AppError class
│   ├── redis.ts        # ioredis singleton
│   └── logger.ts       # pino structured logging
├── middlewares/
│   └── auth.ts         # JWT authenticate + requireRole RBAC
├── providers/
│   ├── base.ts         # CallProvider abstract class (call/transfer/hangup)
│   ├── voip.ts         # VoIP provider (primary)
│   ├── telnyx.ts       # Telnyx provider (backup)
│   ├── twilio.ts       # Twilio provider (optional)
│   └── registry.ts     # Provider lookup + fallback chain
├── queue/
│   └── callQueue.ts    # BullMQ queue, enqueueCall, worker management
├── services/
│   ├── selectionService.ts   # Voice + number + provider selection logic
│   └── routingService.ts     # Human agent round-robin routing
├── websocket/
│   └── index.ts        # Socket.IO init, room management, emit helpers
├── scripts/
│   └── seedAdmin.ts    # Seed admin user
└── routes/
    ├── auth.ts          # POST /auth/login
    ├── users.ts         # POST /users/create, GET /users
    ├── agents.ts        # AI agent CRUD + voice assignment
    ├── voices.ts        # Voice CRUD
    ├── campaigns.ts     # Campaign CRUD, start/stop, agent assignment
    ├── numbers.ts       # Phone number management
    ├── leads.ts         # Lead upload (CSV + JSON)
    ├── calls.ts         # Call initiate, transfer, inbound routing, status update
    └── agentStatus.ts   # Agent status update, supervisor live monitoring
```

## Database Schema (lib/db/src/schema/)

| Table | Purpose |
|---|---|
| `users` | All users (admin, supervisor, agent) with role + status |
| `ai_agents` | AI voice bot configurations (prompt, language, voice) |
| `voices` | Voice definitions (ElevenLabs, PlayHT, Azure) |
| `agent_voices` | Many-to-many: AI agent → voices with priority |
| `campaigns` | Campaign config (type, routing, concurrency limit) |
| `campaign_agents` | Many-to-many: campaign → human agents |
| `phone_numbers` | DIDs with provider, campaign assignment, priority |
| `leads` | Contact records with campaign + call status |
| `calls` | Full CDR: status, disposition, transcript, recording URL |
| `audit_logs` | Action trail for admin/security audit |

## API Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /api/auth/login | Public | JWT login |
| POST | /api/users/create | Admin | Create user (max 25 agents enforced) |
| GET | /api/users | Admin/Supervisor | List users |
| POST | /api/agents/create | Admin | Create AI agent |
| GET | /api/agents | Auth | List AI agents |
| POST | /api/agents/:id/voices | Admin | Assign voice to agent |
| GET | /api/agents/:id/voices | Auth | Get agent voices |
| POST | /api/voices/create | Admin | Create voice |
| GET | /api/voices | Auth | List voices |
| POST | /api/campaigns/create | Admin | Create campaign |
| POST | /api/campaigns/start/:id | Admin | Start campaign |
| POST | /api/campaigns/stop/:id | Admin | Stop campaign |
| GET | /api/campaigns | Auth | List campaigns |
| POST | /api/campaigns/:id/agents | Admin | Assign human agent to campaign |
| GET | /api/campaigns/:id/agents | Auth | List campaign agents |
| POST | /api/numbers/add | Admin | Add phone number |
| GET | /api/numbers | Auth | List numbers |
| PATCH | /api/numbers/:id | Admin | Update number |
| POST | /api/leads/upload | Admin | Upload leads (CSV or JSON) |
| GET | /api/leads | Auth | List leads |
| POST | /api/calls/initiate | Admin | Initiate outbound call (enqueues job) |
| GET | /api/calls | Auth | List calls (CDR) |
| GET | /api/calls/:id | Auth | Get single call |
| PATCH | /api/calls/:id | Auth | Update call (used by VPS workers) |
| POST | /api/calls/transfer | Auth | Transfer call to human agent |
| POST | /api/calls/inbound | Auth | Handle inbound call routing |
| POST | /api/agent/status | Agent/Admin | Update agent status |
| GET | /api/supervisor/live-calls | Admin/Supervisor | Live call monitoring |
| GET | /api/agent/available | Admin/Supervisor | Available agents |

## WebSocket Events

Connect to `/api/ws` with `auth: { token: "<JWT>" }`.

| Event | Direction | Description |
|---|---|---|
| `agent:incoming_call` | Server → Agent | Incoming call/transfer notification |
| `call:started` | Server → Supervisors | Call went live |
| `call:ended` | Server → Supervisors | Call completed |
| `call:queued` | Server → Supervisors | Call job added to queue |
| `call:transferred` | Server → Supervisors | Call transferred to human |
| `call:inbound` | Server → Supervisors | Inbound call received |
| `agent:status_update` | Server → Supervisors | Agent status changed |
| `campaign:started` | Server → Supervisors | Campaign activated |
| `campaign:stopped` | Server → Supervisors | Campaign paused |

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/db run push` — push DB schema changes
- `pnpm --filter @workspace/api-server run dev` — run API server

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | Yes | Server port (auto-assigned by Replit) |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | JWT signing secret |
| `REDIS_HOST` | No | Redis host (enables BullMQ queue) |
| `REDIS_PORT` | No | Redis port (default: 6379) |
| `REDIS_PASSWORD` | No | Redis password |
| `ADMIN_EMAIL` | No | Seed admin email (default: admin@example.com) |
| `ADMIN_PASSWORD` | No | Seed admin password |

## Queue System (BullMQ)

Queue name: `calls`. Each job includes: `leadId`, `campaignId`, `phone`, `selectedVoice`, `selectedNumber`, `provider`, `agentId`, `callId`. Retry: 3 attempts with exponential backoff. Enable by setting `REDIS_HOST`.

## Provider Abstraction

All providers extend `CallProvider` (call/transfer/hangup). Registry provides `callWithFallback()` — tries voip → telnyx → twilio in order, logging each failure.

## User Roles

- `admin` — full access
- `supervisor` — read/monitoring only
- `agent` — can update own status, receive incoming call notifications

## ElevenLabs ConvAI Bridge — Key Notes

- **Transfer detection**: fires on `agent_response` text (4s delay) OR `transcript` caller phrases (3s delay); `pendingTransfer` flag prevents double-fire
- **Transfer bug fix (2026-04-14)**: `conversation_ended` / `end_call` ElevenLabs events no longer call `onCallEnded` (which hangs up) when `pendingTransfer = true`. Previously the WS close triggered a hangup, killing the transferred call.
- **AI pacing fix (2026-04-14)**: Added `─── PACING REMINDER ───` block at the very END of every system prompt so it's the last thing the model reads before each generation — prevents the AI from speeding up mid-conversation.
- **Hold music**: served via `/api/audio/hold/:preset` proxy; returns streamed MP3 to Telnyx transfer `audio_url`.
- **Auth token key**: `localStorage.getItem("auth_token")` — NOT "token"
- **Audio cache**: `voiceRegistry.ts` → `audioCache`; token URL `GET /api/audio/:token` (no auth, CORS `*`)

## Production Deployment (2026-04-20)

Deployed to 2-VPS Hostinger setup (Ubuntu 22.04, Node 20 LTS, PM2):

| Role | Host | Health URL |
|---|---|---|
| Primary | 72.62.211.160 | http://72.62.211.160:8080/api/health |
| Secondary | 72.62.212.7 | http://72.62.212.7:8080/api/health |

- App dir: `/opt/shivansh` (owner `shivansh:shivansh`); env at `/opt/shivansh/deploy/.env` (chmod 600)
- PM2 procs per VPS: `shivansh-api` + `shivansh-worker`. VPS 2 also runs `shivansh-failover` (polls primary every 30s; promotes worker after 3 failures)
- Reboot persistence: systemd unit `pm2-shivansh.service` patched with `EnvironmentFile=/opt/shivansh/deploy/.env`
- Source: `https://github.com/Shivansh123backend/shivansh-backend.git` (private; deploy key on each repo)
- SSH from Replit: `ssh -i ~/.ssh/vps_deploy root@<host>`
- Update flow: `bash deploy/deploy.sh` (git push → ssh both VPS → `git pull` → `pnpm install` → `pnpm build` → `pm2 reload all` → health check)
- **Production database**: Supabase (`db.axebkssjglrdpdbddotj.supabase.co`, US-East, 1GB Micro). Replit's internal `helium` Postgres is not externally reachable; do NOT reuse the Replit DATABASE_URL on the VPS.
- **Public HTTPS endpoint**: `https://api.shivanshagent.cloudisoft.com` → VPS 1 (72.62.211.160). Namecheap A record + nginx reverse proxy on port 443 → API on `localhost:8080`. Let's Encrypt cert auto-renews via certbot.timer (current cert expires 2026-07-19).
- `WEBHOOK_BASE_URL` and `PUBLIC_BASE_URL` in `/opt/shivansh/deploy/.env` on both VPS = `https://api.shivanshagent.cloudisoft.com`. Update Telnyx webhook URL to `https://api.shivanshagent.cloudisoft.com/api/webhooks/telnyx` so callbacks land on VPS 1 instead of Replit.
- **Important**: `deploy/ecosystem.config.cjs` parses the `.env` file at config-load time (instead of relying on PM2's unreliable `env_file` directive) and merges into `env:`. This ensures all env vars actually reach the API child process. Restart pm2 cleanly with `pm2 delete all && pm2 start ecosystem.config.cjs --only shivansh-api && pm2 save` after env changes.
- Lovable frontend stays at `shivanshagent.cloudisoft.com` and calls the API at `api.shivanshagent.cloudisoft.com`. CORS is currently `*` (open).
- **Worker process intentionally removed** from PM2 (no `worker` script in api-server package.json — schedulers run inside the api process). Re-add when a real worker entrypoint exists + Redis is provisioned.
- Optional env not yet set: `TELNYX_PUBLIC_KEY` (webhook signature verify), `CARTESIA_VOICE_ID`, `REDIS_*`, `RESEND_API_KEY`/`SENDGRID_API_KEY`

## Greeting Dead-Air Bug Fix (2026-04-21)

Caller experience: AI greeted, caller said "Hello" overlapping the greeting → 7s of dead air → AI re-greeted. Root cause was a feedback loop in `routes/webhooks.ts`:
1. Buffered "Hello" replayed correctly when greeting ended → LLM started generating
2. LLM took ~3s → caller said "Yes" filling silence → "Yes" aborted in-flight LLM and restarted (another 3s) → 7s total silence

**Fix 1**: Narrow `PICKUP_GREETINGS_ONLY` set (hello/hi/hey/yo/hiya only — NOT yes/ok) discarded as a no-op when it's the caller's first turn, since our greeting already opened the conversation. "Yes"/"ok" deliberately excluded so they remain valid answers to "Am I speaking with <name>?".

**Fix 2**: In `handleCallerTurn` buffering branch, do NOT abort an in-flight LLM if the new caller text is a short filler (`yes/ok/uh-huh/hello/...` or <4 chars) — let the original reply finish instead of restarting from scratch.

## VICIdial Feature Gaps Closed (2026-04-21)

All 6 gaps now live in production at `https://api.shivanshagent.cloudisoft.com`:

1. **TCPA per-lead timezone scrubbing** — `routes/campaigns.ts` `getLeadTimezone()` (NPA→IANA tz map for all 50 US states) + `isTcpaCallable()` enforces 8am–9pm in lead's local time. **Fail-closed** for unknown US area codes (better to skip than risk a 3am call). Enforced inside `processLead` when `campaign.tcpaEnabled = true`.
2. **Voicemail drop** — `campaigns.vmDropMessage` text column. `routes/webhooks.ts` AMD `machine_end_beep` handler plays the campaign's TTS message (or a default), then hangs up via `pendingVmDropHangup` on `playback.ended`.
3. **Scheduled callbacks** — `leads.callbackAt` timestamp + `POST /api/callbacks/schedule` + `startCallbackScheduler()` (60s poll, atomic claim via `UPDATE…RETURNING`). Failed enqueue / paused campaign → 5-minute backoff, never re-arms to `now` (avoids hot-loop).
4. **Conference 3-way** — `POST /api/calls/:callControlId/conference { to }` (admin-only). Telnyx dials third party with `client_state` encoding `conference_bridge`; webhook on `call.answered` issues a `bridge` to link the legs. Toll-fraud guards: blocked premium-rate prefixes (`+1900/+1976/+881-3/+979/+808`) + ownership check (caller must be a known active call in our DB).
5. **Per-agent stats** — `GET /api/agents/stats` returns `{ id, name, status, current_call, stats: { callsToday, avgDuration, dispositions } }`. Single grouped query (no N+1).
6. **Agent softphone (Lovable)** — Prompt at `.local/lovable-prompt-agent-softphone.md`. Browser-based softphone using `@telnyx/webrtc`, JWT from `/calls/webrtc-token`, screen-pop via lead lookup, wrap-up modal that PATCHes disposition + optionally schedules a callback.

## Voice-swap fix (2026-04-22)

- **Root cause**: Dashboard PATCH was sending client-computed `voiceProvider` that could drift; campaigns also stored `voice` as empty string (not null), causing the dashboard picker to render no selection.
- **Server fix** (`artifacts/api-server/src/routes/campaigns.ts` PATCH /campaigns/:id): when `voice` is supplied, look up its provider in the `voices` table and override the client-supplied `voiceProvider`. Empty-string voice is treated as no-change (preserves "Resume Draft" behavior that re-sends the full row).
- **Dashboard fix** (`artifacts/dashboard/src/pages/campaigns.tsx`): `useState(campaign.voice || "default")` so an empty stored voice cleanly initializes to the "default" option instead of an unhighlighted blank.
- **Verified live** against prod with 3 PATCH calls on campaign 9 — provider correctly resolved from DB; wrong client-supplied provider correctly overridden; empty voice correctly preserves prior value.
- **Known limitation** (pre-existing): no way to clear a non-default voice back to NULL via the API — dashboard always omits the field for "default". Not in scope.
