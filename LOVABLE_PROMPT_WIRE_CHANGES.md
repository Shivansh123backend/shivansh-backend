# SHIVANSH — Final Lovable Wiring Prompt

Paste this entire document into Lovable as a single message.

---

## Non-negotiable rules — read first

- Backend base URL: `https://shivanshbackend.replit.app` — never change this
- Auth token key: `localStorage.getItem("auth_token")` — never "token", never "jwt"
- Every page: `font-mono` on all text elements
- Colour: dark navy background `hsl(222,47%,7%)`, primary cyan `hsl(183,100%,50%)`
- Do NOT recreate or modify: Login, Dashboard, Campaigns list, Leads, Call Logs, Voices, DNC, Users, Settings pages
- Do NOT change existing routing or auth logic

---

## Shared API helper — add to `src/lib/api.ts` if not present

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

## 1 — Update Campaign create & edit form

Add these three fields to both the "Create Campaign" and "Edit Campaign" forms.

### Voice Provider selector

```
Label: "Voice Provider"
Control: segmented buttons / radio group  (3 options)
  - "ElevenLabs"  value="elevenlabs"
  - "Cartesia"    value="cartesia"
  - "Deepgram"    value="deepgram"
Default: "elevenlabs"
Campaign field: voiceProvider (string)
```

### Voice picker

Below the provider selector, show a `<select>` dropdown populated from the hardcoded list for the selected provider. Option label format: `"{name} — {gender} / {accent}"`.

When the provider changes, swap the list and clear the selected voice.

Campaign field: `voice` (string — the voice_id value)

**Voice lists (hardcoded — no fetch needed):**

**ElevenLabs** (`voiceProvider = "elevenlabs"`):
```
21m00Tcm4TlvDq8ikWAM  Rachel    female  us
EXAVITQu4vr4xnSDxMaL  Bella     female  us
MF3mGyEYCl7XYWbV9V6O  Elli      female  us
LcfcDJNUP1GQjkzn1xUU  Emily     female  us
pNInz6obpgDQGcFmaJgB  Adam      male    us
TxGEqnHWrfWFTfGW9XjX  Josh      male    us
ErXwobaYiN019PkySvjV  Antoni    male    us
SOYHLrjzK2X1ezoPC6cr  Harry     male    uk
```

**Cartesia** (`voiceProvider = "cartesia"`):
```
db6b0ed5-d5d3-463d-ae85-518a07d3c2b4  Skylar    female  us
0ee8beaa-db49-4024-940d-c7ea09b590b3  Morgan    female  us
e07c00bc-4134-4eae-9ea4-1a55fb45746b  Brooke    female  us
5f621418-ab01-4bf4-9a9d-73d66032234e  Willow    female  us
e5a6cd18-d552-4192-9533-82a08cac8f23  Patricia  female  us
62ae83ad-4f6a-430b-af41-a9bede9286ca  Gemma     female  uk
2f251ac3-89a9-4a77-a452-704b474ccd01  Lucy      female  uk
f24ae0b7-a3d2-4dd1-89df-959bdc4ab179  Ross      male    us
3e39e9a5-585c-4f5f-bac6-5e4905c51095  Cole      male    us
d709a7e8-9495-4247-aef0-01b3207d11bf  Donny     male    us
df872fcd-da17-4b01-a49f-a80d7aaee95e  Cameron   male    us
df89f42f-f285-4613-adbf-14eedcec4c9e  Harrison  male    uk
4bc3cb8c-adb9-4bb8-b5d5-cbbef950b991  George    male    uk
```

**Deepgram** (`voiceProvider = "deepgram"`):
```
aura-asteria-en   Asteria  female  us
aura-luna-en      Luna     female  us
aura-stella-en    Stella   female  us
aura-athena-en    Athena   female  uk
aura-hera-en      Hera     female  us
aura-orion-en     Orion    male    us
aura-arcas-en     Arcas    male    us
aura-perseus-en   Perseus  male    us
aura-helios-en    Helios   male    uk
aura-zeus-en      Zeus     male    us
```

### Preview button

Add a **▶ Preview** button next to the voice dropdown.

```ts
// On click:
setPreviewLoading(true);
try {
  const res = await api.post("/voices/preview", {
    provider: selectedProvider,   // "elevenlabs" | "cartesia" | "deepgram"
    voice_id: selectedVoiceId,
    text: "Hi there! This is a preview of your selected voice.",
  });
  // res = { url: "https://shivanshbackend.replit.app/api/audio/<token>", provider, voice_id }
  new Audio(res.url).play();
} catch (e) {
  toast.error("Preview failed — " + (e.message ?? "unknown error"));
} finally {
  setPreviewLoading(false);
}
```

Show a spinner inside the button while loading. Each provider is called exclusively — never fall back to another provider silently.

### Voicemail Drop Message field

```
Label: "Voicemail Drop Message"
Control: <textarea> rows=3
Placeholder: "Leave blank to hang up silently when voicemail is detected"
Campaign field: vmDropMessage (string | null)
```

