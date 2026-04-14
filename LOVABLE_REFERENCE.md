# SHIVANSH — Lovable Integration Reference

## Project Overview
AI-powered outbound calling SaaS. Dark navy UI, `font-mono` throughout, primary colour `hsl(183,100%,50%)` (cyan/teal).

---

## Backend

**Base URL:** `https://shivanshbackend.replit.app`

All responses are JSON. All routes (except `/auth/login` and `/health`) require:

```
Authorization: Bearer <token>
```

---

## Authentication

### POST /auth/login
```json
{ "email": "admin@shivansh.com", "password": "Admin@123" }
```
**Response:**
```json
{
  "token": "<jwt>",
  "user": { "id": 1, "name": "Admin", "email": "admin@shivansh.com", "role": "admin", "status": "online" }
}
```

**Token storage:** `localStorage.setItem("auth_token", token)`
**User storage:** `localStorage.setItem("auth_user", JSON.stringify(user))`

**Roles:** `admin` | `supervisor` | `agent`

---

## Campaigns

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/campaigns` | any | List all campaigns |
| GET | `/campaigns/:id` | any | Get single campaign |
| POST | `/campaigns` | admin | Create campaign |
| PATCH | `/campaigns/:id` | admin | Update campaign fields |
| DELETE | `/campaigns/:id` | admin | Delete campaign |
| POST | `/campaigns/:id/start` | admin | Start dialing |
| POST | `/campaigns/:id/stop` | admin | Stop dialing |
| POST | `/campaigns/:id/pause` | admin | Pause dialing |
| POST | `/campaigns/:id/resume` | admin | Resume dialing |
| POST | `/campaigns/:id/test-call` | admin | Fire one test call |
| POST | `/campaigns/:id/reset-leads` | admin | Reset all leads to pending |
| GET | `/campaigns/:id/agents` | any | Agents assigned to campaign |
| POST | `/campaigns/:id/agents` | admin | Assign agent to campaign |
| GET | `/campaigns/options` | any | Enum options for dropdowns |

**Campaign object:**
```ts
{
  id: number
  name: string
  status: "active" | "paused" | "stopped" | "completed"
  agentId: number | null          // ElevenLabs AI agent
  voiceId: number | null
  fromNumber: string | null       // fallback number
  transferNumber: string | null
  script: string | null
  backgroundSound: "none" | "office" | "typing" | "cafe"
  holdMusicUrl: string | null
  maxConcurrentCalls: number      // default 5
  dialingMode: "manual" | "progressive" | "predictive" | "preview"
  dialingRatio: number
  dialingSpeed: number            // calls per minute
  dropRateLimit: number           // % max
  retryAttempts: number
  retryIntervalMinutes: number
  amdEnabled: boolean             // answering machine detection
  workingHoursStart: string | null  // "09:00"
  workingHoursEnd: string | null    // "17:00"
  timezone: string | null
  createdAt: string
}
```

**Create/Update body** — any subset of the above fields.

---

## Leads

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/leads` | any | All leads (query: `campaignId`, `status`) |
| GET | `/leads/:campaign_id` | any | Leads for campaign (query: `source`) |
| POST | `/leads` | any | Add single lead |
| POST | `/leads/upload` | any | CSV upload (`multipart/form-data`, field `file`, query `campaignId`) |
| POST | `/leads/import-sheet` | admin | Google Sheets import `{ sheetUrl, campaignId }` |
| PATCH | `/leads/:id` | any | Update lead |
| DELETE | `/leads/:id` | admin | Delete lead |
| DELETE | `/leads` | admin | Bulk delete `{ ids: number[] }` |

**Lead object:**
```ts
{
  id: number
  name: string
  phone: string          // E.164
  email: string | null
  campaignId: number
  status: "pending" | "called" | "callback" | "do_not_call" | "completed"
  source: "manual" | "csv" | "sheet"
  priority: number       // 0–10, higher = dialed sooner
  dncFlag: boolean
  retryCount: number
  notes: string | null
  createdAt: string
}
```

**CSV upload response:**
```json
{
  "total_uploaded": 120,
  "total_skipped": 5,
  "invalid_numbers": 2,
  "duplicates": 1,
  "dnc_skipped": 2
}
```

---

