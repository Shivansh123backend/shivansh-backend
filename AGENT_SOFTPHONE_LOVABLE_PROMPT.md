# SHIVANSH Agent Softphone — Lovable Build Prompt

## Project Overview

Build a browser-based **Agent Softphone** for SHIVANSH — an AI-powered outbound calling SaaS. This app is used by **human call-center agents** who receive live transfers from an AI dialer. The softphone is a control panel + dashboard for the agent:

- See real-time call activity the moment a transfer comes in
- Manage their availability status
- Dial prospects manually
- Handle callback leads
- View their personal daily stats

The actual voice call routes to the agent's registered phone number (PSTN/SIP). This UI is the **control surface** running in their browser while they talk on their desk phone or headset.

---

## Backend Connection

- **API Base URL**: `https://shivanshbackend.replit.app/api`
- **WebSocket**: `https://shivanshbackend.replit.app` with Socket.IO path `/api/ws`
- **Auth**: JWT stored in `localStorage` under the key **`auth_token`** (exact key — no variation)
- **Test agent credentials**: `agent@shivansh.com` / `Agent@123`

All API requests must include the header:
```
Authorization: Bearer <auth_token>
```

---

## Design System

- **Primary accent**: `hsl(183, 100%, 50%)` — a vivid cyan/teal
- **Background**: Dark navy `#050d1a` with card surfaces at `#0d1b2e`
- **Font**: `font-mono` everywhere — JetBrains Mono or IBM Plex Mono (Google Fonts)
- **Borders**: `rgba(0,255,255,0.12)` for cards, `rgba(0,255,255,0.3)` for active elements
- **Status colours**:
  - Available → `#00ffc3` (green-cyan)
  - Busy → `#ff4d6d` (red)
  - On-call → `hsl(183, 100%, 50%)` (primary)
- **Shadows**: `0 0 20px rgba(0,255,255,0.08)` on cards
- **Compact, dense layout** — agents need to scan quickly

---

## Auth Flow

### Login Page

Full-screen dark background. Center-aligned card (400px wide):
- SHIVANSH logo text in primary cyan, `font-mono text-2xl font-bold`
- Subtitle: `AGENT PORTAL` in muted small caps
- Email input + Password input (standard styling)
- "Sign In" button in primary cyan
- On success: `POST /api/auth/login` body `{ email, password }` → `{ token, user }`
  - Store `token` in `localStorage` as `auth_token`
  - Store `user` in `localStorage` as `auth_user` (JSON)
  - Redirect to main softphone view
- On 401: show "Invalid credentials" error inline

---

## Main Layout (post-login)

Three-column layout on desktop, stacked on mobile:

```
┌─────────────────────────────────────────────────────────┐
│  SHIVANSH  •  [Agent Name]  •  [●AVAILABLE ▼]  •  Logout│
├──────────┬──────────────────────────┬───────────────────┤
│  DIAL    │   ACTIVE CALL / IDLE     │   MY STATS        │
│  PAD     │   PANEL                  │                   │
│          ├──────────────────────────┤                   │
│  QUICK   │   CALLBACK QUEUE         │   RECENT CALLS    │
│  ACTIONS │                          │                   │
└──────────┴──────────────────────────┴───────────────────┘
```

---

## Component Specifications

### 1. Header Bar

- Left: `SHIVANSH` logo (primary cyan) + `· AGENT SOFTPHONE` (muted)
- Center: Agent display name from `auth_user`
- Right:
  - **Status Toggle**: Pill button showing current status (●AVAILABLE green or ●BUSY red). Click opens dropdown with "Set Available" / "Set Busy" options.
    - `POST /api/agents/status` body `{ id: agentId, status: "available"|"busy" }`
    - The agent's numeric `id` comes from `GET /api/agents` filtered by their email
  - **Logout**: Clears localStorage, redirects to login

---

### 2. Left Column — Dial Pad + Quick Actions

**Manual Dial Pad** (full DTMF keypad):
- 12-key grid: 1-9, *, 0, #
- Display input showing the number being typed (backspace icon to clear)
- Green "CALL" button at bottom
- On CALL pressed: `POST /api/calls/manual` body `{ to: "<typed_number>", campaignId: null }`
  - If 404 or not configured, show toast: "No outbound number configured for your account"
  - On success: show "Dialing..." banner that auto-dismisses after 5s
