# Lovable Prompt — SHIVANSH Agent Softphone

Paste the block below into Lovable to scaffold a browser-based softphone for human agents to handle live transferred calls and outbound dials.

---

Build a **browser-based agent softphone** for SHIVANSH (an AI calling SaaS). It is a single-page React + TypeScript + Tailwind app that human call-center agents log into to handle live calls transferred from the AI, view caller context, and place outbound calls.

## Backend it talks to

A separate Express API is already deployed at `https://api.shivanshagent.cloudisoft.com`. Use it as `VITE_API_URL`. All requests need a Bearer JWT in `Authorization` (received from `POST /auth/login`). The API also runs a Socket.IO server at the same origin, namespace `/`, with a JWT handshake (`auth: { token }`).

Relevant endpoints (all return/accept JSON):
- `POST /auth/login` body `{ email, password }` → `{ token, user }`
- `GET /agents/stats` → per-agent today's calls, avg duration, disposition breakdown
- `GET /calls/live` → array of in-progress + queued calls
- `GET /calls/:id` → full call record (transcript, recordingUrl, summary, disposition)
- `POST /calls` body `{ phoneNumber, campaignId }` → place an outbound call
- `POST /calls/:callControlId/transfer` body `{ to }` → blind transfer
- `POST /calls/:callControlId/conference` body `{ to }` → 3-way conference
- `POST /calls/:callControlId/hangup` → end call
- `POST /agent-status` body `{ status }` where status ∈ `available | busy | break | offline`
- `GET /campaigns` → list campaigns (for the dial-out picker)
- `GET /callbacks` → leads with scheduled callbacks (table view)

Socket.IO events the UI must subscribe to:
- `call:started`, `call:ended`, `call:transferred`, `call:inbound`, `call:queued`
- `call:transcription` `{ callControlId, role: "agent"|"caller", text }` — append to transcript pane in real time
- `agent:stats:refresh` — refetch `/agents/stats`
- `agent_status` — refresh own status pill

## Pages / layout

Single page, three columns on desktop, stacked on mobile:

1. **Left column — Status & Stats**
   - Big avatar + agent name (from logged-in user)
   - Status selector (Available / Busy / Break / Offline) — calls `POST /agent-status` on change, updates a colored pill
   - Today's stat cards: Calls Handled, Avg Talk Time, Conversion Rate, Total Talk Time (from `/agents/stats`, refresh on `agent:stats:refresh`)
   - Recent calls list (last 10) with disposition badge

2. **Center column — Active Call Console**
   - When no active call: dial pad (T9-style number buttons, phone number input, campaign dropdown from `/campaigns`, big green "Call" button → `POST /calls`)
   - When a call is active: large caller info card (name, phone, campaign, region/timezone, lead notes), call timer counting up live, and **action buttons in a row**:
     - **Hold** (mute mic locally)
     - **Mute** (toggle mic)
     - **Transfer** — opens modal with phone-number input → `POST /calls/:id/transfer`
     - **Conference** — opens modal with phone-number input → `POST /calls/:id/conference`
     - **Hangup** (red, prominent) → `POST /calls/:id/hangup`
   - Below action buttons: **Live transcript pane** with role-colored bubbles (agent = blue right-aligned, caller = gray left-aligned). Auto-scroll to bottom on new `call:transcription` events.
   - Below transcript: **Disposition picker** (Sale, Callback, Not Interested, DNC, No Answer, Voicemail, Wrong Number) — submitted on hangup.

3. **Right column — Queue & Callbacks**
   - Tabs: "Live Queue" (from `/calls/live` + websocket updates) and "My Callbacks" (from `/callbacks`)
   - Each row: caller name, phone, wait time, campaign tag, "Pick up" button (only enabled for queued calls)
   - Live queue refreshes on `call:queued` / `call:ended` events.

## Audio

The actual call audio rides on the carrier (Telnyx) — the backend bridges it to the agent's deskphone or SIP endpoint. The softphone is for **call control + transcript viewing only**, not WebRTC voice. Do not attempt to capture mic audio or play remote audio in the browser.

Optional v2: WebRTC SIP via Telnyx WebRTC SDK. Stub it for now with a "Call audio: Connected to deskphone" indicator.

## Auth flow

- Public route `/login` with email + password fields → `POST /auth/login`, store `token` in `localStorage`, set `Authorization` header on every fetch via an `apiClient.ts` wrapper.
- All other routes require a token; redirect to `/login` if missing or 401.
- Logout button in the top-right header → clear token, disconnect socket, redirect.

## Stack

- React 18 + Vite + TypeScript
- TailwindCSS + shadcn/ui (Card, Button, Dialog, Tabs, Badge, Input, Select)
- `socket.io-client` for the realtime channel
- `@tanstack/react-query` for HTTP state, with auto-invalidation on websocket events
- `lucide-react` icons (Phone, PhoneOff, PhoneForwarded, Users, Mic, MicOff, Pause)
- `date-fns` for time formatting

## Design

- Dark, professional, low-distraction (think Aircall / Dialpad)
- Slate/zinc background, single accent color (emerald for "available" / "good", red for "hangup" / "do not call")
- Generous spacing in the call console — agent's eye should snap to the caller name and the hangup button instantly
- Make the active-call view feel **alive**: animated talk-timer, transcript bubbles fading in, status pulse dot
- Mobile: bottom-nav with three icons (Phone, Queue, Stats), call console takes the full screen when active

## Acceptance

When the agent logs in, they see their stats, can change status, and the queue starts populating in real time. Clicking "Pick up" on a queued call swaps the center pane to the active-call console with the live transcript streaming. Hangup writes the disposition and returns them to the dial pad. Conference and transfer modals work end-to-end.
