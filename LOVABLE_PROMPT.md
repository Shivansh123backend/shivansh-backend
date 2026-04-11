# SHIVANSH AI CALLING — Lovable Frontend Wiring Prompt

> Copy the entire contents of this file and paste it into Lovable as a single prompt.

---

## Project Brief

Wire up the **Shivansh AI Calling** dashboard frontend to the production backend API.

- **Backend base URL**: `https://shivanshbackend.replit.app`
- **All API routes are prefixed with**: `/api`
- **Authentication**: JWT Bearer token — stored in `localStorage` as `auth_token`
- **App name**: SHIVANSH AI CALLING (use this name everywhere in the UI)
- **Design language**: Dark terminal aesthetic — deep navy/black background (`hsl(224,71%,3%)`), monospace fonts, green/blue accent colors, minimal borders

---

## 1. Authentication

### Login
```
POST /api/auth/login
Body: { email: string, password: string }
Response: { token: string, user: { id, name, email, role: "admin"|"supervisor"|"agent", status } }
```
- Store `token` in `localStorage["auth_token"]`
- Store `user` JSON in `localStorage["auth_user"]`
- Attach the token to every subsequent request: `Authorization: Bearer <token>`
- On `401` from any endpoint: clear localStorage, redirect to `/login`

**Test credentials:**
- Admin: `admin@shivansh.com` / `Admin@123`
- Agent: `agent@shivansh.com` / `Agent@123`

**Role-based access:**
- `admin` — full access to all pages
- `supervisor` — view-only access to live monitor, calls, analytics
- `agent` — access to dialer, callbacks, call records only

---

## 2. API Endpoints Reference

All requests must include `Authorization: Bearer <token>` header.

### Campaigns
```
GET    /api/campaigns                      — list all campaigns
POST   /api/campaigns/create               — create campaign (admin only)
PATCH  /api/campaigns/:id                  — update campaign fields (admin only)
POST   /api/campaigns/start/:id            — start campaign (admin only)
POST   /api/campaigns/stop/:id             — stop/pause campaign (admin only)
POST   /api/campaigns/:id/test-call        — fire a single test call (admin only)
       Body: { phone: string }
POST   /api/campaigns/:id/reset-leads      — reset all leads to pending (admin only)
GET    /api/campaigns/:id/agents           — list agents assigned to campaign
POST   /api/campaigns/:id/agents           — assign agent to campaign (admin only)
       Body: { agentId: number }
```

**Campaign object shape:**
```json
{
  "id": 1,
  "name": "Q2 Sales Outreach",
  "status": "active" | "paused" | "draft" | "completed",
  "type": "outbound" | "inbound",
  "routingType": "ai" | "human" | "ai_then_human",
  "maxConcurrentCalls": 10,
  "voice": "voice_id_string",
  "fromNumber": "+12025551234",
  "transferNumber": "+12025559999",
  "agentPrompt": "You are a friendly sales agent...",
  "knowledgeBase": "Product info, SOPs...",
  "recordingNotes": "Learning from past recordings...",
  "backgroundSound": "none" | "office" | "typing" | "cafe",
  "holdMusic": "none" | "jazz" | "corporate" | "smooth" | "classical",
  "humanLike": "true" | "false"
}
```

**Create campaign body:**
```json
{
  "name": "string (required)",
  "type": "outbound",
  "routingType": "ai",
  "maxConcurrentCalls": 5,
  "agentPrompt": "optional",
  "knowledgeBase": "optional",
  "recordingNotes": "optional",
  "voice": "optional elevenlabs voice_id",
  "fromNumber": "optional E.164 phone number",
  "backgroundSound": "none",
  "holdMusic": "none",
  "humanLike": "true"
}
```

---

### Leads
```
GET  /api/leads?campaignId=:id             — list leads for a campaign
POST /api/leads/upload/:campaignId         — upload CSV/XLSX file (multipart/form-data, field: "file")
POST /api/leads/add                        — add single lead
     Body: { name, phone, email?, campaignId }
DELETE /api/leads/:id                      — delete a lead
```

**Lead object:**
```json
{
  "id": 1,
  "name": "John Smith",
  "phone": "+12025551234",
  "email": "john@example.com",
  "status": "pending" | "called" | "callback" | "completed",
  "campaignId": 1,
  "createdAt": "2025-01-01T00:00:00Z"
}
```

---

### Calls (Full CDR — outbound calls table)
```
GET  /api/calls?campaignId=:id             — list calls, optionally filtered by campaign
GET  /api/calls/live                       — list currently active/in-progress calls
GET  /api/calls/stats/today                — { total: number, completed: number }
GET  /api/calls/:id/export?format=txt|pdf  — download call report as TXT or PDF
PATCH /api/calls/:id/disposition           — manually set disposition
      Body: { disposition: "interested"|"not_interested"|"vm"|"no_answer"|"busy"|"connected"|"callback_requested"|"transferred"|"completed" }
```