- Number can also be typed directly in the display input (supports paste)

**Quick Action Buttons** (below dial pad):
- `📞 CALLBACKS` — scrolls to callback queue section
- `📊 MY STATS` — scrolls to stats panel
- `🔄 REFRESH` — re-fetches all data

---

### 3. Center Column Top — Active Call Panel

This panel shows the current live call state. It has two sub-states:

#### When IDLE (no active call):

```
┌─────────────────────────────┐
│  ○  NO ACTIVE CALL          │
│                             │
│  Waiting for transfer...    │
│  Status: AVAILABLE          │
└─────────────────────────────┘
```

Minimal card, muted text, animated pulsing dot when available.

#### When ON A CALL (Socket.IO event `call:started` received):

```
┌─────────────────────────────────────────────────────┐
│  🔴 LIVE  ·  00:02:34                               │
├─────────────────────────────────────────────────────┤
│  Lead:     JOHN DOE                                 │
│  Phone:    +1 (555) 234-5678                        │
│  Campaign: Q1 Outreach                              │
├─────────────────────────────────────────────────────┤
│  [ MUTE ]  [ HOLD ]  [ CONFERENCE ]  [ 🔴 HANG UP ] │
├─────────────────────────────────────────────────────┤
│  Disposition:  [ Select... ▼ ]                      │
│  Notes:        [ Free text area........................]│
│                             [ SAVE NOTES ]          │
└─────────────────────────────────────────────────────┘
```

- **Duration timer**: counts up from 00:00 using `setInterval` since `call.started_at`
- **Caller info**: populated from the Socket.IO `call:started` event payload
- **MUTE / HOLD**: visual-only state toggles (actual call controls happen on their desk phone; these are for note-taking context)
- **CONFERENCE button**: opens a small modal with a phone number input → `POST /api/calls/:callControlId/conference` body `{ to: "<number>" }`
- **HANG UP**: `DELETE /api/calls/:callControlId` or show instruction "Please hang up on your desk phone"
- **Disposition dropdown** options: `interested`, `not_interested`, `callback`, `no_answer`, `voicemail`, `do_not_call`
- **SAVE NOTES**: `PATCH /api/callbacks/:leadId` body `{ notes: "<text>", status: <disposition> }` if it's a callback lead

Socket.IO events to listen for (connect at `https://shivanshbackend.replit.app`, path `/api/ws`, with `auth: { token: <auth_token> }`):
- `call:started` → `{ callControlId, phone_number, campaign_name, lead_name?, started_at }` → show active call panel
- `call:ended` → `{ callControlId, duration, disposition }` → hide active call panel, flash summary toast
- `agent_status` → `{ agent_id, status }` → update status indicator if it matches current agent

---

### 4. Center Column Bottom — Callback Queue

**Header**: `SCHEDULED CALLBACKS (n)` with refresh button

Fetches: `GET /api/callbacks` → array of callback leads

Each callback row:
```
┌─────────────────────────────────────────────────────┐
│  JOHN DOE  •  +1 555 234 5678  •  Q1 Campaign       │
│  📅 Due: TODAY 2:30 PM  •  Notes: "Call after 2pm"  │
│  [ CALL NOW ]  [ RESCHEDULE ]  [ DISMISS ]          │
└─────────────────────────────────────────────────────┘
```

- Callbacks due in the past are highlighted red
- Callbacks due within 30 minutes are highlighted amber
- **CALL NOW**: Triggers `POST /api/calls/manual` with that lead's phone number
- **RESCHEDULE**: Opens a datetime picker → `POST /api/callbacks/schedule` body `{ leadId, callbackAt: <ISO string> }`
- **DISMISS**: `PATCH /api/callbacks/:id` body `{ status: "pending" }` → removes from callback queue

---

### 5. Right Column Top — My Stats

Fetches: `GET /api/agents/stats` → find the object matching the agent's id