When AMD detects voicemail on an outbound call the backend automatically plays this message via TTS, then hangs up. Empty = silent hang-up.

### Saving

Include all three fields in create/update calls:

```ts
// POST /campaigns  or  PATCH /campaigns/:id
{
  voiceProvider: "cartesia",
  voice: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
  vmDropMessage: "Hi, we tried to reach you. Please call us back at your earliest convenience.",
}
```

When loading an existing campaign into the edit form, pre-fill:
- `voiceProvider` from `campaign.voiceProvider` (default `"elevenlabs"`)
- `voice` from `campaign.voice`
- `vmDropMessage` from `campaign.vmDropMessage`

---

## 2 — New page: `/callbacks`

Add **Callbacks** to the sidebar after Leads. Show a small amber badge on the nav item when any callback is overdue.

### Fetch

```
GET /callbacks          → array of callback objects
GET /callbacks?campaignId=N   → filtered by campaign
```

Auto-refresh every 60 seconds.

**Callback object:**
```ts
{
  id: number
  name: string
  phone: string
  email: string | null
  campaignId: number
  campaignName: string | null
  status: string
  notes: string | null
  callbackAt: string | null   // ISO 8601
  createdAt: string
}
```

### Page layout

Header: `SCHEDULED CALLBACKS` + `[+ Schedule New]` button (top-right).

Table columns: **Due At** | **Lead** | **Phone** | **Campaign** | **Notes** | **Actions**

- Rows where `callbackAt < now`: add `border-l-4 border-amber-400`
- Sort: overdue rows first, then ascending `callbackAt`
- Empty state: `"No callbacks scheduled"`

### Row actions

**[✏ Reschedule]** — opens a modal:
```
Title: "Reschedule — {name}"
Fields:
  Date & Time: datetime-local (pre-filled with callbackAt)
  Notes: textarea (pre-filled)
Buttons: [Cancel]  [Save]

On Save:
  PATCH /callbacks/:id  { callbackAt: ISO8601string, notes }
  → close modal, refresh list, toast.success("Rescheduled")
```

**[✓ Done]** — confirm dialog "Mark as complete?", then:
```
PATCH /callbacks/:id  { status: "completed" }
→ remove from list
```

### Schedule New modal

```
Title: "Schedule Callback"

Field 1 — Lead search:
  Input placeholder: "Search lead by name or phone"
  On each keystroke (debounce 300ms):
    GET /leads?search={query}
    Show dropdown: "{name} — {phone}"
  On select: store leadId

Field 2 — Date & Time:
  datetime-local input (min = now)

Field 3 — Notes (optional):
  textarea

Buttons: [Cancel]  [Schedule]

On Schedule:
  POST /callbacks/schedule  { leadId, callbackAt: ISO8601, notes }
  → 201 response → close modal, refresh list
  → toast.success("Callback scheduled")
```

---

## 3 — New page: `/softphone`

Add **Softphone** to the sidebar after Callbacks. Visible to all roles.

### Layout — three columns

```
┌────────────────────────────────────────────────────────────┐
│  AGENT SOFTPHONE                      [ ● ONLINE ▼ ]      │
├──────────────────┬──────────────────┬──────────────────────┤
│  MY STATS TODAY  │    DIAL PAD      │   ACTIVE CALL        │
│                  │                  │                      │
│  Calls:    12    │ ┌──────────────┐ │  (idle or live call) │
│  Avg dur: 4m12s  │ │+1 _________  │ │                      │
│  Voicemail:  3   │ └──────────────┘ │                      │
│  Answered:   8   │ [1][2][3]        │                      │
│                  │ [4][5][6]        │                      │
│                  │ [7][8][9]        │                      │
│                  │ [*][0][#]        │                      │
│                  │ [⌫]  [✆ CALL]  │                      │
├──────────────────┴──────────────────┴──────────────────────┤
│  CALLBACKS DUE TODAY                                        │
└─────────────────────────────────────────────────────────────┘
```

### On mount

Read the logged-in user:
```ts
const user = JSON.parse(localStorage.getItem("auth_user") ?? "{}");
const agentId = user.id;
```

### Status toggle (top-right)

Fetch current status from `GET /agents/stats?agentId={agentId}` → find own entry → `status` field.

Display: `● ONLINE` (green) or `● OFFLINE` (amber) as a clickable pill.

On click:
```ts
const newStatus = current === "available" ? "busy" : "available";
await api.post("/agents/status", { id: agentId, status: newStatus });
```

### Stats panel (left column)

```
GET /agents/stats?agentId={agentId}
```

Find own entry in the returned array. Display:
- **Calls today**: `stats.callsToday`
- **Avg duration**: format `stats.avgDuration` seconds as `Xm Ys`
- **Voicemail**: `stats.dispositions?.vm ?? 0`
- **Answered**: `stats.dispositions?.interested ?? 0`

Re-fetch when the WebSocket fires `agent:stats:refresh`.

### Dial pad (centre column)

