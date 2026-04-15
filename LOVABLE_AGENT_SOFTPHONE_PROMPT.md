# Lovable Prompt — SHIVANSH Agent Softphone

Paste the block below verbatim into Lovable as a new project prompt.

---

## PROMPT

Build a **production-grade browser softphone** for human call-centre agents named **SHIVANSH Agent**.

### Tech stack
- React 18 + TypeScript + Vite
- Tailwind CSS — dark navy background only (`#0a0f1e`), accent `hsl(183 100% 50%)` (cyan)
- All text in `font-mono`
- Shadcn/ui for UI primitives (use dark theme)
- Socket.IO client v4 for real-time events
- Telnyx WebRTC SDK (`@telnyx/webrtc`) for browser audio

### Backend
- Base URL: `https://shivanshbackend.replit.app`
- Auth header: `Authorization: Bearer <token>` where token is read from `localStorage.getItem("auth_token")`
- WebSocket: connect to `https://shivanshbackend.replit.app` with path `/api/ws` and `auth: { token }`

### Auth flow (login page)
- POST `https://shivanshbackend.replit.app/api/auth/login` with `{ email, password }`
- Response: `{ token, user: { id, name, email, role } }`
- Store token in `localStorage` under key `auth_token`, user under `auth_user`
- Default agent credentials: `agent@shivansh.com` / `Agent@123`
- Redirect to softphone dashboard on success

### Pages / layout
Single-page app with a top nav showing: agent name, status badge (green = Available, red = Busy), and a logout button.

---

### Main softphone panel (centre of screen)

#### 1. Agent status toggle
- Toggle between **Available** and **Busy**
- On change: `POST /api/agents/status` with `{ id: agentId, status }`
- Update badge in nav immediately

#### 2. Incoming call banner (appears when `call:inbound` WebSocket event fires)
Fields in the event: `{ callId, callControlId, callerNumber, campaignName }`
- Full-width yellow banner slides in from top
- Shows caller number and campaign name
- Two buttons: **Answer** (green) — calls `POST /api/calls/inbound` with `{ callControlId, action: "answer" }` — and **Reject** (red) — calls `POST /api/calls/inbound` with `{ callControlId, action: "reject" }`
- Banner auto-dismisses after 30 s if not acted on

#### 3. Active call card (visible while a call is live)
Shown when the agent has an active call. Data from `call:started` or `call:inbound` WebSocket events.
- Caller number, campaign name
- Live call timer (counting up from 00:00)
- Four action buttons:
  - **Mute / Unmute** — toggles microphone via Telnyx WebRTC SDK
  - **Hold** — `POST /api/calls/transfer` with `{ callControlId, action: "hold" }` (or use SDK hold)
  - **Transfer** — opens a small popover with a phone number input; on confirm calls `POST /api/calls/transfer` with `{ callControlId, to: number }`
  - **Conference** — opens a popover with a phone number input; on confirm calls `POST /api/calls/:callControlId/conference` with `{ to: number }`
- **Hang up** button (red, full-width at bottom of card)

#### 4. Dial pad
Visible below the active call card (or always visible when no call is active).
- Standard 12-key pad (0-9, *, #) plus a display input showing the typed number
- **Call** button: `POST /api/calls/initiate` with `{ to: dialedNumber, from: agentPhoneNumber }`
- **Clear** button resets the input

#### 5. Live transcription feed
Scrollable log that shows `call:transcription` WebSocket events in real time.
- Each line: `[Caller | AI]  <text>`
- Auto-scrolls to bottom
- Clears when call ends (`call:ended` event)

---

### Right sidebar — Queue & Recent Calls

#### Queue panel
- Lists callbacks due soon: `GET /api/callbacks?campaignId=<current>`
- Each row: lead name, phone, scheduled time, **Dial** button
- Refreshes every 30 s

#### Recent calls
- `GET /api/calls/cdr?limit=20`
- Each row: caller number, duration, disposition, timestamp
- Disposition chip colour: `connected` = green, `no_answer` = yellow, `failed` = red, `transferred` = cyan

---

### WebSocket events to handle

| Event | Action |
|---|---|
| `call:started` | Show active call card, start timer |
| `call:inbound` | Show incoming call banner |
| `call:transcription` | Append to transcription feed |
| `call:ended` | Hide active call card, stop timer, clear transcript, refresh recent calls |
| `call:transferred` | Update active call card to show "Transferred" badge |
| `agent:stats:refresh` | Refetch `/api/agents/stats` and update agent's own stats row |

---

### Per-agent stats strip (bottom of left panel)
Fetched from `GET /api/agents/stats`, filtered to the logged-in agent's id.
Display in a strip of 3 tiles:
- **Calls Today** — `stats.callsToday`
- **Avg Duration** — `stats.avgDuration` seconds formatted as `Mm Ss`
- **Top Disposition** — the disposition key with the highest count from `stats.dispositions`

---

### Telnyx WebRTC integration
1. On login, fetch a WebRTC token: `GET /api/calls/webrtc-token`
2. Response: `{ token, sipUsername }`
3. Initialise `TelnyxRTC` with `{ login_token: token }`
4. On `call.incoming` SDK event → show incoming call banner if not already shown via WebSocket
5. On `call.answered` SDK event → start timer
6. On `call.hangup` SDK event → clear active call card

---

### Style rules
- Background `#0a0f1e` everywhere
- Cards: `bg-slate-900 border border-slate-700 rounded-xl`
- Accent colour `hsl(183 100% 50%)` for buttons, active states, timers
- All fonts `font-mono`
- Buttons: rounded-lg, px-4 py-2, transition-all
- No light mode; no toggle

### Error handling
- All API calls wrapped in try/catch; show a dismissable toast (`Sonner`) on error
- If WebSocket disconnects, show a yellow reconnecting banner and retry every 5 s

### Deliverable
A fully functional single-page React app. No placeholder data — every widget reads from the real SHIVANSH backend.
