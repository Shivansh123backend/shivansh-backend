# SHIVANSH — Wire Latest Backend Changes (Lovable Prompt)

## Critical rules — read before touching anything

- Backend: `https://shivanshbackend.replit.app` — never change this URL
- Auth token key: `localStorage.getItem("auth_token")` — NOT "token", NOT "jwt", never change
- All font: `font-mono` throughout (every element)
- Colour scheme: dark navy `hsl(222,47%,7%)`, primary cyan `hsl(183,100%,50%)`
- Do NOT recreate or rename: Login, Dashboard, Campaigns, Leads, Call Logs, DNC, Users, Settings, Voices pages
- Do NOT change routing, auth logic, or the api.ts helper if one already exists

---

## Shared API helper (add to `src/lib/api.ts` if not already there)

```ts
const BASE = "https://shivanshbackend.replit.app";

async function apiFetch(path: string, init?: RequestInit) {
  const token = localStorage.getItem("auth_token");
  const res = await fetch(`${BASE}/api${path}`, {
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

## Change 1 — Update Campaign create & edit form

### New fields to add

The campaign object now has two new fields. Add them to both the "Create Campaign" modal/form and the "Edit Campaign" form/drawer:

#### a) Voice Provider selector + Voice picker

```
Label: "Voice Provider"
Control: segmented button / radio group
Options:
  - "ElevenLabs"  value="elevenlabs"
  - "Cartesia"    value="cartesia"
Default: "elevenlabs"
```

When the selected provider changes, fetch the voice list:
```
GET /voices?provider=elevenlabs   →  array of voice objects
GET /voices?provider=cartesia     →  array of voice objects
```

Voice object shape:
```ts
{ voice_id: string, name: string, gender: "male"|"female", accent: "us"|"uk", description?: string }
```

Display as a `<select>` (or searchable dropdown) with option text:
`{name} — {gender} / {accent}` e.g. "Rachel — female / us"

When a voice is selected, save:
- campaign field `voice` = `voice_id`
- campaign field `voiceProvider` = selected provider string

Add a **▶ Preview** button next to the voice selector:
```
onClick:
  POST /voices/preview
  Body: { provider: selectedProvider, voice_id: selectedVoiceId, text: "Hi, this is a voice preview." }
  Response: { url: "https://..." }
  → new Audio(url).play()
```
Show a loading spinner while fetching. If it fails, show a toast error "Preview failed".

**Hardcoded catalog** (no need to fetch — use these for the dropdowns; fetch from API is the alternative):

ElevenLabs (provider = `elevenlabs`):
| voice_id | name | gender | accent |
|---|---|---|---|
| `21m00Tcm4TlvDq8ikWAM` | Rachel | female | us |
| `EXAVITQu4vr4xnSDxMaL` | Bella | female | us |
| `AZnzlk1XvdvUeBnXmlld` | Domi | female | us |
| `MF3mGyEYCl7XYWbV9V6O` | Elli | female | us |
| `TxGEqnHWrfWFTfGW9XjX` | Josh | male | us |
| `VR6AewLTigWG4xSOukaG` | Arnold | male | us |
| `pNInz6obpgDQGcFmaJgB` | Adam | male | us |
| `yoZ06aMxZJJ28mfd3POQ` | Sam | male | us |

Cartesia (provider = `cartesia`):
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

#### b) Voicemail Drop Message

```
Label: "Voicemail Drop Message"
Control: <textarea> rows=3, placeholder="Leave blank to hang up silently on voicemail"
Field name: vmDropMessage (string | null)
```

When AMD detects a voicemail beep on an outbound call, the backend automatically
plays this TTS message then hangs up. Leave empty to hang up silently.

### Save these fields

In create body: include `voiceProvider`, `voice`, `vmDropMessage` in the POST `/campaigns` body.
In update body: include them in the PATCH `/campaigns/:id` body.

```ts
// Example PATCH body
{
  voice: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
  voiceProvider: "cartesia",
  vmDropMessage: "Hi, we tried to reach you. Please call us back at your convenience. Goodbye!"
}
```

When loading an existing campaign to edit, pre-fill:
- voiceProvider from `campaign.voiceProvider` (default `"elevenlabs"`)
- voice from `campaign.voice`
- vmDropMessage from `campaign.vmDropMessage`

---

## Change 2 — Build `/callbacks` page

Add to sidebar: **Callbacks** (after Leads).
Show an amber dot badge on the nav item when there are overdue callbacks.

### Data fetch

```
GET /callbacks
```

Response is an array of callback objects:
```ts
{
  id: number
  name: string
  phone: string          // use this for display
  email: string | null
  campaignId: number
  campaignName: string | null
  status: string
  notes: string | null
  callbackAt: string | null   // ISO 8601
  createdAt: string
}
```

Auto-refresh every 60 seconds.

### Page layout

```
┌───────────────────────────────────────────────────────┐
│ SCHEDULED CALLBACKS                  [+ Schedule New] │
├──────────┬────────────┬──────────────┬──────────┬─────┤
│ Due At   │ Lead       │ Campaign     │ Notes    │ Act │
├──────────┼────────────┼──────────────┼──────────┼─────┤
│ 2:30 PM  │ John Smith │ Q2 Outbound  │ Follow up│[✏][✓]│
│ Tomorrow │ Jane Doe   │ Enterprise   │          │[✏][✓]│
└──────────┴────────────┴──────────────┴──────────┴─────┘
```

- Rows where `callbackAt` < now: highlight with `border-l-4 border-amber-400`
- Sort: overdue first, then ascending by callbackAt
- Empty state: `"No callbacks scheduled"`

### Actions

**[✏ Reschedule]** — opens a small modal:
```
Reschedule Callback for {name}
DateTime picker (pre-filled with current callbackAt)
Notes textarea (pre-filled)
[Cancel] [Save]
```
On save: `PATCH /callbacks/:id { callbackAt: ISO8601, notes }`

**[✓ Done]** — confirm dialog "Mark as complete?", then:
`PATCH /callbacks/:id { status: "completed" }`
→ remove row from list

**[+ Schedule New]** button — opens a modal:
```
Schedule Callback
Lead phone or name: [search input]
  → on input change, fetch: GET /leads?search={query}&status=pending
  → show dropdown of matching leads: "{name} — {phone}"
  → on select, store leadId
