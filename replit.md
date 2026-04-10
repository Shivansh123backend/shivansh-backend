# AI Calling SaaS Backend

## Overview

Production-grade, scalable Node.js backend for an AI-powered calling SaaS platform with campaign management, AI voice agents, multi-provider telephony, human agent routing, BullMQ job queue, and WebSocket supervisor monitoring.

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
