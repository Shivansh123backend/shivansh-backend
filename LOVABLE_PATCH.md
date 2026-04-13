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

## PATCH 9 — Edit & Delete AI Agents

Each AI agent card needs two new action buttons in the footer (alongside "Agent ID #N"):

- **Edit** — opens an "Edit Agent" modal pre-filled with the agent's current name, prompt, language, and default voice
- **Delete** — shows a confirmation dialog, then deletes the agent

**Edit agent:**
```
PATCH /api/ai-agents/:id
Authorization: Bearer {token}
Content-Type: application/json

Body (any subset of fields):
{
  "name": "New Name",
  "prompt": "Updated system prompt...",
  "language": "en",
  "defaultVoiceId": 3    ← number or null to unset
}

Response: updated Agent object
```

**Delete agent:**
```
DELETE /api/ai-agents/:id
Authorization: Bearer {token}

Response: { "success": true }
```

After delete: remove the card from local state immediately and show a toast "Agent deleted".
After edit: update the card in local state with the returned agent and show a toast "Agent updated".

**Edit modal layout** (same style as Create Agent modal):
- Header: `<Pencil className="w-3.5 h-3.5 text-primary">` + "EDIT AI AGENT" + `<X>`
- Same fields as create: Agent Name, Language, Default Voice, System Prompt
- Footer: Cancel (outline) + "Save Changes" (primary)
- Pre-fill all fields from the agent object passed to the modal

---

## PATCH 10 — Delete Campaigns