- Phone input field at top — digits appended on button click, also accepts manual typing
- 3×4 grid: `1 2 3 / 4 5 6 / 7 8 9 / * 0 #`
- Backspace `[⌫]` button
- Large cyan `[✆ CALL]` button

On CALL press: set `activeCallPhone = inputValue`, `callStatus = "dialing"`.

> WebRTC dialling requires a Telnyx WebRTC credential. For now, show the active call panel with the phone number and status "Dialling…". Do not attempt to import `@telnyx/webrtc` — it will be wired separately. Never break the UI over a missing import.

### Active call panel (right column)

**Idle:**
```
📵  No Active Call
Dial a number or wait for an inbound transfer
```

**Active** (driven by WebSocket `call:started` or manual dial):
```
📞 ACTIVE CALL
{phone}
⏱ {elapsed}          ← live timer

[ 🔇 MUTE ]  [ ⏸ HOLD ]  [ 🔴 HANG UP ]

── 3-WAY CONFERENCE ──────────────────────
Add number:  [_______________]  [ ➕ ADD ]

── LIVE TRANSCRIPT ───────────────────────
[caller]  "Hi, I was told to call back..."
[agent]   "Hello! Great to hear from you..."

── DISPOSITION ───────────────────────────
[ ✅ Interested ]  [ ❌ Not interested ]
[ 📅 Schedule CB ] [ 🚫 DNC           ]
```

**Conference — ADD button:**
```ts
await api.post(`/calls/${callControlId}/conference`, { to: thirdPartyNumber });
// Response: { conferenceName, thirdPartyCallControlId, message }
// toast.info("Dialling " + thirdPartyNumber + " — bridging when answered")
```

**Disposition buttons:**
```ts
// Interested
api.patch(`/call-logs/${callLogId}/disposition`, { disposition: "interested" })

// Not interested
api.patch(`/call-logs/${callLogId}/disposition`, { disposition: "not_interested" })

// Schedule callback — open datetime picker then:
api.post("/callbacks/schedule", { leadId, callbackAt })

// DNC
api.post("/dnc", { phoneNumber: activeCallPhone })
```

**Incoming call banner** (full-width overlay, z-50, amber border):
```
📞  Incoming Call
Caller: {callerPhone}     Campaign: {campaignId}
[ ANSWER ]   [ DECLINE ]
```
ANSWER → set `activeCallPhone`, `callStatus = "active"`, dismiss banner.  
DECLINE → dismiss banner.

### WebSocket setup

```ts
import { io } from "socket.io-client";

const socket = io("https://shivanshbackend.replit.app", {
  auth: { token: localStorage.getItem("auth_token") },
  transports: ["websocket"],
});

socket.on("call:started", ({ callControlId, phoneNumber }) => {
  setCallControlId(callControlId);
  setActiveCallPhone(phoneNumber);
  setCallStatus("active");
  setCallStartedAt(Date.now());
});

socket.on("call:ended", () => {
  setCallStatus("idle");
  setCallControlId(null);
  refetchStats();
});

socket.on("call:transcript", ({ speaker, text }) => {
  appendTranscript({ speaker, text });
});

socket.on("agent:stats:refresh", () => refetchStats());

socket.on("agent:incoming_call", ({ callerPhone, campaignId }) => {
  showIncomingCallBanner({ callerPhone, campaignId });
});
```

### Callbacks due today (bottom strip)

```ts
const { data } = await api.get("/callbacks");
const dueToday = data.filter(c =>
  c.callbackAt && new Date(c.callbackAt) <= new Date()
);
```

Compact table: **Due At** | **Lead** | **Phone** | **[📞 Dial]**

`[📞 Dial]` → pre-fill the dialpad with `c.phone`, focus the CALL button.

---

## 4 — Agent stats on existing Agents page

If there is an Agents page or section, add a per-agent stats card below each agent row or as an expandable panel.

```
GET /agents/stats
```

Display per agent:
```
{name}                    ● {status}
Calls today: {callsToday}   Avg: {avgDuration formatted}
Interested: {dispositions.interested ?? 0}
Voicemail:  {dispositions.vm ?? 0}
```

Re-fetch on WebSocket `agent:stats:refresh` event.

---

## 5 — Sidebar additions

Add in this order (after Leads, before Settings):

| Label | Route | Badge |
|---|---|---|
| Softphone | `/softphone` | none |
| Callbacks | `/callbacks` | amber dot when any `callbackAt < now` |

Badge logic for Callbacks:
```ts
// Poll GET /callbacks every 60s
const overdue = callbacks.filter(c => c.callbackAt && new Date(c.callbackAt) < new Date());
// Show amber dot if overdue.length > 0
```

Same `font-mono` style as existing nav items.

---

## Error handling — apply everywhere

- Wrap every `api.*` call in `try/catch`
- On catch: `toast.error(e.message ?? "Something went wrong")`
- 401 is handled automatically by `apiFetch` (redirect to login)
- Loading states: show spinner or muted `"Loading…"` text — never blank
- Empty states: always render a friendly message — never crash on null/undefined