## Call Logs (CDR)

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/call-logs` | any | All logs (query: `campaignId`), max 500 |
| GET | `/call-logs/:campaign_id` | any | Logs for campaign |
| PATCH | `/call-logs/:id/disposition` | any | Update disposition |

**Call log object:**
```ts
{
  id: number
  phoneNumber: string
  campaignId: number | null
  status: "initiated" | "completed" | "failed"
  disposition: "interested" | "not_interested" | "callback_requested" | "vm" | "no_answer" | "transferred" | "do_not_call" | "unknown"
  direction: "outbound" | "inbound"
  duration: number               // seconds
  recordingUrl: string | null
  transcript: string | null
  summary: string | null
  callControlId: string | null
  numberUsed: string | null      // which pool number was used
  answerType: "human" | "voicemail" | "no_answer" | null
  timestamp: string
}
```

---

## Phone Numbers (Pool)

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/numbers` | any | All pool numbers |
| POST | `/numbers/add` | admin | Add number `{ phoneNumber, label?, campaignId? }` |
| PATCH | `/numbers/:id` | admin | Update `{ status, isBlocked, campaignId, label }` |

**Phone number object:**
```ts
{
  id: number
  phoneNumber: string     // E.164
  label: string | null
  status: "active" | "inactive"
  isBusy: boolean
  isBlocked: boolean
  spamScore: number       // 0–100, higher = riskier
  usageCount: number
  campaignId: number | null
  lastUsedAt: string | null
  createdAt: string
}
```

---

## DNC (Do Not Call)

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/dnc` | any | All DNC entries |
| POST | `/dnc` | admin | Add single `{ phoneNumber, reason? }` |
| POST | `/dnc/import` | admin | Bulk import `{ numbers: string[] }` |
| DELETE | `/dnc/:id` | admin | Remove entry |
| GET | `/dnc/check/:number` | any | Check if on DNC |

---

## SMS

| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/sms/send` | any | Send single SMS |
| POST | `/sms/campaign/:campaign_id` | admin | Blast SMS to all eligible campaign leads |
| GET | `/sms/logs/:campaign_id` | any | SMS logs for a campaign |
| GET | `/sms/logs` | admin | All SMS logs |

**Single send body:**
```json
{ "to": "+14155550100", "from": "+18005551234", "message": "Hello!" }
```
`from` is optional — server picks a number from the pool automatically.

**Campaign blast body:**
```json
{ "message": "Hi {{name}}, this is SHIVANSH calling about your enquiry. Reply STOP to opt out." }
```
Merge tags: `{{name}}`, `{{phone_number}}`, `{{email}}`

**Campaign blast response** — always `202 Accepted` (sending is async):
```json
{
  "accepted": true,
  "campaign_id": 3,
  "total_leads": 87,
  "message": "SMS campaign started — 87 eligible leads queued"
}
```
DNC leads and `do_not_call` status leads are automatically excluded. A `409` is returned if a blast is already in progress for that campaign.

**SMS log object:**
```ts
{
  id: number
  phone_number: string
  campaign_id: number | null
  message: string
  status: "sent" | "failed"
  provider_message_id: string | null
  error: string | null
  timestamp: string
}
```

---

## Voices

