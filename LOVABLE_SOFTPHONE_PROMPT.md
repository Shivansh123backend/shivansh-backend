# SHIVANSH — Agent Softphone + Callbacks UI (Lovable Prompt)

## Context

You are building two new pages for the **SHIVANSH** AI-powered calling SaaS admin dashboard (already partially built in Lovable).

**Existing infrastructure:**
- Backend: `https://shivanshbackend.replit.app`
- Auth token key in localStorage: `auth_token` (NOT "token")
- Design system: dark navy, `font-mono` throughout, primary `hsl(183,100%,50%)`
- WebSocket: Socket.io v4 at `wss://shivanshbackend.replit.app`

**Add to the existing sidebar navigation** (do not recreate Login or any existing pages):
1. `/softphone` — Agent Softphone
2. `/callbacks` — Scheduled Callbacks

---

## Auth + API helper (reuse if already in project, otherwise add)

```ts
// src/lib/api.ts
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
  get:    (path: string)            => apiFetch(path),
  post:   (path: string, body: any) => apiFetch(path, { method: "POST",  body: JSON.stringify(body) }),
  patch:  (path: string, body: any) => apiFetch(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: (path: string)            => apiFetch(path, { method: "DELETE" }),
};
```

---

## Page 1: `/softphone` — Agent Softphone

### Purpose
Browser-based softphone for human agents. Shows live call queue, lets agents dial out manually, manage active calls, add a 3rd party (conference), and view their personal stats for today.

