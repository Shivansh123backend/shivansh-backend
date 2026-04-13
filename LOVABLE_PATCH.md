# SHIVANSH — Lovable Patch Prompt
## Paste this into your existing Lovable project to fix known issues

---

## PATCH 1 — Campaign Start / Stop / Pause / Resume buttons

The campaign card footer has four action buttons. Each must call the correct backend endpoint:

```
Launch (draft/paused → active):   POST /api/campaigns/start/:id
Pause  (active → paused):         POST /api/campaigns/stop/:id
Resume (paused → active):         POST /api/campaigns/start/:id
Stop   (any → paused):            POST /api/campaigns/stop/:id
```

All four require `Authorization: Bearer {token}` header.

After a successful response (HTTP 200), update the campaign's `status` field in local state and refetch the campaigns list. The server also emits a WebSocket event (`campaign:started` or `campaign:stopped`) — listen for that too and update UI.

**Do NOT use `PATCH /api/campaigns/:id` for start/stop** — use the dedicated `/start/:id` and `/stop/:id` routes above.

**Button visibility rules:**
- `status === "draft"` or `status === "paused"` → show **Launch / Resume** (green)
- `status === "active"` → show **Pause** (yellow)
- All states → show **Test Call** (yellow)

---

## PATCH 2 — Launch Campaign Modal: Reset leads when all called

When opening the Launch modal for a campaign where all leads are already called (`pendingLeads === 0` but `totalLeads > 0`), show a warning panel with a "Re-call all leads" checkbox.

When the user ticks that checkbox and clicks Launch:

1. First call: `POST /api/campaigns/:id/reset-leads` (no body needed)
   - This resets all "called" leads back to "pending"
   - Show loading state during this call
2. Then immediately call: `POST /api/campaigns/start/:id`

Both calls require `Authorization: Bearer {token}`.

If `totalLeads === 0` (no leads at all), show: "No leads added yet. Add leads before launching." and disable the Launch button entirely.

---

## PATCH 3 — Test Call modal: correct API body

The Test Call modal fires a manual call via:
```
POST /api/call/manual
Authorization: Bearer {token}
Content-Type: application/json

Body: {
  "phone": "+1XXXXXXXXXX",     ← the number entered by the user
  "campaign_id": 4             ← NUMBER (integer), not string — use the campaign's .id
}
```

**Common mistakes to fix:**
- Do NOT send `campaignId` (camelCase) — send `campaign_id` (snake_case)
- Do NOT send `campaign_id` as a string — it must be a number
- Do NOT omit `campaign_id` — it is required

**Success response** (HTTP 200):
```json
{ "success": true, "message": "Call triggered to +1XXXXXXXXXX", "phone": "...", "campaignId": 4 }
```

**Error response** (HTTP 400/502/503):
```json
{ "success": false, "error": "...", "hint": "..." }
```
Show the `error` and `hint` (if present) in the result panel.

---

## PATCH 4 — Callbacks page: correct API

The callbacks page fetches leads with `status === "callback"`:

```
GET /api/callbacks
Authorization: Bearer {token}
```

Response: array of leads with status "callback":
```typescript
interface CallbackLead {
  id: number;
  name: string;
  phone: string;
  email?: string;
  campaignId: number;
  campaignName?: string;
  status: "callback";
  updatedAt: string;
}
```

The "Call Back" button on each row fires:
```
POST /api/call/manual
Body: { "phone": lead.phone, "campaign_id": lead.campaignId }
```

After success, update that row's button to show "Calling..." (disabled) for 3 seconds then re-enable.

To mark a callback as handled (after the call):
```
PATCH /api/callbacks/:id
Body: { "status": "called" }
```

---

## PATCH 5 — WebSocket: campaign status updates

When the WebSocket emits `campaign:started` or `campaign:stopped`, immediately update the matching campaign's status badge in the Campaigns page **without waiting for a refetch**. This makes the UI feel instant.

```typescript
socket.on("campaign:started", ({ campaignId }) => {
  updateCampaignStatus(campaignId, "active");
});
socket.on("campaign:stopped", ({ campaignId }) => {
  updateCampaignStatus(campaignId, "paused");
});
```

Also listen for `call:started` and `call:ended` events to update the Live Monitor and Dashboard live call counts in real time.

---

## PATCH 6 — AI Agent page: route fix

The AI Agents page is at `/agents` in the sidebar navigation but the backend endpoints are:

```
GET    /api/ai-agents          → Agent[]
POST   /api/ai-agents          { name, prompt, language?, defaultVoiceId? } → Agent
GET    /api/ai-agents/:id      → Agent
PATCH  /api/ai-agents/:id      { name?, prompt?, language?, defaultVoiceId? }
DELETE /api/ai-agents/:id
```

**Use `/api/ai-agents` (with dash) — NOT `/api/agents`.**

---

## PATCH 7 — Campaign card: lead counts from API

The campaign cards show "N total", "N called", "N pending". These come from:

```
GET /api/campaigns
```

Each campaign object in the response has:
```typescript
{
  id: number;
  name: string;
  status: "draft" | "active" | "paused" | "completed";
  type: "outbound" | "inbound";
  totalLeads?: number;    ← total leads assigned
  calledLeads?: number;   ← leads with status "called"
  // pendingLeads = totalLeads - calledLeads
}
```

If `totalLeads` is null/undefined, show `0` for all three stats.

---

## PATCH 8 — CDR page: call logs endpoint

Call logs come from:
```
GET /api/call-logs              → CallLog[]  (all logs)
GET /api/calls                  → same
```

Each log has:
```typescript
{
  id: number;
  phoneNumber: string;
  campaignId?: number;
  status: "initiated" | "completed" | "failed";
  disposition?: string;
  direction?: "inbound" | "outbound";
  duration?: number;        ← seconds
  recordingUrl?: string;
  transcript?: string;
  summary?: string;
  callControlId?: string;
  createdAt: string;
}
```

Update disposition inline with:
```
PATCH /api/call-logs/:id
Body: { "disposition": "interested" }
```

Valid dispositions: `interested | not_interested | vm | no_answer | busy | connected | callback_requested | transferred | completed`

---

## Visual rules reminder (do not change these)

- App name: **SHIVANSH** (not NexusCall, not Nexus AI, not anything else)
- Primary color: `hsl(183, 100%, 50%)` — electric cyan
- All fonts: `font-mono` everywhere
- All backgrounds: dark navy only — zero white/light backgrounds
- All badges: outline variant with colored border + very faint fill