Displays:
```
┌─────────────────────────────┐
│  MY STATS — TODAY           │
├─────────────────────────────┤
│  Calls Handled:  12         │
│  Avg Duration:   3m 24s     │
├─────────────────────────────┤
│  DISPOSITIONS               │
│  ▓▓▓▓▓░░░ interested  (5)  │
│  ▓▓░░░░░░ callback    (3)  │
│  ▓░░░░░░░ not_interested(2)│
│  ▓░░░░░░░ voicemail   (2)  │
└─────────────────────────────┘
```

- Disposition bars are simple horizontal fill bars in primary cyan
- Refresh when Socket.IO fires `agent:stats:refresh`

---

### 6. Right Column Bottom — Recent Calls

Fetches: `GET /api/call-logs?limit=10` (or `GET /api/calls/logs` depending on what endpoint exists — use whichever returns `{ phone_number, disposition, duration, created_at, campaign_name }`)

Actually use: `GET /api/call-logs` with header `Authorization: Bearer <auth_token>`

Each row:
```
+1 555 234 5678  ·  Q1 Campaign  ·  3m 24s  ·  interested  ·  2:34 PM
```

- Max 10 entries
- Disposition colored: interested=green, not_interested=red, callback=amber, voicemail=muted
- Clicking a row copies the phone number to clipboard (shows "Copied!" toast)

---

## Real-Time WebSocket Integration

```typescript
import { io } from "socket.io-client";

const socket = io("https://shivanshbackend.replit.app", {
  path: "/api/ws",
  auth: { token: localStorage.getItem("auth_token") },
  transports: ["websocket"],
});

socket.on("connect", () => console.log("Connected to SHIVANSH backend"));
socket.on("call:started", (data) => { /* show active call panel */ });
socket.on("call:ended",   (data) => { /* clear active call panel, show summary */ });
socket.on("agent_status", (data) => { /* update status badge */ });
socket.on("agent:stats:refresh", () => { /* re-fetch /api/agents/stats */ });
```

---

## Error Handling

- All API calls: if 401, clear localStorage and redirect to login
- If Socket.IO disconnects, show a small amber "Reconnecting..." banner at top
- If `GET /api/agents` returns no agent matching the logged-in email, show "Agent profile not found. Contact your admin." message

---

## Responsive Behaviour

- **Desktop (>1200px)**: Full 3-column layout as described
- **Tablet (768–1200px)**: 2 columns (left + center merged, right below)
- **Mobile (<768px)**: Single column, active call panel pinned at top

---

## Tech Stack

- **React 18** + **TypeScript**
- **Tailwind CSS** (dark mode default)
- **Socket.IO client** (`npm install socket.io-client`)
- **date-fns** for time formatting
- **React Query** or `useState/useEffect` for data fetching
- No external UI library required — custom components with Tailwind

---

## File Structure Suggestion

```
src/
  components/
    ActiveCallPanel.tsx
    CallbackQueue.tsx
    DialPad.tsx
    Header.tsx
    MyStats.tsx
    RecentCalls.tsx
    ConferenceModal.tsx
  pages/
    Login.tsx
    Softphone.tsx
  hooks/
    useSocket.ts
    useAgentId.ts
    useStats.ts
  lib/
    api.ts          (axios instance with auth header)
    constants.ts    (API_BASE, WS_URL, SOCKET_PATH)
  App.tsx
```

---

## Constants

```typescript
export const API_BASE    = "https://shivanshbackend.replit.app/api";
export const WS_URL      = "https://shivanshbackend.replit.app";
export const SOCKET_PATH = "/api/ws";
export const TOKEN_KEY   = "auth_token";
export const USER_KEY    = "auth_user";
```

---

## MVP Acceptance Criteria

1. Agent can log in with `agent@shivansh.com` / `Agent@123`
2. Agent can toggle their status between Available and Busy
3. When a `call:started` Socket.IO event fires, the Active Call Panel appears with the caller's info and a live duration timer
4. When `call:ended` fires, the panel clears and a toast shows "Call ended — 2m 34s · interested"
5. Agent can use the dial pad to manually call any number
6. Callback queue shows due callbacks with CALL NOW / RESCHEDULE / DISMISS actions
7. My Stats panel shows calls today, avg duration, and disposition bar chart
8. App reconnects automatically if WebSocket drops
