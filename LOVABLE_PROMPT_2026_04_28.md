# SHIVANSH — Lovable Wire-Update Prompt (2026-04-28)

Apply the following changes to the Lovable frontend. Three independent updates:
**(A)** swap to the new production base URL,
**(B)** add an audio/video transcription helper,
**(C)** add `transfer_mode` to the campaign create/edit forms.

All authenticated calls continue to use:
```
Authorization: Bearer <token from localStorage.auth_token>
```

---

## A. New API base URL

Production is now on the dedicated VPS cluster behind Cloudflare. **Stop using `https://shivanshbackend.replit.app`.**

```ts
// src/lib/api.ts (or wherever API_BASE is defined)
export const API_BASE = "https://api.shivanshagent.cloudisoft.com";
```

If a `.env` is in use:
```
VITE_API_BASE_URL=https://api.shivanshagent.cloudisoft.com
```

Search-and-replace any hard-coded `shivanshbackend.replit.app` references.

---

## B. Audio / Video Transcription

New endpoint that returns a Deepgram nova-2 transcript for any uploaded audio or video file. Use it anywhere the operator wants to convert a recorded SOP, call sample, or script audio into text (e.g. the SOP / Script editors in the campaign builder, the agent softphone "voice note" field).

### Endpoint

```
POST /api/uploads/transcribe
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

**Form field:** `file` (single file, audio/* or video/*, max 50 MB)

### Responses

**200 OK**
```json
{ "transcript": "Hello, this is the recording…", "filename": "sop.mp3" }
```

**400** — missing file or unsupported mime
```json
{ "error": "No file uploaded. Send audio in the 'file' field." }
{ "error": "Unsupported file type: image/png. Upload an audio or video file." }
```

**401** — missing/invalid bearer token
**422** — file accepted but no speech detected
**502** — Deepgram upstream failure
**503** — `DEEPGRAM_API_KEY` not configured on the server

### React helper (drop-in)

```ts
// src/lib/transcribe.ts
import { API_BASE } from "./api";

export async function transcribeAudio(file: File): Promise<string> {
  const fd = new FormData();
  fd.append("file", file);

  const token = localStorage.getItem("auth_token");
  const res = await fetch(`${API_BASE}/api/uploads/transcribe`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error ?? `Transcription failed (${res.status})`);
  }
  return data.transcript as string;
}
```

### Suggested UI

Anywhere you currently have an audio upload:
1. Show the chosen filename + size.
2. Button **"Transcribe with AI"** → call `transcribeAudio(file)`.
3. While pending: show a spinner with the text *"Transcribing… up to 2 minutes for long files."*.
4. On success: drop the returned `transcript` into the adjacent text area (SOP / Script / Notes).
5. On failure: show the error from the response (it is already user-readable).

Accept `accept="audio/*,video/*"` on the file input. The server enforces 50 MB.

---

## C. Per-Campaign Transfer Mode

Campaigns now choose how live transfers behave when the AI hands a call off to a human agent.

| Value | Behaviour |
|---|---|
| `"blind"` *(default)* | Cold transfer — caller is bridged immediately, no whisper. |
| `"warm"` | Vapi speaks a short hand-off message to the agent first, then bridges. |

### Wire shape

The field is named `transferMode` in JSON request bodies (snake `transfer_mode` only appears in the DB column).

**Create** — `POST /api/campaigns`
```json
{
  "name": "Spring Outbound",
  "transferMode": "warm",   // optional, defaults to "blind"
  "...": "all existing fields unchanged"
}
```

**Update** — `PATCH /api/campaigns/:id` (or `PUT`, whichever the existing form uses)
```json
{ "transferMode": "blind" }
```

**List / Get** — responses now include `transferMode` on each campaign object:
```json
{ "id": 12, "name": "...", "transferMode": "warm", "...": "..." }
```

Validation: anything other than `"blind"` or `"warm"` returns 400.

### UI changes

In the campaign **Create** and **Edit** forms, add a single field:

- **Label:** `Transfer Mode`
- **Control:** Select / radio with two options
  - `Blind transfer` — value `blind` *(default)*
  - `Warm transfer (AI announces caller first)` — value `warm`
- **Help text:** *"Blind = bridge immediately. Warm = AI gives the agent a one-line summary, then connects the caller."*
- Place it next to the existing transfer-target / agent assignment fields.

When loading an existing campaign for edit, prefill from `campaign.transferMode ?? "blind"`.

---

## D. (Reference only — already shipped) Manual Callback Scheduling

No new work for Lovable unless you want a "Schedule callback" button in the agent softphone. The endpoint is unchanged:

```
POST /api/callbacks/schedule
Authorization: Bearer <token>
Content-Type: application/json

{
  "leadId": 1234,
  "callbackAt": "2026-05-02T15:30:00.000Z",   // ISO 8601, UTC
  "notes": "Caller asked for follow-up Monday afternoon"   // optional
}
```

Returns `200` with the created callback row, `400` for bad payload, `401` for missing auth.

Suggested UI: in the lead row's actions menu add **"Schedule Callback…"** → modal with a `datetime-local` input (convert to ISO with `new Date(value).toISOString()`) and a notes textarea.

---

## Acceptance checklist

- [ ] All API calls hit `https://api.shivanshagent.cloudisoft.com` (no `shivanshbackend.replit.app` left).
- [ ] Uploading an MP3/WAV/MP4 anywhere it makes sense produces a transcript and fills the adjacent text field.
- [ ] Campaign create form has a Transfer Mode select; submitting with `warm` or `blind` round-trips through the API and survives reload.
- [ ] (Optional) Agent softphone has a Schedule Callback button posting to `/api/callbacks/schedule`.

That's the full diff for this release.