### Multi-provider catalog

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/voices` | any | All providers grouped `{ elevenlabs:[…], deepgram:[…], cartesia:[…] }` |
| GET | `/voices?provider=elevenlabs` | any | Catalog for a single provider (also accepts `deepgram`, `cartesia`) |
| POST | `/voices/preview` | any | Generate TTS preview, returns `{ url, provider, voice_id }` |
| GET | `/voices/elevenlabs` | any | Raw ElevenLabs voice list from API |
| POST | `/voices/elevenlabs/sync` | admin | Sync ElevenLabs voices into DB |
| GET | `/voices/:id/preview` | any | Stream stored preview audio |
| POST | `/voices/:id/sample` | any | ElevenLabs sample `{ text }` |

### POST /voices/preview
```json
{
  "provider": "deepgram",
  "voice_id": "aura-asteria-en",
  "text": "Hello, this is a preview"
}
```
**Response:**
```json
{ "url": "https://shivanshbackend.replit.app/api/audio/<token>", "provider": "deepgram", "voice_id": "aura-asteria-en" }
```
- Returns 400 if `provider` or `voice_id` missing/invalid
- Returns 502 if provider API fails (e.g. missing API key)
- URL is playable for 10 minutes

### Voice catalog shape (per voice)
```json
{ "voice_id": "aura-asteria-en", "name": "Asteria", "gender": "female", "accent": "us", "provider": "deepgram", "source": "catalog" }
```

### Providers
| Provider | Env key needed | Notes |
|----------|---------------|-------|
| `elevenlabs` | `ELEVENLABS_API_KEY` | ConvAI + TTS; 8 curated voices — always works |
| `deepgram` | `DEEPGRAM_API_KEY` | Aura TTS; 10 voices — requires Deepgram Aura TTS plan; falls back to ElevenLabs if 401 |
| `cartesia` | `CARTESIA_API_KEY` | Sonic-2 TTS; **13 verified voices** (7F, 6M; US + UK accents) |

**Verified Cartesia voices (all live-tested):**
| voice_id | name | gender | accent |
|---|---|---|---|
| `db6b0ed5-d5d3-463d-ae85-518a07d3c2b4` | Skylar | female | us |
| `0ee8beaa-db49-4024-940d-c7ea09b590b3` | Morgan | female | us |
| `e07c00bc-4134-4eae-9ea4-1a55fb45746b` | Brooke | female | us |
| `5f621418-ab01-4bf4-9a9d-73d66032234e` | Willow | female | us |
| `e5a6cd18-d552-4192-9533-82a08cac8f23` | Patricia | female | us |
| `62ae83ad-4f6a-430b-af41-a9bede9286ca` | Gemma | female | uk |
| `2f251ac3-89a9-4a77-a452-704b474ccd01` | Lucy | female | uk |
| `f24ae0b7-a3d2-4dd1-89df-959bdc4ab179` | Ross | male | us |
| `3e39e9a5-585c-4f5f-bac6-5e4905c51095` | Cole | male | us |
| `d709a7e8-9495-4247-aef0-01b3207d11bf` | Donny | male | us |
| `df872fcd-da17-4b01-a49f-a80d7aaee95e` | Cameron | male | us |
| `df89f42f-f285-4613-adbf-14eedcec4c9e` | Harrison | male | uk |
| `4bc3cb8c-adb9-4bb8-b5d5-cbbef950b991` | George | male | uk |

### Assigning voice to a campaign
```json
PATCH /campaigns/:id
{ "voice": "aura-asteria-en", "voiceProvider": "deepgram" }
```
The system automatically falls back: requested provider → ElevenLabs → OpenAI TTS → Telnyx native speak.

---

## Dashboard / Stats

| Method | Path | Description |
|--------|------|-------------|
| GET | `/dashboard/summary` | KPIs: totalCalls, activeCampaigns, connectedCalls, avgDuration |
| GET | `/dashboard/live-calls` | Currently active calls |
| GET | `/dashboard/agents` | Agent online/offline status |

---

## Users

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/users` | admin/supervisor | All users |
| POST | `/users` | admin | Create user `{ name, email, password, role }` |
| PATCH | `/users/me/status` | any | Update own status `{ status }` |

---

## Callbacks

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/callbacks` | any | List leads with `status=callback`; optional `?campaignId=N` |
| POST | `/callbacks/schedule` | any | Schedule callback `{ leadId, callbackAt, notes? }` |
| PATCH | `/callbacks/:id` | any | Update `{ status?, notes?, callbackAt? }` |

**Callback object:**
```ts
{
  id: number
  name: string
  phone: string           // also phone_number
  email: string | null
  campaignId: number      // also campaign_id
  campaignName: string | null
  status: string
  notes: string | null
  callbackAt: string | null   // also callback_at, ISO 8601
  createdAt: string
}
```

**Schedule body:** `{ "leadId": 123, "callbackAt": "2025-04-15T14:30:00.000Z", "notes": "optional" }`
**Update to done:** `PATCH /callbacks/:id { "status": "completed" }`

---

## Human Agents / Stats

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/agents` | any | All agents with live Redis status |
| GET | `/agents/stats` | any | Per-agent stats today; optional `?agentId=N` |
| GET | `/agents/available` | any | First available agent |
| POST | `/agents/create` | admin | Create agent `{ name, phone_number }` |
| PATCH | `/agents/status` | any | Update own status `{ id, status }` |
| DELETE | `/agents/:id` | admin | Remove agent |

