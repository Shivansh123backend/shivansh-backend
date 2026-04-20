# SHIVANSH — Lovable Prompt: AI Optimizer & Supervisor Pages

Add two **admin-only** pages that surface the new self-learning + real-time-coaching backend.

## Backend reference

- Base URL: `https://shivanshbackend.replit.app`
- Auth: Bearer token from `localStorage.getItem("auth_token")`
- All routes below require an **admin** account (`admin@shivansh.com / Admin@123`)

### Endpoints

1. `GET /optimizer/insights?windowDays=7&campaignId=<optional>`
   Returns:
   ```json
   {
     "windowDays": 7,
     "totalCalls": 142,
     "avgScore": 67.3,
     "dispositionBreakdown": { "interested": 41, "not_interested": 60, "callback": 18, "voicemail": 23 },
     "topObjections": [{ "objection": "too expensive", "count": 22 }, { "objection": "not interested", "count": 18 }],
     "weakCallExcerpts": [{ "callId": 901, "score": 28, "excerpt": "... last 3 turns ..." }]
   }
   ```

2. `GET /optimizer/daily?windowDays=14&campaignId=<optional>`
   Returns:
   ```json
   [{ "date": "2026-04-14", "avgScore": 64.1, "callCount": 22 }, ...]
   ```

3. `GET /optimizer/variations/:campaignId`
   Returns the live A/B test population for that campaign:
   ```json
   [{
     "id": 7, "slot": "intro", "text": "Hi, this is ...",
     "isOriginal": false, "uses": 14, "avgScore": 71.2,
     "promotedAt": "2026-04-19T10:11:00.000Z", "createdAt": "..."
   }]
   ```
   `promotedAt != null` = current winner. `isOriginal = true` = the human-written original kept as a baseline.

4. `GET /campaigns` (existing) — to populate the campaign picker.

---

## Page 1: `/admin/optimizer`  — “AI Optimizer”

**Header**: "AI Optimizer" + a campaign selector (default: All) + window selector (7d / 14d / 30d).

**Top KPI row** (4 cards): Total Calls · Avg Score · Top Disposition · Top Objection.

**Daily score chart**: Line chart of `dailyAverageScores` (date X, avgScore Y). Use the same chart library already in the dashboard. Add a faint bar overlay for `callCount` if straightforward.

**Two side-by-side panels**:
- *Disposition breakdown* — horizontal bar chart from `dispositionBreakdown`.
- *Top objections* — list with count badges from `topObjections`.

**Weak calls table** at the bottom: columns `callId · score · excerpt`. Each row links to the existing call detail page.

**Empty state**: "Not enough data yet — the optimizer needs at least a few completed calls to compute insights."

---

## Page 2: `/admin/campaigns/:id/variations`  — “Script Variations”

Reachable from a new "View AI Variations" button on the campaign detail page (admin only).

**Layout**:
- Header: campaign name + "Script Variations (A/B testing)".
- Subtext: "Shivansh automatically rephrases your intro for low-scoring campaigns and rotates them with your original. The best performer is promoted automatically."
- Table with columns: **Status · Text · Uses · Avg Score · Created**
  - **Status**: green "Promoted" badge if `promotedAt != null`; grey "Original" badge if `isOriginal`; otherwise "Candidate".
  - **Text**: full text in a wrapped cell.
  - **Avg Score**: show `—` when null (no uses yet); colour green ≥ 70, amber 50–69, red < 50.
- Sort: Promoted first, then by `uses` desc.
- **Empty state**: "No variations generated yet. Variations are auto-generated when this campaign averages below 50."

**Do not** add create/edit/delete UI — variations are managed entirely by the backend learning loop.

---

## Style & behaviour rules

- Reuse the existing dashboard tokens, card, table, and chart components — do **not** introduce new design primitives.
- Both pages are **read-only**.
- Show loading skeletons; on error show a small toast "Couldn't load optimizer data".
- Hide both pages from non-admin users (check the user's role from the existing auth context).
- Refresh on mount only — no polling.

---

## Optional bonus (only if trivial in the existing nav)

Add an "AI Optimizer" item to the admin sidebar pointing at `/admin/optimizer`, and a small "AI Variations" link on the campaign detail page header pointing at `/admin/campaigns/:id/variations`.
