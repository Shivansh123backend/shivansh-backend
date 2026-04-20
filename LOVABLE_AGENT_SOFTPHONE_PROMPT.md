# LOVABLE PROMPT — Browser-Based Agent Softphone

Add a **WebRTC softphone** to the SHIVANSH agent dashboard. Agents log in, register to Telnyx WebRTC, and handle inbound + outbound calls fully in the browser. **Do NOT modify any existing UI or design tokens — match the current theme.**

Backend: `https://shivanshbackend.replit.app`
Auth header: `Authorization: Bearer ${localStorage.getItem("auth_token")}`

---

## ROUTE
`/agent/softphone` (agent role only — admins can also access)

Add a sidebar entry "Softphone" with a phone icon under "Agent Workspace".

---

## DEPENDENCIES TO INSTALL
- `@telnyx/webrtc` (official Telnyx browser SDK)

---

## BACKEND ENDPOINTS YOU CAN USE
- `GET /api/calls/webrtc-token` — returns `{ token: string }` (a Telnyx JWT for WebRTC login)
- `GET /api/agents/stats` — returns `{ agentId, name, stats: { callsToday, avgDuration, dispositions } }[]`
- `POST /api/calls/:callControlId/conference { to }` — adds a third party to active call (3-way)
- `POST /api/calls/transfer { callId, campaignId }` — transfers to another agent
- `POST /api/callbacks/schedule { leadId, callbackAt, notes? }` — schedule a callback
- `PATCH /api/calls/:id { disposition, notes }` — set disposition after the call
- `GET /api/leads?phone=...` — lookup lead by phone
- WebSocket: `wss://shivanshbackend.replit.app/ws` — listens for `agent:incoming_call` events

---

## LAYOUT — single page, 3 columns

### LEFT COLUMN (320px) — Dialer & Status
- **Status pill at top:** "Ready" (green) / "On Call" (blue) / "Wrap-Up" (orange) / "Offline" (gray). Click to toggle ready/offline.
- **Dial pad:** 12-key grid (1-9, *, 0, #) + a phone-number input above it
- **Call button:** big green circle with phone icon. Disabled when not registered.
- **Recent contacts list** below: last 10 calls (number, time, disposition badge, click to redial)

### CENTER COLUMN (flex) — Active Call Panel
When **idle:** show empty state with a headset illustration + "Waiting for calls" text.

When **call is active or ringing:**
- Large caller info card:
  - Caller phone (formatted)
  - Caller name (from `/api/leads?phone=...` lookup, or "Unknown")
  - Campaign name
  - Call timer (mm:ss, ticking)
  - Direction badge (Inbound / Outbound)
- **Action button row** (large, color-coded):
  - **Answer** (green) — only on incoming
  - **Hang Up** (red)
  - **Mute** (toggle, gray ↔ blue)
  - **Hold** (toggle)
  - **Transfer** — opens dropdown of available agents, calls `POST /calls/transfer`
  - **Conference** — opens input for third-party number, calls `POST /calls/:callControlId/conference`
  - **Keypad** — opens overlay dial pad for DTMF tones
- **Live transcript area** (if available via WebSocket `transcript:partial` event) — scrolling text panel with speaker labels

When **call ends:** show **Wrap-Up panel**:
- Disposition dropdown: interested / not_interested / vm / no_answer / busy / connected / transferred / disconnected
- Notes textarea
- "Schedule callback?" toggle → datetime picker → calls `POST /callbacks/schedule`
- **Save & Ready** button → PATCH disposition + sets agent back to Ready
- **Discard** button → goes back to Ready without saving

### RIGHT COLUMN (320px) — Today's Stats + Lead Context
- **Stats card** (polled from `GET /agents/stats` every 30s — match the current row to logged-in agent):
  - Calls Today (number)
  - Avg Duration (mm:ss)
  - Disposition breakdown (mini horizontal bar chart)
- **Lead context card** (only shown during active call) — pulled from `/api/leads?phone=...`:
  - Name, email, campaign
  - Last 3 call dispositions
  - Notes (read-only)
  - Predicted intent badge (high/medium/low)
  - Lifecycle stage badge

---

## BEHAVIOR

### Registration flow
1. On mount, fetch `GET /api/calls/webrtc-token`
2. Initialize `TelnyxRTC` client with the token
3. On `telnyx.ready` → set status to "Ready"
4. On `telnyx.error` → show toast "Phone offline" and a Retry button

### Incoming call
1. Telnyx SDK fires `notification` event with `call.state === "ringing"`
2. Play ringtone (browser audio element looping a short tone)
3. Show "Incoming Call" card with caller info, big Answer / Reject buttons
4. Backend WebSocket may also push `agent:incoming_call` with extra context (campaignId, transferType) — merge it in.

### Outgoing call
1. User types number + clicks call button
2. `telnyx.newCall({ destinationNumber, callerNumber })`
3. Show active call panel; status → "On Call"

### Transfer / Conference / DTMF
- Transfer: closes current call after transfer succeeds
- Conference: keeps both legs; show "3-way" badge on call panel
- DTMF: call.dtmf("1"/"2"/etc) on Telnyx call object

### After hangup
- Status → "Wrap-Up" automatically
- Force the agent to pick a disposition before going back to Ready (block the "Save & Ready" button until disposition selected)

### Microphone permission
- Request on first call attempt; if denied show a clear error card with retry instructions

---

## STRICT RULES

1. **Do not modify any existing component, color, font, or theme.** Match the current dark dashboard exactly — same Card, Badge, Button, Input, Dialog, Select components already in the codebase.
2. **No new color tokens.** Use existing semantic colors (success/destructive/warning/muted).
3. **Auth on every fetch:** `Authorization: Bearer ${localStorage.getItem("auth_token")}`
4. **Mobile responsive:** 3 columns collapse to a single stacked column under `md` breakpoint.
5. **Errors → existing toast system.**
6. **Loading → existing skeleton loaders.**
7. **Audio:** use the SDK's auto-attached audio element (don't roll your own).
8. **State management:** keep all softphone state in a single `useSoftphone()` hook so the rest of the app can show "On Call" indicators if needed.

---

## OPTIONAL POLISH
- Persistent floating "On Call" mini-bar at the bottom of every dashboard page when a call is active (so agents can navigate away and still see/control the call).
- Browser notifications on incoming call (with permission prompt).
- Hotkeys: Space = answer/hangup, M = mute, H = hold.

---

That's it. Build only this softphone page + sidebar link + the optional mini-bar. Do not touch anything else.