**Stats response item:**
```ts
{
  id: number
  name: string
  phone_number: string
  status: "available" | "busy"
  current_call: string | null
  stats: {
    callsToday: number
    avgDuration: number          // seconds
    dispositions: Record<string, number>  // e.g. { "vm": 3, "interested": 5 }
  }
}
```

---

## Conference (3-Way Calling)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/calls/:callControlId/conference` | Add a third party to an active call |

**Body:** `{ "to": "+14155550100" }` (E.164)

**Response:**
```json
{
  "conferenceName": "conf_XXXXXXXX_1712345678000",
  "thirdPartyCallControlId": "...",
  "message": "Conference initiated — third party is being dialed"
}
```

---

## WebSocket (Live Monitor)

**URL:** `wss://shivanshbackend.replit.app` (same host, `/socket.io` path, Socket.io v4)

Connect with: `{ auth: { token } }` in Socket.io handshake options.

**Events emitted by server:**

| Event | Payload |
|-------|---------|
| `call:started` | `{ id, callControlId, phone, campaignId, campaignName, direction, startedAt }` |
| `call:ended` | `{ id, callControlId, disposition, duration }` |
| `call:transcript` | `{ id, callControlId, role: "user"\|"agent", text, timestamp }` |
| `agent:status` | `{ agentId, status, name }` |
| `agent:stats:refresh` | `{ ts }` — signal to re-poll `/agents/stats` |
| `agent:incoming_call` | `{ callId, callerPhone, campaignId }` |

---

## Pages Already Built (do not recreate)

| Page | Route | Status |
|------|-------|--------|
| Login | `/login` | Done |
| Dashboard | `/` | Done |
| Campaigns | `/campaigns` | Done |
| Leads | `/leads` | Done |
| Call Logs | `/calls` | Done |
| Voices | `/voices` | Done |
| DNC | `/dnc` | Done |
| Users | `/users` | Done |
| Settings | `/settings` | Done |

## Pages to Build in Lovable

| Page | Route | Notes |
|------|-------|-------|
| **Phone Numbers** | `/numbers` | Pool health table: spamScore badge (green < 30, amber < 70, red ≥ 70), isBusy chip, usageCount, assign to campaign dropdown, block toggle |
| **Live Monitor** | `/live-monitor` | Real-time call board via WebSocket — active call cards with transcript stream, agent grid |
| **CDR / Recordings** | `/cdr` | Filterable table with `numberUsed`, `answerType`, `disposition`, duration; inline audio player for `recordingUrl` |
| **Campaign Analytics** | `/analytics` | Disposition breakdown pie chart, calls-per-hour bar chart, voicemail rate trend line — all from `/call-logs` |
| **Agent Softphone** | `/softphone` | Dial pad, active call controls, 3-way conference, live transcript, per-agent stats — see `LOVABLE_SOFTPHONE_PROMPT.md` |
| **Callbacks** | `/callbacks` | Scheduled callback manager — see `LOVABLE_SOFTPHONE_PROMPT.md` |

---

## Design Tokens

```css
--background:     hsl(222, 47%, 7%);   /* dark navy */
--surface:        hsl(222, 40%, 12%);  /* card bg */
--border:         hsl(220, 30%, 20%);
--primary:        hsl(183, 100%, 50%); /* cyan */
--primary-dim:    hsl(183, 80%, 30%);
--text:           hsl(210, 40%, 96%);
--text-muted:     hsl(215, 20%, 60%);
--success:        hsl(142, 71%, 45%);
--warning:        hsl(38, 92%, 50%);
--danger:         hsl(0, 84%, 60%);
font-family: "JetBrains Mono", "Fira Code", monospace;
```

---

## Auth Pattern (copy into Lovable)

```ts
// api.ts
const BASE = "https://shivanshbackend.replit.app";

async function apiFetch(path: string, init?: RequestInit) {
  const token = localStorage.getItem("auth_token");
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401) {
    localStorage.removeItem("auth_token");
    window.location.href = "/login";
  }
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export const api = {
  get:    (path: string)             => apiFetch(path),
  post:   (path: string, body: any)  => apiFetch(path, { method: "POST",  body: JSON.stringify(body) }),
  patch:  (path: string, body: any)  => apiFetch(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: (path: string)             => apiFetch(path, { method: "DELETE" }),
};
```
