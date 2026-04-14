# LOVABLE WIRING PROMPT — SHIVANSH Agent Softphone + Stats

Paste this entire block as a single Lovable message.

---

## Context

Backend: `https://shivanshbackend.replit.app`
Auth header: `Authorization: Bearer ${localStorage.getItem("auth_token")}`
All calls are authenticated unless stated otherwise.
Primary colour: `hsl(183,100%,50%)` — cyan/teal. Dark navy background only. All text `font-mono`.

---

## SECTION A — Agent Softphone Page (`/softphone`)

### Purpose
Browser-based SIP/WebRTC softphone for human agents. Agents can receive transferred calls, dial outbound numbers, and see their current call stats — all without leaving the browser.

---

### A1 — Page Layout

Full-height dark navy page. Two columns on desktop, stacked on mobile.

**Left column (40%)** — Softphone dialler:
- Numeric keypad (0–9, *, #) — large tactile buttons, font-mono, white text on dark card
- Phone number input at top — large monospace display, value updates on keypad press
- Four action buttons below keypad:
  - `CALL` — primary cyan, places outbound call
  - `HANG UP` — red, ends active call
  - `HOLD` — amber, toggles hold
  - `MUTE` — slate, toggles mic mute
- Status indicator below buttons: animated dot + label — `Idle` / `Ringing` / `Connected` / `On Hold`
- Duration timer: shows `00:00` when idle, counts up when connected
- Transfer button (appears only when connected): opens small modal with a phone input + `Transfer` button

**Right column (60%)** — Agent stats panel:

#### Today's Stats (header row of 3 cards):
| Card | API field | Format |
|------|-----------|--------|
| Calls Today | `stats.callsToday` | integer |
| Avg Duration | `stats.avgDuration` | seconds → `m:ss` |
| Transfer Rate | `stats.dispositions.transferred / callsToday` | percentage |

#### Disposition Breakdown (horizontal bar chart):
Bars for each disposition key present in `stats.dispositions`:
- `interested` → green
- `not_interested` → red
- `transferred` → cyan
- `vm` → amber
- `no_answer` → slate
- `busy` → orange
- `connected` → blue

#### Agent Status Toggle:
Pill selector: `Available` | `Busy` — clicking calls `POST /api/agents/status` (see A3).
Current status shown as coloured dot next to agent name at top of panel.

---

### A2 — Data Fetching

**Load agent list + stats on mount:**
```
GET /api/agents/stats
→ Array<{
    id: number,
    name: string,
    phone_number: string,
    status: "available" | "busy",
    current_call: any | null,
    stats: {
      callsToday: number,
      avgDuration: number,   // seconds
      dispositions: Record<string, number>
    }
  }>
```
Display the currently logged-in agent's row (match by name or show all if admin).
Refresh every 30 seconds OR when WebSocket emits `"agent:stats:refresh"`.

**WebRTC token for softphone:**
```
GET /api/calls/webrtc-token
→ { token: string }
```
Use this token to initialise the Telnyx WebRTC client (see A4).

**WebSocket (already connected globally):**
Listen for `"agent:incoming_call"` → ring notification + auto-populate the caller's number in the dialler display.

---

### A3 — Status Toggle API

```
POST /api/agents/status
Body: { id: number, status: "available" | "busy" }
→ { id, name, phone_number, status }
```

---

### A4 — WebRTC Dialler Integration

Use the Telnyx WebRTC Browser SDK (`@telnyx/webrtc`). The token from `GET /api/calls/webrtc-token` is the credential.

```typescript
import { TelnyxRTC } from "@telnyx/webrtc";

const client = new TelnyxRTC({ login_token: token });
client.connect();

client.on("telnyx.ready", () => setStatus("Idle"));
client.on("telnyx.notification", (notification) => {
  if (notification.type === "callUpdate") {
    const call = notification.call;
    if (call.state === "ringing") setStatus("Ringing");
    if (call.state === "active")  setStatus("Connected");
    if (call.state === "hangup")  setStatus("Idle");
  }
});

// Place call:
const call = client.newCall({ destinationNumber: phoneInput, callerNumber: agentPhoneNumber });

// Hang up:
activeCall?.hangup();

// Hold:
activeCall?.hold();   // or .unhold()

// Transfer:
activeCall?.transfer({ destinationNumber: transferTarget });
```

If `@telnyx/webrtc` is not installed, add it: `npm install @telnyx/webrtc`.

---

### A5 — Incoming Call Notification

When WebSocket fires `"agent:incoming_call"`:
1. Show a modal/toast at top of page: **"Incoming Transfer — [callerPhone]"**
2. Auto-fill dialler display with the caller's phone number
3. Play a short ring sound (use the browser Audio API — 440Hz oscillator for 2 seconds if no MP3)
4. Show `ANSWER` button — clicking sets status to Connected and starts timer
5. Auto-dismiss after 30s if not answered

---

### A6 — Scheduled Callbacks Panel (bottom of right column)

Fetch all pending callbacks:
```
GET /api/callbacks
→ Array<{
    id, name, phone, phone_number, email,
    campaignId, campaignName, status,
    callbackAt, callback_at, notes
  }>
```

Display as a table:
| Lead Name | Phone | Campaign | Scheduled Time | Notes | Action |
|-----------|-------|----------|----------------|-------|--------|
| ...       | ...   | ...      | formatted datetime | ... | `Call` button |

`Call` button → pre-fills the softphone dialler with that lead's number and auto-initiates the call.

To reschedule a callback:
```
PATCH /api/callbacks/:id
Body: { callbackAt: ISO8601, notes?: string }
```

To mark complete:
```
PATCH /api/callbacks/:id
Body: { status: "completed" }
```

---

## SECTION B — Campaign Form: Voicemail Drop + Calling Hours

In the Create/Edit Campaign form, add two new sections:

### B1 — Voicemail Drop

Below the "Transfer Number" field:

```
Label: Voicemail Drop Message (optional)
Textarea: placeholder "Leave a message when the call goes to voicemail..."
Field name: vmDropMessage
```

If set, the AI will automatically speak this message and hang up when it detects a voicemail beep (AMD). Leave blank to hang up silently on voicemail.

API: included in existing `POST /api/campaigns` / `PATCH /api/campaigns/:id` body as `vmDropMessage`.

### B2 — TCPA Calling Hours

Below the "Dialling Mode" section:

```
Label: Calling Hours (TCPA Compliance)
Row: [Start Time HH:MM] [End Time HH:MM] [Timezone dropdown]
Field names: workingHoursStart, workingHoursEnd, workingHoursTimezone
Default: 08:00 — 21:00, UTC
Note text: "Leads outside these hours in their local timezone are automatically skipped."
```

Timezone dropdown options (at minimum):
- UTC, US/Eastern, US/Central, US/Mountain, US/Pacific, US/Alaska, US/Hawaii
- Europe/London, Europe/Paris, Europe/Berlin, Australia/Sydney, Asia/Kolkata

API: included in existing campaign create/update body.

---

## SECTION C — 3-Way Conference Button (Live Calls Table)

In the Live Calls table (wherever active calls are shown), add a `Conference` icon button per row.

Clicking it opens a small modal:
```
Title: "Add to Conference Call"
Input: phone number (E.164 format)
Button: "Dial In" (primary cyan)
```

On submit:
```
POST /api/calls/:callControlId/conference
Body: { to: "+1XXXXXXXXXX" }
→ { thirdPartyCallControlId, originalCallControlId, message }
```

Show a success toast: "Third party is being dialled — they'll be bridged when they answer."

---

## SECTION D — Sidebar Navigation Update

Add `/softphone` to the sidebar nav:

```
Icon: Phone (Lucide PhoneCall)
Label: Softphone
Path: /softphone
Visible to: agent role AND admin role
```

Place it directly below "Callbacks" in the nav order.

---

## SECTION E — Agent Stats in Agents Table

The Agents management page (`/agents`) already lists agents. Enhance each row with live stats from `GET /api/agents/stats`:

| Column | Source |
|--------|--------|
| Calls Today | `stats.callsToday` |
| Avg Duration | `stats.avgDuration` formatted as `m:ss` |
| Top Disposition | most frequent key in `stats.dispositions` |
| Status | coloured pill — green=available, red=busy |

Add a `Refresh` button at top right of table that re-fetches `GET /api/agents/stats`.

---

## Summary of API Endpoints Used

| Method | URL | Purpose |
|--------|-----|---------|
| GET | `/api/agents/stats` | Per-agent stats (callsToday, avgDuration, dispositions) |
| POST | `/api/agents/status` | Toggle agent available/busy |
| GET | `/api/calls/webrtc-token` | Telnyx WebRTC credential token |
| GET | `/api/callbacks` | List pending callbacks |
| PATCH | `/api/callbacks/:id` | Update callback status/time |
| POST | `/api/calls/:callControlId/conference` | 3-way conference dial |
| GET | `/api/campaigns` | Campaign list (for callback campaign names) |
| PATCH | `/api/campaigns/:id` | Update campaign (vmDropMessage, workingHours) |

---

## Style Rules (apply everywhere)

- Background: `#0a0f1e` (dark navy)
- Primary accent: `hsl(183,100%,50%)` — cyan
- All text and numbers: `font-mono`
- Cards: `bg-slate-900 border border-slate-800 rounded-xl`
- Inputs: `bg-slate-800 border-slate-700 text-white font-mono`
- Status dots: `w-2 h-2 rounded-full` — green `#22c55e` available, red `#ef4444` busy
- Animations: subtle pulse on active call status indicator
- No white backgrounds anywhere — dark navy only

---

End of softphone prompt.