Each campaign card needs a **Delete** button. Only show it when `status !== "active"` (you can't delete a running campaign).

Placement: add a small delete icon button to the card header (top-right, next to the status badge) or as a "..." overflow menu.

```
DELETE /api/campaigns/:id
Authorization: Bearer {token}

Response: { "success": true, "deleted": { "id": 4, "name": "Campaign Name" } }
```

**Important:** This also deletes all leads and call logs for the campaign. Show a confirmation dialog first:

> "Delete [Campaign Name]?"  
> "This will permanently delete the campaign and all its leads and call history. This cannot be undone."
>
> [Cancel]  [Delete]

After confirm: call DELETE, remove the card from local state, show toast "Campaign deleted".

**Error case:** If the campaign is active, the backend returns 400 `"Stop the campaign before deleting it"` — show that error in a toast.

---

## PATCH 11 — Delete Leads

Add a delete button (trash icon) to each lead row in the Leads table.

**Single lead delete:**
```
DELETE /api/leads/:id
Authorization: Bearer {token}

Response: { "success": true, "deleted": { "id": 123, "name": "...", "phone": "..." } }
```

Show a brief inline confirmation (e.g. the trash icon turns red on hover) or a small confirmation toast before actually deleting. After delete: remove the row from local state.

**Bulk delete all leads for a campaign** (add a "Clear All" button to the Leads page filter bar, only shown when a campaign is selected):
```
DELETE /api/leads?campaignId={id}
Authorization: Bearer {token}

Response: { "success": true, "deleted": 47, "campaignId": 4 }
```

Show a confirmation dialog before bulk delete: "Delete all N leads for [Campaign]? This cannot be undone."

---

## PATCH 12 — CDR: show recording, transcript, summary & dispositions

The CDR table already fetches from `GET /api/call-logs`. The backend returns **all** of these fields — they just aren't being rendered. Fix the table to display them.

### Column layout for CDR table (left → right):

| Column | Content |
|--------|---------|
| Phone | `log.phoneNumber` |
| Campaign | `log.campaignId` (or campaign name if available) |
| Direction | `log.direction` — badge: inbound = blue, outbound = cyan |
| Status | `log.status` — badge colors: completed=green, failed=red, initiated=yellow |
| Disposition | `log.disposition` — colored badge (see colors below) |
| Duration | `log.duration ? formatDuration(log.duration) : "—"` |
| Recording | audio play button or "—" if no URL |
| Transcript | expand button or "—" if empty |
| Summary | expand button or "—" if empty |
| Date | `log.timestamp` formatted |

### Disposition badge colors:
```
interested         → green   (border + text: hsl(142,76%,36%))
not_interested     → red     (border + text: hsl(0,84%,60%))
vm                 → purple  (border + text: hsl(270,70%,60%))
no_answer          → orange  (border + text: hsl(25,95%,53%))
busy               → yellow  (border + text: hsl(48,96%,53%))
callback_requested → blue    (border + text: hsl(210,100%,56%))
connected          → cyan    (border + text: hsl(183,100%,50%))
transferred        → teal    (border + text: hsl(173,80%,40%))
completed          → green   (same as interested)
(empty/null)       → gray    "—"
```

### Recording playback:
If `log.recordingUrl` is present, show a small play button (▶) that opens an `<audio>` element inline below the row (toggle on click). If null, show `—`.

```tsx
{log.recordingUrl ? (
  <button
    onClick={() => toggleRecording(log.id)}
    className="flex items-center gap-1 text-xs text-primary border border-primary/30 rounded px-2 py-0.5 hover:bg-primary/10"
  >
    <Play className="w-3 h-3" /> Play
  </button>
) : <span className="text-muted-foreground">—</span>}

{openRecording === log.id && log.recordingUrl && (
  <audio controls src={log.recordingUrl} className="w-full mt-1" />
)}
```

### Transcript & Summary — expandable row detail:
If `log.transcript` or `log.summary` is non-empty, show an expand icon (ChevronDown). Clicking it toggles an expanded row beneath that shows:

```tsx
{expandedRow === log.id && (
  <tr>
    <td colSpan={10} className="bg-muted/20 px-4 py-3 border-b border-border/30">
      {log.summary && (
        <div className="mb-3">
          <p className="text-xs font-mono text-primary/70 uppercase tracking-wider mb-1">AI Summary</p>
          <p className="text-sm font-mono text-foreground/90 whitespace-pre-wrap">{log.summary}</p>
        </div>
      )}
      {log.transcript && (
        <div>
          <p className="text-xs font-mono text-primary/70 uppercase tracking-wider mb-1">Transcript</p>
          <pre className="text-xs font-mono text-foreground/70 whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto bg-background/50 rounded p-2 border border-border/30">{log.transcript}</pre>
        </div>
      )}
      {!log.summary && !log.transcript && (
        <p className="text-xs text-muted-foreground">No transcript or summary available for this call.</p>
      )}
    </td>
  </tr>
)}
```

### Duration formatter:
```typescript
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}
```

### Inline disposition update:
The existing `PATCH /api/call-logs/:id/disposition` endpoint works. Add a dropdown to each disposition badge cell so supervisors can manually override it. On change:
```
PATCH /api/call-logs/{log.id}/disposition
Body: { "disposition": "interested" }
```
Update the row in local state after success (no full refetch needed).

### Empty state:
If no logs: show centered text `"NO CALLS RECORDED YET"` in `text-muted-foreground font-mono text-xs`.

---

## PATCH 13 — Campaign Transfer Number field

When creating or editing a campaign, add a **Transfer Number** input field. This is the human agent's phone number that the AI will transfer to when the caller wants to speak with a live person.

### Field placement
Add after the "From Number" field in the Create/Edit Campaign modal:

```
Label: "Transfer Number (optional)"
Placeholder: "+1XXXXXXXXXX"
Helper text: "When the AI detects the caller wants a human, it will transfer to this number and play hold music."
```

### API field name: `transferNumber` (camelCase)
```
POST /api/campaigns           Body: { ..., transferNumber: "+19998887777" }
PATCH /api/campaigns/:id      Body: { transferNumber: "+19998887777" }
GET  /api/campaigns           Response includes: { ..., transferNumber: "+19998887777" | null }
```

The field is optional — leave it null/empty if no transfer is needed. When set, the AI automatically handles transfer when it detects phrases like "let me connect you with a human", "transferring you now", etc.

### Campaign card display
If `campaign.transferNumber` is set, show a small badge or line in the card footer:
```
↗ Transfer: +19998887777
```
Use `text-xs font-mono text-muted-foreground`.

---

## PATCH 14 — Human-Like Mode toggle (AI Agents + Campaigns)

The "Human-Like Mode" toggle adds natural fillers, empathy, and pacing instructions to the AI's system prompt. When ON, the AI says things like "Hmm, let me see", "That makes total sense", and "I'll keep this brief" — making it sound like a real person.

### On the AI Agent card (Create / Edit agent modals)

The field name is `humanLikeMode` (boolean):

```typescript
// Create agent
POST /api/ai-agents
Body: {
  name: "...",
  prompt: "...",
  humanLikeMode: true   // boolean, NOT a string
}

// Edit agent
PATCH /api/ai-agents/:id
Body: { humanLikeMode: false }   // toggle off
```

The backend returns the full agent object including `humanLikeMode: boolean`.

**Toggle wire-up for agent card:**
```tsx
<Switch
  checked={agent.humanLikeMode ?? true}
  onCheckedChange={(checked) => {
    patchAgent(agent.id, { humanLikeMode: checked });
  }}
/>
```

After PATCH, update the agent in local state with the returned agent object.

### On the Campaign form (Create / Edit campaign)

The field name is `humanLike` (string `"true"` or `"false"`, NOT a boolean):

```typescript
// Create or update campaign
POST /api/campaigns
PATCH /api/campaigns/:id
Body: { humanLike: "true" }    // string, NOT boolean
       { humanLike: "false" }
```

**Toggle wire-up for campaign form:**
```tsx
<Switch
  checked={(campaign.humanLike ?? "true") !== "false"}
  onCheckedChange={(checked) => {
    setValue("humanLike", checked ? "true" : "false");
  }}
/>
```

### Display rule — show the current state on agent cards

If `agent.humanLikeMode === true`, show a small badge in the agent card footer:
```tsx
{agent.humanLikeMode && (
  <span className="text-xs font-mono text-primary/70 border border-primary/20 rounded px-1.5 py-0.5">
    ✦ Human-Like
  </span>
)}
```

---

## Visual rules reminder (do not change these)

- App name: **SHIVANSH** (not NexusCall, not Nexus AI, not anything else)
- Primary color: `hsl(183, 100%, 50%)` — electric cyan
- All fonts: `font-mono` everywhere
- All backgrounds: dark navy only — zero white/light backgrounds
- All badges: outline variant with colored border + very faint fill