### Layout (full-page, dark navy)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  AGENT SOFTPHONE                        [Status: ● AVAILABLE ▼]          │
├─────────────────────────┬────────────────────────────┬───────────────────┤
│     MY STATS TODAY      │        DIAL PAD             │  ACTIVE CALL      │
│  Calls:    12           │  ┌──────────────────────┐   │  (empty when idle)│
│  Avg dur:  4m 12s       │  │  +1 (555) 000-0000   │   │                   │
│  Answered: 8            │  └──────────────────────┘   │                   │
│  VM:       3            │  [1][2][3]                   │                   │
│  No ans:   1            │  [4][5][6]                   │                   │
│                         │  [7][8][9]                   │                   │
│                         │  [*][0][#]                   │                   │
│                         │  [⌫]    [✆ CALL]            │                   │
├─────────────────────────┴────────────────────────────┴───────────────────┤
│  INCOMING / QUEUE                                                          │
│  (list of inbound calls routed to this agent)                             │
└──────────────────────────────────────────────────────────────────────────┘
```

### Agent Status Toggle
- `GET /agents` — find own agent record by matching phone/name
- `PATCH /agents/status` → `{ id: agentId, status: "available" | "busy" }`
- Show as pill button: green `● AVAILABLE` / amber `● BUSY`
- Changing status updates Redis presence instantly

### My Stats Today panel
- `GET /agents/stats` → array of agents with `.stats` object
- Find own agent in array
- Display: **Calls Today**, **Avg Duration** (seconds → `Xm Ys`), **Dispositions** (interested / vm / no_answer / busy as coloured badges)
- Auto-refresh every 30s and on `agent:stats:refresh` WebSocket event

### Dial Pad
- Styled numeric grid (1–9, *, 0, #), backspace button
- Phone number input field (E.164 format enforced on submit)
- Large cyan **CALL** button
- On submit: `POST /calls/initiate` OR `POST /calls/manual` → check which endpoint exists; use `/calls/initiate`
  ```json
  { "leadId": 0, "campaignId": 1, "overrideProvider": "telnyx" }
  ```
  Actually for ad-hoc dialing, use direct Telnyx route:
  - `POST /calls/outbound` with `{ to: phoneNumber }` if it exists
  - Fallback: show a toast "Use campaigns to dial leads"
- Store returned `callControlId` for active call controls

### Active Call Panel (shown only when a call is live)
Displayed in the right column while `callControlId` is set:

```
┌────────────────────────────────────────────┐
│  📞 ACTIVE CALL                            │
│  +1 (555) 000-0000                         │
│  ⏱  02:14                                  │
│                                            │
│  [🔇 MUTE]  [⏸ HOLD]  [🔴 HANG UP]        │
│                                            │
│  ── 3-WAY CONFERENCE ──                    │
│  Phone to add: [___________________]       │
│                     [➕ Add to Call]       │
│                                            │
│  TRANSCRIPT (live)                         │
│  [scrolling transcript from WebSocket]     │
└────────────────────────────────────────────┘
```

**Active call actions:**

| Button | API call |
|--------|----------|
| Hang Up | `POST /calls/:callControlId/hangup` (if exists) or show message |
| Mute | client-side indicator only (Telnyx controls mute via WebRTC in real deployments; show as toggle) |
| Hold | client-side indicator only |
| Add to Call (conference) | `POST /calls/:callControlId/conference` with `{ to: "+1XXXXXXXXXX" }` |

**Conference response:**
```json
{
  "conferenceName": "conf_XXXXXXXX_1712345678000",
  "thirdPartyCallControlId": "...",
  "message": "Conference initiated — third party is being dialed"
}
```
Show a success toast with the conference name.

**Call timer:** Start counting when `call:started` WebSocket event is received for this `callControlId`.

**Live transcript:** Subscribe to `call:transcript` WebSocket events. Append each line:
```
[user]  Hi I'm calling about…
[agent] Hello! How can I help…
```
User lines in `--text-muted`, agent lines in `--primary`.

### Incoming Call Alerts
- Subscribe to `agent:incoming_call` Socket.io event
- Show a modal / banner:
  ```
  📞 Incoming Call
  Caller: +1 (555) 000-0000
  Campaign: Outbound Sales Q2
  [ANSWER] [DECLINE]
  ```
- ANSWER: `POST /calls/:callId/answer` (if endpoint exists; otherwise just close the modal and wait for Telnyx)
- DECLINE: `DELETE /calls/:callId` or just close modal

### WebSocket Connection
```ts
import { io } from "socket.io-client";

const socket = io("https://shivanshbackend.replit.app", {
  auth: { token: localStorage.getItem("auth_token") },
  transports: ["websocket"],
});

socket.on("call:started",        (data) => { /* set active call */ });
socket.on("call:ended",          (data) => { /* clear active call */ });
socket.on("call:transcript",     (data) => { /* append to transcript */ });
socket.on("agent:stats:refresh", ()     => { /* refetch /agents/stats */ });
socket.on("agent:incoming_call", (data) => { /* show incoming call banner */ });
```

---

## Page 2: `/callbacks` — Scheduled Callbacks

### Purpose
Manage leads that have been scheduled for a callback at a specific time. Agents can see upcoming callbacks, reschedule them, mark them as done, or trigger an immediate call.

### Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│  SCHEDULED CALLBACKS                                                       │
│  [Filter: All Campaigns ▼]  [Filter: All Dates ▼]  [+ Schedule New]       │
├───────────┬──────────────────┬───────────────────┬──────────┬────────────┤
│  DUE AT   │  LEAD            │  CAMPAIGN         │  STATUS  │  ACTIONS   │
├───────────┼──────────────────┼───────────────────┼──────────┼────────────┤
│  Today    │  John Smith      │  Q2 Outbound      │ callback │ [Call][✏] │
│  2:30 PM  │  +1555-000-1234  │                   │          │  [Done]    │
│───────────┼──────────────────┼───────────────────┼──────────┼────────────│
│  Tomorrow │  Jane Doe        │  Enterprise       │ callback │ [Call][✏] │
│  10:00 AM │  +1555-000-5678  │                   │          │  [Done]    │
└──────────────────────────────────────────────────────────────────────────┘
```

### API Calls

**Load callbacks:**
```
GET /callbacks?campaignId=<id>
```
Response array:
```ts
{
  id: number
  name: string
  phone: string          // also phone_number
  email: string | null
  campaignId: number     // also campaign_id
  campaignName: string | null
  status: string
  notes: string | null
  callbackAt: string | null   // also callback_at, ISO 8601
  createdAt: string
}
```

**Schedule a new callback** (modal):
```
POST /callbacks/schedule
{ "leadId": 123, "callbackAt": "2025-04-15T14:30:00.000Z", "notes": "Call back re: pricing" }
```
→ `201` returns the updated lead.

**Update a callback** (reschedule or mark done):
```
PATCH /callbacks/:id
{ "status": "completed" }         // mark done
{ "callbackAt": "ISO8601",
  "notes": "New note" }           // reschedule
```

**"Schedule New" modal:**
- Search for a lead by name/phone: `GET /leads?search=<query>&status=pending`
- Select a lead from results
- DateTime picker for `callbackAt`
- Optional notes textarea
- Submit → `POST /callbacks/schedule`

**Table row actions:**
- **[Call]** — navigates to `/softphone` with the phone number pre-filled (use URL params: `/softphone?phone=+15550001234`)
- **[✏ Reschedule]** — opens modal pre-filled with current `callbackAt` and `notes`
- **[Done]** — `PATCH /callbacks/:id { status: "completed" }` → removes from list

**Auto-refresh:** Re-fetch `GET /callbacks` every 60s. Show overdue callbacks (callbackAt in the past) in amber/warning colour.

**Empty state:** "No callbacks scheduled. Agents can schedule a callback from an active call or from the Leads page."

---

## Design Tokens (copy verbatim)

```css
--background:     hsl(222, 47%, 7%);
--surface:        hsl(222, 40%, 12%);
--surface-raised: hsl(222, 35%, 16%);
--border:         hsl(220, 30%, 20%);
--primary:        hsl(183, 100%, 50%);
--primary-dim:    hsl(183, 80%, 30%);
--text:           hsl(210, 40%, 96%);
--text-muted:     hsl(215, 20%, 60%);
--success:        hsl(142, 71%, 45%);
--warning:        hsl(38, 92%, 50%);
--danger:         hsl(0, 84%, 60%);
font-family: "JetBrains Mono", "Fira Code", monospace;
```

All cards use `--surface` background with `1px solid var(--border)` border and `8px` border-radius.
Buttons: cyan `--primary` with black text, `font-weight: 600`, `border-radius: 6px`.
Dial pad keys: `--surface-raised` bg, `--primary` text, `48px` square, `border-radius: 8px`.

---

## Sidebar additions

Add these two items to the existing sidebar nav (after Leads, before Settings):

```
📞  Softphone     /softphone
🔁  Callbacks     /callbacks
```

Show a yellow dot badge on Callbacks nav item when there are overdue callbacks.

---

## Telnyx WebRTC Browser SDK (for outbound dialing from dialpad)

Install: `npm install @telnyx/webrtc`

```ts
import { TelnyxRTC } from "@telnyx/webrtc";

// 1. Fetch token from backend
const { token } = await api.get("/calls/webrtc-token");

// 2. Create client
const client = new TelnyxRTC({ login_token: token });

// 3. Handle events
client.on("telnyx.ready", () => console.log("WebRTC ready"));
client.on("telnyx.error", (err) => console.error(err));
client.on("telnyx.notification", (notification) => {
  if (notification.type === "callUpdate") {
    const call = notification.call;
    // call.state: "new" | "trying" | "recovering" | "ringing" | "answering" | "early" | "active" | "held" | "hangup" | "destroy" | "purge"
    if (call.state === "active") setActiveCall(call);
    if (call.state === "destroy") setActiveCall(null);
  }
});

// 4. Connect
client.connect();

// 5. Make a call
const call = client.newCall({
  destinationNumber: "+12125550100",
  callerIdNumber: agentPhoneNumber,  // agent's registered Telnyx number
});

// 6. Call controls
call.mute();       // mute mic
call.unmute();
call.hold();       // put on hold
call.unhold();
call.hangup();     // end call
call.answer();     // answer inbound
```

The `call.id` (call_control_id) returned when the call becomes active is what you pass to
`POST /calls/{callControlId}/conference { to: "+1..." }` to add a third party.

---

## Conference / 3-Way Call

Once a call is active and you have `callControlId`:

```
POST /calls/{callControlId}/conference
{ "to": "+12125550101" }
```

Response:
```json
{
  "thirdPartyCallControlId": "...",
  "originalCallControlId": "...",
  "message": "Third party is being dialed — will be bridged when they answer"
}
```

Show a toast: "Dialing +12125550101 — will connect when they answer."

---

## Notes / constraints

- Do NOT recreate Login, Dashboard, Campaigns, Leads, Call Logs, Voices, DNC, Users, or Settings pages.
- Keep all API calls going to `https://shivanshbackend.replit.app`.
- Auth token is always `localStorage.getItem("auth_token")`.
- If any endpoint returns `401`, redirect to `/login`.
- The softphone page is accessible to `agent` and `admin` roles.
- The callbacks page is accessible to all authenticated roles.
- Use `socket.io-client` for WebSocket — **not** native WebSocket.
- Telnyx WebRTC requires HTTPS (already satisfied by the Replit deployment).
- The `/calls/webrtc-token` endpoint creates a short-lived Telnyx telephony credential — call it fresh each session; do not cache across page reloads.
