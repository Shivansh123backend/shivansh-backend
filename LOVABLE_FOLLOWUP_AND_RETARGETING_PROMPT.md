# LOVABLE PROMPT — Follow-Up & Retargeting Admin UI

Add two new admin pages to the SHIVANSH dashboard. **Do NOT change any existing UI, colors, or layouts.** Match the current dark-themed design system (same sidebar, same card style, same table style as the Campaigns and Call Logs pages).

Backend: `https://shivanshbackend.replit.app`
Auth header: `Authorization: Bearer ${localStorage.getItem("auth_token")}`
Both pages are admin-only.

---

## PAGE 1 — Follow-Ups

**Route:** `/admin/follow-ups`
**Sidebar entry:** "Follow-Ups" under the "Engagement" section (create the section if it doesn't exist; otherwise add it under "Campaigns").

### Data source
`GET /api/follow-ups` — implement this endpoint expectation: returns an array of follow-up rows. If the endpoint doesn't exist yet on the backend, hit `GET /api/leads` and per lead show their scheduled follow-ups via a per-lead detail call. **Preferred:** assume `GET /api/follow-ups?status=pending|sent|failed|skipped&limit=100` exists and returns:

```json
[{
  "id": 1,
  "leadId": 42,
  "campaignId": 3,
  "channel": "sms" | "email",
  "sequenceStep": 1,
  "intent": "thank_you" | "summary" | "reminder" | "value_add" | "final",
  "scheduledAt": "2026-04-21T10:00:00Z",
  "sentAt": null,
  "status": "pending" | "sent" | "failed" | "skipped",
  "content": "...",
  "providerId": null,
  "error": null,
  "retarget": false,
  "industry": "insurance",
  "disposition": "interested",
  "predictedLabel": "high"
}]
```

### Layout
- **Header:** "Follow-Ups" + subtitle "Auto-scheduled SMS & email after every call"
- **4 KPI cards in a row:**
  1. Pending (count)
  2. Sent today
  3. Failed today
  4. Retarget rate (% of follow-ups with `retarget: true`)
- **Filter bar:**
  - Channel: All / SMS / Email
  - Status: All / Pending / Sent / Failed / Skipped
  - Show retargets only (toggle)
  - Search by lead phone or lead id
- **Table columns:**
  - Scheduled At (relative + tooltip with absolute)
  - Channel (badge: blue=SMS, purple=Email)
  - Intent (badge)
  - Lead ID (clickable link to `/admin/leads/:id`)
  - Status (badge: gray=pending, green=sent, red=failed, yellow=skipped)
  - Retarget (small icon if true)
  - Predicted intent (high/medium/low pill)
  - Actions: "View content" (opens modal with `content` body)
- **Refresh button** in header (auto-refresh every 30s)

### Empty state
"No follow-ups yet. They appear automatically after a call ends."

---

## PAGE 2 — Lead Lifecycle

**Route:** `/admin/lifecycle`
**Sidebar entry:** "Lead Lifecycle" under "Engagement"

### Data source
Use existing `GET /api/leads` and group client-side by the new `lifecycleStage` field on each lead. Stages: `new`, `contacted`, `engaged`, `converted`, `dead`, `retargeted`. Leads with `null` lifecycleStage = "new".

### Layout — Funnel + Kanban hybrid
- **Funnel header (horizontal bars):** counts for each stage with conversion-percent dropoff between stages.
- **Kanban below:** 6 columns (one per stage), each card shows:
  - Lead name
  - Phone (last 4 visible, rest masked)
  - Predicted intent pill
  - Last call disposition (small text)
  - Number of pending follow-ups (small badge)
- **Filters above:** Campaign dropdown, Industry, Date range
- **Click a lead card** → opens existing lead detail drawer (or `/admin/leads/:id`)

### Behavior
- Stages displayed left → right in funnel order: new → contacted → engaged → converted, with dead and retargeted as separate side columns.
- Show empty stages too (with "0 leads" placeholder).

---

## STRICT RULES (apply to both pages)

1. **Do not modify any existing component, color, font, or layout.**
2. **Do not introduce new colors** — reuse the existing palette tokens already in the app.
3. **Use the same Card / Badge / Button / Input components** already in the codebase.
4. **Auth:** every fetch sends `Authorization: Bearer ${localStorage.getItem("auth_token")}`.
5. **Loading:** use existing skeleton loaders.
6. **Errors:** use existing toast/notification system.
7. **Mobile responsive:** tables collapse to cards on `<md` breakpoint, same as existing pages.
8. **No new dependencies** unless absolutely required.

---

## OPTIONAL — Add to existing Campaign edit page

Add three new form fields to the existing campaign create/edit form (do NOT redesign the form):

- **Region** dropdown: US / UK / CA / AU / IN / OTHER (sends `region` field)
- **Accent** dropdown: US / UK / Neutral (sends `accent` field)
- **Voice profile** text input (optional JSON, sends `voiceProfile` field)

Place them in the existing "Voice & Behavior" section of the form. No layout changes — just add the three fields at the bottom of that section.

---

That's it. Keep it minimal, additive, and matching the current dashboard style.