Date & Time: [datetime-local input]
Notes: [textarea optional]
[Cancel] [Schedule]
```
On submit: `POST /callbacks/schedule { leadId, callbackAt, notes }`
→ `201` → close modal, refresh list, show toast "Callback scheduled"

---

## Change 3 — Build `/softphone` page

Add to sidebar: **Softphone** (after Callbacks). Only visible to `admin` and `agent` roles.

### Layout (three columns)

```
┌──────────────────────────────────────────────────────────────┐
│  AGENT SOFTPHONE                    [● ONLINE ▼]             │
├─────────────────┬──────────────────────┬─────────────────────┤
│  MY STATS       │     DIALPAD          │   ACTIVE CALL       │
│  (today)        │                      │   (empty=idle)      │
│                 │  [+1 (555) 000-0000] │                     │
│  Calls: 12      │  [1][2][3]           │                     │
│  Avg:  4m 12s   │  [4][5][6]           │                     │
│  VM:   3        │  [7][8][9]           │                     │
│  Ans:  8        │  [*][0][#]           │                     │
│                 │  [⌫]  [✆ CALL]      │                     │
├─────────────────┴──────────────────────┴─────────────────────┤
│  CALLBACKS DUE TODAY                                          │
│  (same table as /callbacks but filtered to today/overdue)     │
└──────────────────────────────────────────────────────────────┘
```

### Status toggle

On mount: read `agentId` from `localStorage.getItem("auth_user")` parsed as JSON → `.id`.

```
GET /agents/stats?agentId={id}   → find own agent record
```

Show status pill: `● ONLINE` (green) / `● OFFLINE` (amber).
On toggle: `POST /agents/status { id: agentId, status: "available" | "busy" }`

### Stats panel (left column)

`GET /agents/stats?agentId={id}`

Find own entry in the array. Display:
- **Calls Today**: `stats.callsToday`
- **Avg Duration**: `stats.avgDuration` seconds → format as `Xm Ys`
- **VM**: `stats.dispositions.vm ?? 0`
- **Answered**: `stats.dispositions.interested ?? 0` + `stats.dispositions.connected ?? 0`

Auto-refresh: re-fetch when WebSocket fires `agent:stats:refresh`.

### Dialpad (centre column)

3×4 grid of digit buttons. Phone number input shows digits as typed.
Backspace clears last digit. Input accepts manual typing too.
`[✆ CALL]` button: large, cyan, font-mono bold.

On CALL pressed: store phone in state as `activeCallPhone`, set `callStatus = "dialing"`.

> **Note:** Actual WebRTC dial-out requires a Telnyx WebRTC token. Fetch it first:
> `GET /calls/webrtc-token` → `{ token }` then initialise `@telnyx/webrtc` SDK.
> If the SDK is not installed yet, show a placeholder in the active call panel:
> `"WebRTC dialling — connect via Telnyx"` and store the number. The WebRTC
> wiring can be added in a follow-up. Do not break the UI trying to import it.

### Active call panel (right column)

**Idle state:**
```
📵  No Active Call
Dial a number or wait for an inbound transfer
```

**Active state** (when a call is live — driven by WebSocket `call:started`):
```
📞 ACTIVE CALL
+1 (555) 000-0000
⏱ 02:14

[🔇 MUTE]  [⏸ HOLD]  [🔴 HANG UP]

── 3-WAY CONFERENCE ────────────────
Add phone:  [+1__________] [➕ ADD]

── LIVE TRANSCRIPT ─────────────────
[user]  Hi, I was told to call back…
[agent] Hello! Great to hear from you…

── DISPOSITION ─────────────────────
[✅ Interested] [❌ Not interested]
[📅 Callback]   [🚫 DNC]
```

**Conference (Add):**
```ts
// POST /calls/{callControlId}/conference
api.post(`/calls/${callControlId}/conference`, { to: thirdPartyNumber })
// Response: { thirdPartyCallControlId, message }
// Show toast: "Dialling {number} — will bridge when they answer"
```

**Hang up:** call `call.hangup()` on the Telnyx call object (or show confirmation modal).

**Disposition buttons:**
- Interested: `PATCH /call-logs` (find call log by callControlId) `{ disposition: "interested" }`
- Not interested: `{ disposition: "not_interested" }`
- Callback: open datetime picker → `POST /callbacks/schedule { leadId, callbackAt }`
- DNC: `POST /dnc { phoneNumber: activeCallPhone }`

### Callbacks due today (bottom strip)

```
GET /callbacks
```
Filter client-side to rows where `callbackAt` is today or in the past.
Show as a compact table: Due At | Lead | Phone | [📞 Dial].

[📞 Dial]: pre-fill dialpad with the lead's phone and set focus to CALL button.

### WebSocket subscription

```ts
import { io } from "socket.io-client";

const socket = io("https://shivanshbackend.replit.app", {
  auth: { token: localStorage.getItem("auth_token") },
  transports: ["websocket"],
});

socket.on("call:started", (data) => {
  // data: { id, callControlId, phoneNumber, campaignId }
  setCallControlId(data.callControlId);
  setActiveCallPhone(data.phoneNumber);
  setCallStatus("active");
  setCallStartedAt(Date.now());
});

socket.on("call:ended", () => {
  setCallStatus("idle");
  setCallControlId(null);
  refetchStats();
});

socket.on("call:transcript", (data) => {
  // data: { callControlId, speaker: "caller"|"agent", text }
  appendTranscript(data);
});

socket.on("agent:stats:refresh", () => refetchStats());

socket.on("agent:incoming_call", (data) => {
  // data: { callId, callerPhone, campaignId }
  showIncomingCallBanner(data);
});
```

**Incoming call banner** (top overlay, z-50):
```
📞 Incoming Call
Caller: {callerPhone}   Campaign: {campaignId}
[ANSWER]  [DECLINE]
```
ANSWER: close banner, set `activeCallPhone = callerPhone`, `callStatus = "active"`.
DECLINE: close banner.

---

## Change 4 — Add Human Agent stats panel to existing Agents page

If there is already an Agents page or section, add a stats sub-section:

```
GET /agents/stats
```

For each agent, display as a row/card:
```
John Smith    ● AVAILABLE
Calls today: 8   Avg dur: 3m 42s
Interested: 5   VM: 2   No ans: 1
```

The `agent:stats:refresh` WebSocket event should trigger a re-fetch.

---

## Change 5 — Sidebar nav additions

Add these two items in order (after Leads, before Settings):

```
📞  Softphone    /softphone
🔁  Callbacks    /callbacks
```

- Callbacks: show small amber badge when `callbacks.filter(c => new Date(c.callbackAt) < new Date()).length > 0`
- Both items: `font-mono`, same styling as existing nav items

---

## What NOT to change

- Login page and auth flow
- Dashboard KPIs
- Campaigns list/table
- Leads table and CSV upload
- Call Logs / CDR table
- DNC page
- Voices page (existing ElevenLabs voice management)
- Users page
- Settings page
- Any existing route handlers in api.ts

---

## Error handling rules

- Every `api.get/post/patch` call: wrap in try/catch
- On error: `toast.error(error.message ?? "Something went wrong")`
- On 401: the `apiFetch` helper already redirects — no extra handling needed
- Loading states: show a muted `"Loading…"` text or spinner, never blank
- Empty states: always show a friendly message, never null/undefined crash