**Call object:**
```json
{
  "id": 1,
  "campaignId": 1,
  "leadId": 42,
  "status": "initiated" | "in_progress" | "completed" | "failed" | "no_answer" | "busy",
  "disposition": "interested" | "not_interested" | "vm" | "no_answer" | "busy" | "connected" | "callback_requested" | "transferred" | "completed" | null,
  "providerUsed": "telnyx" | "voip" | "twilio",
  "selectedVoice": "voice_id",
  "selectedNumber": "+12025551234",
  "duration": 120,
  "recordingUrl": "https://storage.telnyx.com/recordings/xxx.mp3",
  "transcript": "Agent: Hello...\nCustomer: Hi...",
  "summary": "Customer expressed interest in product X...",
  "startedAt": "2025-01-01T10:00:00Z",
  "endedAt": "2025-01-01T10:02:00Z",
  "createdAt": "2025-01-01T09:59:00Z"
}
```

---

### Call Logs (Campaign-level lightweight logs — includes both inbound & outbound)
```
GET  /api/call-logs                        — all logs (up to 500), supports ?campaignId=:id
GET  /api/call-logs/:id/export?format=txt|pdf — download log report as TXT or PDF
PATCH /api/call-logs/:id/disposition       — update disposition
      Body: { disposition: string, summary?: string }
```

**Call log object:**
```json
{
  "id": 1,
  "phoneNumber": "+12025551234",
  "campaignId": 1,
  "status": "initiated" | "completed" | "failed",
  "disposition": "interested" | null,
  "direction": "inbound" | "outbound",
  "duration": 90,
  "recordingUrl": "https://storage.telnyx.com/recordings/xxx.mp3",
  "transcript": "Agent: Hello...",
  "summary": "AI-generated summary...",
  "callControlId": "telnyx-call-id",
  "timestamp": "2025-01-01T10:00:00Z"
}
```

---

### Phone Numbers
```
GET  /api/numbers                          — list all configured phone numbers
POST /api/numbers                          — add number (admin only)
     Body: { phoneNumber, provider, status }
DELETE /api/numbers/:id                    — remove number (admin only)
```

**Number object:**
```json
{
  "id": 1,
  "phoneNumber": "+12025551234",
  "provider": "telnyx",
  "status": "active" | "inactive",
  "campaignId": null
}
```

---

### Voices
```
GET  /api/voices                           — list voices stored in DB
GET  /api/voices/elevenlabs               — fetch live ElevenLabs voice list (includes preview URLs)
```

**ElevenLabs voice object:**
```json
{
  "voice_id": "21m00Tcm4TlvDq8ikWAM",
  "name": "Rachel",
  "preview_url": "https://storage.googleapis.com/eleven-preview/...",
  "labels": {
    "gender": "female",
    "accent": "american",
    "description": "calm, professional",
    "use_case": "sales"
  }
}
```

---

### Agents (AI Agents)
```
GET  /api/agents                           — list all AI agents
POST /api/agents                           — create AI agent (admin only)
PATCH /api/agents/:id                      — update agent
DELETE /api/agents/:id                     — delete agent
```

---

### Users (Human Users)
```
GET  /api/users                            — list all users
POST /api/users/create                     — create user (admin only)
     Body: { name, email, password, role: "admin"|"supervisor"|"agent" }
PATCH /api/users/:id                       — update user (admin only)
DELETE /api/users/:id                      — delete user (admin only)
```

---

### Dashboard / Stats
```
GET  /api/dashboard/summary               — { total_calls, active_calls, completed_calls }
GET  /api/dashboard/live-calls            — list of active calls with phone/campaign info
GET  /api/dashboard/available-agents      — list of online agents
GET  /api/dashboard/agent-performance     — per-agent stats
```

---

### Manual / Outbound Dialer
```
POST /api/manual-call                      — initiate a manual outbound call
     Body: { phone, campaignId?, agentId?, voice?, fromNumber? }
```

---

### Human Agents (call center agents — live status)
```
GET  /api/human-agents                     — list human agents with live status
POST /api/human-agents/:id/status         — update agent status
     Body: { status: "available" | "on_call" | "break" | "offline" }
```

---

### WebRTC Dialer (browser calls via Telnyx)
```
GET  /api/calls/webrtc-token              — get a Telnyx WebRTC token
     Returns: { token: string, connectionId: string }
     connectionId is: 2935198916355818730
```

---

### SMS
```
POST /api/sms/send                         — send an SMS
     Body: { to, from, message }
GET  /api/sms/messages                     — list SMS messages
```

---

## 3. Real-Time WebSocket Events (Socket.IO)

Connect to the backend WebSocket for live updates:

```javascript
import { io } from "socket.io-client";

const socket = io("https://shivanshbackend.replit.app", {
  path: "/api/ws",
  auth: { token: localStorage.getItem("auth_token") },
  transports: ["websocket", "polling"],
});
```

**Events emitted by server:**

| Event | Payload | Description |
|-------|---------|-------------|
| `call:queued` | `{ callId, leadId, campaignId, phoneNumber }` | New call added to queue |
| `call:started` | `{ id, leadId, campaignId, phoneNumber, providerUsed, selectedNumber, agentId }` | Call is now ringing/active |
| `call:ended` | `{ id, disposition, duration }` | Call completed or failed |
| `call:transferred` | `{ callId, agentId }` | Call transferred to human agent |
| `call:inbound` | `{ callId, from, campaignId }` | Inbound call received |
| `call_update` | `{ id, status }` | Status changed on any call |
| `campaign:started` | `{ campaignId, name }` | Campaign became active |
| `campaign:stopped` | `{ campaignId, name, reason }` | Campaign paused/stopped |
| `agent_status` | `{ agentId, status }` | Human agent status changed |
| `agent:status_update` | `{ agentId, status }` | Same as above (alias) |

---

## 4. Export / Download Reports

For both `/api/calls/:id/export` and `/api/call-logs/:id/export`:
- Add `?format=txt` for a plain-text report
- Add `?format=pdf` for a PDF download
- The response is a file download — use `fetch()` to get a blob and trigger a browser download:

```javascript
const token = localStorage.getItem("auth_token");
const res = await fetch(`https://shivanshbackend.replit.app/api/calls/${id}/export?format=pdf`, {
  headers: { Authorization: `Bearer ${token}` },
});
const blob = await res.blob();
const url = URL.createObjectURL(blob);
const a = document.createElement("a");
a.href = url;
a.download = `call-${id}.pdf`;
a.click();
URL.revokeObjectURL(url);
```

---

## 5. Disposition Values

Use these exact string values when updating dispositions:

| Value | Display Label |
|-------|--------------|
| `interested` | Interested |
| `not_interested` | Not Interested |
| `connected` | Connected |
| `vm` | Voicemail |
| `no_answer` | No Answer |
| `busy` | Busy |
| `callback_requested` | Callback Requested |
| `transferred` | Transferred |
| `completed` | Completed |

---

## 6. Pages to Build / Wire Up

Build all pages with the dark terminal aesthetic: navy-black background, monospace (font-mono) text, subtle borders, green accents for live/active states.

### `/login` — Login Page
- Email + password form
- Call `POST /api/auth/login`
- Store token + user in localStorage
- Redirect admin/supervisor to `/` (dashboard), agent to `/dialer`

### `/` — Dashboard Overview
- Pull from `GET /api/dashboard/summary` for stat cards: Total Calls, Active Calls, Completed
- Pull from `GET /api/campaigns` to show Active Campaigns count
- Show recent calls from `GET /api/calls` (last 10)
- Show live calls from `GET /api/dashboard/live-calls`
- Auto-refresh every 15 seconds

### `/campaigns` — Campaign Manager (admin only)
- List all campaigns from `GET /api/campaigns`
- Status badges: active (green), paused (yellow), draft (gray)
- Start/Stop buttons → `POST /api/campaigns/start/:id` / `POST /api/campaigns/stop/:id`
- "New Campaign" 3-step wizard:
  1. **Basics**: Name, Type (outbound/inbound), Routing (ai/human/ai_then_human), Max Concurrent Calls
  2. **Agent Training**: Knowledge Base (text area + file upload), Call Script/Prompt (text area), Training Notes, Human-Like Mode toggle
  3. **Voice & Number**: Voice picker (fetch from `/api/voices/elevenlabs` with play preview), From Number (select from `/api/numbers`), Background Sound, Hold Music
- Campaign detail drawer/modal with edit capability → `PATCH /api/campaigns/:id`
- Test Call button → `POST /api/campaigns/:id/test-call` with phone input
- Reset Leads button → `POST /api/campaigns/:id/reset-leads`

### `/leads` — Lead Management (admin only)
- Filter by campaign (dropdown from `GET /api/campaigns`)
- Fetch leads: `GET /api/leads?campaignId=:id`
- Bulk CSV/XLSX upload → `POST /api/leads/upload/:campaignId` (multipart)
- Add single lead form → `POST /api/leads/add`
- Delete lead → `DELETE /api/leads/:id`
- Status badges: pending (yellow), called (blue), callback (purple), completed (green)

### `/calls` — Call Records
- Two tabs: "Full CDR" and "Campaign Logs"
- **Full CDR** tab: `GET /api/calls?campaignId=:id`
  - Columns: ID, Campaign, Lead, Provider, Status, Disposition, Duration
  - Expandable rows showing: AI Summary, Transcript, Recording link
  - Actions in expanded row: Disposition dropdown (`PATCH /api/calls/:id/disposition`), Export TXT/PDF buttons
- **Campaign Logs** tab: `GET /api/call-logs?campaignId=:id`
  - Columns: ID, Phone, Campaign, Direction (in/out), Status, Disposition, Duration, Timestamp
  - Same expandable row pattern with disposition + export actions
  - Auto-refresh every 10 seconds

### `/dispositions` — Disposition Analytics
- Pull from `GET /api/calls`
- Show breakdown by disposition as bar chart + stat cards
- Table of recently dispositioned calls

### `/live-monitor` — Real-Time Monitor (admin/supervisor)
- Connect to WebSocket (see Section 3 above)
- Active calls grid: each card shows phone number, campaign name, elapsed timer, provider, status
- Event log: scrollable list of real-time events (call started, ended, transferred, campaign events)
- Stats: Active Calls count, Active Campaigns, Available Agents, Today's success rate

### `/analytics` — Analytics (admin/supervisor)
- Pull from `GET /api/calls`, `GET /api/campaigns`, `GET /api/leads`
- Stat cards: Total Calls, Completed, Avg Duration, Total Leads
- Disposition breakdown bar chart
- Campaign performance table: name, status, total calls, interested count, interest rate %

### `/voices` — Voice Library (admin)
- Fetch from `GET /api/voices/elevenlabs`
- Grid of voice cards with name, gender/accent labels
- Play preview button for each voice
- Show which voice is set on which campaign

### `/numbers` — Phone Numbers (admin)
- List from `GET /api/numbers`
- Add number form → `POST /api/numbers`
- Delete → `DELETE /api/numbers/:id`
- Status toggle (active/inactive)

### `/agents` — AI Agents (admin)
- List from `GET /api/agents`
- Create/Edit/Delete agents

### `/users` — User Management (admin)
- List from `GET /api/users`
- Create user form → `POST /api/users/create`
- Role: admin, supervisor, agent
- Edit/Delete

### `/dialer` — Browser Dialer (agent)
- Get WebRTC token → `GET /api/calls/webrtc-token`
- Use Telnyx WebRTC SDK to make/receive calls in browser
- Connection ID: `2935198916355818730`
- Manual call form → `POST /api/manual-call`
- Agent status toggle (available/break/on_call)

### `/callbacks` — Callback Queue (agent)
- List calls with `disposition = "callback_requested"` from `GET /api/call-logs`
- Allow agent to initiate callback → `POST /api/manual-call`

### `/settings` — Platform Settings (admin)
- Display info about configured integrations (Telnyx, ElevenLabs)
- Show system status info

---

## 7. Global UI Patterns

**Nav sidebar items** (show based on role):
- Dashboard (`/`) — all roles
- Live Monitor (`/live-monitor`) — admin, supervisor
- Campaigns (`/campaigns`) — admin
- Leads (`/leads`) — admin
- Calls (`/calls`) — all roles
- Dispositions (`/dispositions`) — admin, supervisor
- Analytics (`/analytics`) — admin, supervisor
- Voices (`/voices`) — admin
- Numbers (`/numbers`) — admin
- Agents (`/agents`) — admin
- Users (`/users`) — admin
- Dialer (`/dialer`) — agent
- Callbacks (`/callbacks`) — agent
- Settings (`/settings`) — admin

**Status badge colors:**
- `active` / `completed` / `interested` → green
- `paused` / `initiated` → yellow
- `failed` / `not_interested` → red
- `in_progress` → blue
- `no_answer` / `busy` → gray

**Header:** Show app name "SHIVANSH", logged-in user name + role badge, logout button

**Error handling:** On any API error, show a toast notification. On 401, redirect to login.

**Loading states:** Show skeleton loaders for all data tables while fetching.

---

## 8. Sample API Call Pattern (JavaScript)

```javascript
const API = "https://shivanshbackend.replit.app";

async function apiCall(method, path, body) {
  const token = localStorage.getItem("auth_token");
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 401) {
    localStorage.clear();
    window.location.href = "/login";
    return;
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error ?? "Request failed");
  }

  return res.json();
}

// Examples:
const campaigns = await apiCall("GET", "/campaigns");
const newCampaign = await apiCall("POST", "/campaigns/create", { name: "Test", type: "outbound" });
await apiCall("POST", "/campaigns/start/1");
```

---

## Notes

- The backend is already deployed and live at `https://shivanshbackend.replit.app`
- No CORS issues — the backend accepts requests from any origin
- Telnyx webhook URL: `https://shivanshbackend.replit.app/api/webhooks/telnyx`
- AI voice worker: `https://ai-voice-worker1.replit.app` (called internally by the backend)
- All timestamps are ISO 8601 UTC strings
- All IDs are integers
- Phone numbers follow E.164 format: `+12025551234`
