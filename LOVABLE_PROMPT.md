# SHIVANSH — Complete UI Specification for Lovable
## AI-Powered Calling SaaS — Full Frontend Rebuild

> Copy the ENTIRE contents of this file and paste it into Lovable as a single prompt.

---

## 0. GLOBAL DESIGN SYSTEM

### Color Palette
```
Background:        hsl(224, 71%, 4%)       — near-black navy
Card/Panel:        hsl(224, 71%, 3%)       — slightly darker than background
Border:            hsl(215, 20%, 17%)      — very subtle blue-grey border
Foreground:        hsl(210, 40%, 98%)      — near-white text
Muted foreground:  hsl(215, 20%, 65%)      — grey subtitle text
Primary:           hsl(183, 100%, 50%)     — electric cyan (#00FFFF)
Destructive:       hsl(0, 63%, 31%)        — dark red
```

### Typography — ENTIRE UI IS MONOSPACE
- Font family: `font-mono` (JetBrains Mono or similar) for **every** label, value, badge, button, input, table cell
- Page titles: `text-sm font-bold font-mono tracking-widest uppercase`
- Section labels: `text-[10px] font-mono uppercase tracking-widest text-muted-foreground`
- Table headers: `text-[10px] font-mono uppercase tracking-wider text-muted-foreground`
- Table cells: `text-xs font-mono`
- Badge text: `text-[9px] font-mono uppercase`
- Button text: `font-mono text-xs uppercase tracking-wider`
- Input text: `font-mono text-sm`

### Global Aesthetic
- Dark terminal / hacker aesthetic
- All cards: `border border-border rounded bg-[hsl(224,71%,3%)]`
- All tables: `border border-border rounded bg-[hsl(224,71%,3%)] overflow-hidden`
- All modals: `fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4`
- Modal inner: `bg-[hsl(224,71%,3%)] border border-border rounded w-full max-w-{size}`
- Hover rows: `hover:bg-white/[0.02] transition-colors`
- Active nav item: `bg-primary/15 text-primary border border-primary/25 font-medium`
- Skeleton loading: dark shimmer placeholders

### StatusBadge Component (reused everywhere)
All badges are `variant="outline"` with `text-[9px] font-mono uppercase`:
```
active      → border-green-500/30  text-green-400  bg-green-500/5
completed   → border-blue-500/30   text-blue-400   bg-blue-500/5
paused      → border-yellow-500/30 text-yellow-400 bg-yellow-500/5
draft       → border-border        text-muted-foreground
in_progress → border-cyan-500/30   text-cyan-400   bg-cyan-500/5  animate-pulse
available   → border-green-500/30  text-green-400  bg-green-500/5
busy        → border-red-500/30    text-red-400    bg-red-500/5
break       → border-yellow-500/30 text-yellow-400 bg-yellow-500/5
offline     → border-border        text-muted-foreground
inactive    → border-border        text-muted-foreground
```

### DispositionBadge Component
```
interested     → border-green-500/30  text-green-400  bg-green-500/5
not_interested → border-red-500/30    text-red-400    bg-red-500/5
connected      → border-blue-500/30   text-blue-400   bg-blue-500/5
vm             → border-yellow-500/30 text-yellow-400 bg-yellow-500/5
no_answer      → border-border        text-muted-foreground
callback       → border-purple-500/30 text-purple-400 bg-purple-500/5
do_not_call    → border-orange-500/30 text-orange-400 bg-orange-500/5
```

---

## 1. LAYOUT — SIDEBAR + MAIN SHELL

### Outer shell
```
<div className="flex h-screen bg-background overflow-hidden">
  <aside>  {/* 208px wide, flex col, border-r border-border, bg-[hsl(224,71%,3%)] */}
  <main>   {/* flex-1, flex col, overflow hidden */}
```

### Sidebar — Logo Section (top)
- Height: ~64px, `px-4 py-4 border-b border-border`
- Left: 28×28px rounded box `bg-primary/20 border border-primary/40` containing `<Radio>` icon in `text-primary`
- Right of icon:
  - Line 1: `"SHIVANSH"` — `text-xs font-bold tracking-widest font-mono text-primary uppercase`
  - Line 2: `"AI Operations"` (admin) or `"Agent Console"` (agent) — `text-[9px] text-muted-foreground font-mono tracking-wider`

### Sidebar — Navigation (middle, scrollable)
- Container: `flex-1 px-2 py-2 space-y-0.5 overflow-y-auto`
- Each nav item: `flex items-center gap-2.5 px-3 py-1.5 rounded text-xs cursor-pointer transition-all`
- **Inactive**: `text-muted-foreground hover:text-foreground hover:bg-white/5`
- **Active**: `bg-primary/15 text-primary border border-primary/25 font-medium`
- Icon: `w-3.5 h-3.5 flex-shrink-0` from lucide-react

#### Admin Nav (14 items, exact order):
| Icon | Label |
|------|-------|
| LayoutDashboard | Dashboard |
| Megaphone | Campaigns |
| List | Lead Lists |
| Bot | AI Agents |
| Mic2 | Voices |
| Tag | Dispositions |
| Users | Users |
| Layers | Queues |
| Activity | Live Monitor |
| PhoneIncoming | DIDs |
| GitBranch | Inbound Routes |
| PhoneCall | CDR |
| BarChart2 | Analytics |
| Settings | Settings |

#### Agent Nav (4 items, exact order):
| Icon | Label |
|------|-------|
| LayoutDashboard | Dashboard |
| Phone | Dialer |
| PhoneMissed | Callbacks |
| PhoneCall | Call History |

### Sidebar — User Footer (bottom)
- `border-t border-border p-3 space-y-2`
- Avatar circle: 28×28px `rounded-full bg-primary/20 border border-primary/30` with user initials `text-[10px] font-bold font-mono text-primary`
- Name: `text-xs text-foreground font-medium truncate`
- Role: `text-[10px] text-muted-foreground truncate capitalize`
- Sign out button: full-width `flex items-center gap-2 px-3 py-1.5 rounded text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10`
- Sign out has `<LogOut className="w-3.5 h-3.5" />` icon

### Agent Status Bar (agents only, above main content)
- Thin bar: `flex items-center justify-end gap-4 px-4 py-1.5 border-b border-border bg-[hsl(224,71%,3%)]`
- Left indicator: green dot `w-1.5 h-1.5 rounded-full bg-green-400` + "SIP: Ready" in `text-[10px] font-mono text-muted-foreground`
- Right: `AgentStatusDropdown` — current status dot + label + `<ChevronDown>` that rotates 180° when open
- Dropdown: `absolute right-0 top-full mt-1 w-36 rounded border border-border bg-[hsl(224,71%,4%)] shadow-xl z-50 py-1`
- Statuses: Available (bg-green-400), Busy (bg-red-400), Break (bg-orange-400), Offline (bg-gray-400)

### PageHeader Component (used on every page)
- `flex items-center justify-between px-6 py-4 border-b border-border`
- Left: Title `text-sm font-bold font-mono tracking-widest text-foreground uppercase` + subtitle `text-xs text-muted-foreground mt-0.5 font-mono`
- Right: optional action slot (buttons)

---

## 2. LOGIN PAGE

### Full page layout
- `min-h-screen w-full flex flex-col items-center justify-center bg-background p-4 relative overflow-hidden`
- Background radial gradient: `absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-primary/10 via-background to-background pointer-events-none`

### Session expired banner (conditional — shows when `?reason=session_expired` in URL)
- `w-full max-w-sm z-10 mb-3`
- `flex items-start gap-2.5 bg-yellow-500/10 border border-yellow-500/30 rounded px-3 py-2.5`
- `<AlertTriangle className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0 mt-0.5" />` + `"Your session expired. Please log in again to continue."` in `text-xs font-mono text-yellow-300`

### Login Card
- `w-full max-w-sm z-10 border-primary/20 bg-card/50 backdrop-blur-xl`
- **CardHeader** (centered, `space-y-2 text-center`):
  - Logo icon box: 48×48px `w-12 h-12 bg-primary/20 rounded-xl flex items-center justify-center mb-2 border border-primary/30 mx-auto`
  - Inside: Phone SVG icon `w-6 h-6 text-primary` (Lucide `Phone` or custom phone icon)
  - Title: `"Terminal Access"` — `text-2xl tracking-tight text-foreground`
  - Description: `"AI Operations Control Center"` — `text-muted-foreground font-mono text-xs`
- **CardContent** — form with `space-y-4`:
  - Label: `"OPERATOR ID (EMAIL)"` — `text-xs font-mono uppercase text-muted-foreground`
  - Email input: `type="email"` — `bg-background/50 border-border focus-visible:ring-primary font-mono text-sm`
  - Label: `"PASSCODE"` — same style
  - Password input: `type="password"` — same input style
  - Submit button: `w-full font-mono uppercase tracking-wider mt-4 hover:shadow-[0_0_15px_rgba(0,255,255,0.3)] transition-all`
  - Button text: `"Initialize Session"` / `"Authenticating..."` when loading

---

## 3. DASHBOARD PAGE (`/`)

### PageHeader
- Title: `"DASHBOARD"`, Subtitle: `"System overview"`

### KPI Stats Row — 4 cards
- `grid grid-cols-2 lg:grid-cols-4 gap-3 p-6`
- Each card: `border border-border rounded p-4 bg-[hsl(224,71%,3%)]`
  - Top row: label `text-[10px] font-mono uppercase tracking-widest text-muted-foreground` + icon right
  - Value: `text-2xl font-bold font-mono text-foreground`
- Cards:
  1. **Active Campaigns** — `<Megaphone className="w-3.5 h-3.5 text-primary">`
  2. **Live Calls** — `<Activity className="w-3.5 h-3.5 text-green-400">`
  3. **Available Agents** — `<Bot className="w-3.5 h-3.5 text-blue-400">`
  4. **Calls Today** — `<PhoneCall>` — card has `accent="bg-purple-500/15 text-purple-400"` background tint

### Two-column grid: Live Calls + Campaign Status
- `grid grid-cols-1 lg:grid-cols-2 gap-4`

#### Live Calls Panel
- Panel header: `<Activity className="w-3.5 h-3.5 text-green-400">` + "LIVE CALLS"
- Animated green pulse dot `ml-auto w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse` (only if calls exist)
- Empty state: `"No active calls"` centered muted mono text
- Each live call row: phone number, campaign name, elapsed time

#### Campaign Status Panel
- Panel header: `<Megaphone className="w-3.5 h-3.5 text-primary">` + "CAMPAIGN STATUS"
- Each row: `flex items-center gap-3 py-2.5 border-b border-border/50 last:border-0`
  - Campaign name `text-xs font-mono text-foreground truncate` + type `text-[10px] text-muted-foreground font-mono uppercase`
  - `<StatusBadge>` right-aligned
- Shows up to 6 campaigns, empty state: "No campaigns"

### Recent Call Records Table (full width)
- `border border-border rounded bg-[hsl(224,71%,3%)]`
- Panel header: `<Clock className="w-3.5 h-3.5 text-primary">` + "RECENT CALL RECORDS"
- Columns: `ID | CAMPAIGN | PROVIDER | STATUS | DISPOSITION | DURATION`
- All text in `text-xs font-mono`
- ID: `#N` in `text-muted-foreground`
- Provider: `uppercase text-muted-foreground`
- Status: `<StatusBadge>`
- Disposition: `<DispositionBadge>` or `"-"` muted
- Duration: `"{n}s"` or `"-"` muted

---

## 4. CAMPAIGNS PAGE (`/campaigns`)

### PageHeader
- Title: `"CAMPAIGNS"`, Subtitle: `"{n} campaigns"`
- Action: `<Button size="sm" className="font-mono text-xs uppercase tracking-wider h-7 px-3">` with `<Plus className="w-3 h-3 mr-1.5">` + "New Campaign"

### Campaign Cards Grid
- `p-6 grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4`
- Each campaign card: `border border-border rounded bg-[hsl(224,71%,3%)] p-4 space-y-3`

#### Campaign Card Anatomy
- **Header row** (`flex items-start justify-between gap-2`):
  - Name: `text-sm font-mono font-semibold text-foreground`
  - Right: `<StatusBadge>` + type badge
  - Type badge:
    - outbound: `border-primary/30 text-primary bg-primary/5 text-[9px] font-mono uppercase`
    - inbound: `border-purple-500/30 text-purple-400 bg-purple-500/5 text-[9px] font-mono uppercase`

- **Stats row**: 3 inline mini-stats `text-[10px] font-mono text-muted-foreground flex items-center gap-4`
  - `<Users className="w-3 h-3">` + `"{n} total"`
  - `<Phone className="w-3 h-3">` + `"{n} called"`
  - `<Clock className="w-3 h-3">` + `"{n} pending"`

- **Info row**: `text-[10px] font-mono text-muted-foreground`
  - Agent name if set + from number if set + `"Max: {n} concurrent"` if set

- **Footer actions** (`flex items-center gap-2 pt-1`):
  - **Test Call**: `text-[10px] border border-yellow-500/30 text-yellow-400 bg-yellow-500/5 hover:bg-yellow-500/10 px-2.5 py-1 rounded flex items-center gap-1` + `<Zap className="w-2.5 h-2.5">`
  - **Launch** (if not active): `border-green-500/30 text-green-400 bg-green-500/5 hover:bg-green-500/10` + `<Rocket className="w-2.5 h-2.5">`
  - **Pause** (if active): `border-yellow-500/30 text-yellow-400` + `<Pause className="w-2.5 h-2.5">`
  - **Resume** (if paused): `border-green-500/30 text-green-400` + `<Play className="w-2.5 h-2.5">`

### Create Campaign Modal (multi-step wizard)
- `bg-[hsl(224,71%,3%)] border border-border rounded w-full max-w-xl flex flex-col max-h-[90vh]`
- Header: `flex items-center justify-between px-4 py-3 border-b border-border`
  - `<Plus className="w-3.5 h-3.5 text-primary">` + `"NEW CAMPAIGN"` + `<X className="w-4 h-4">`

#### Step Indicator
- `flex items-center gap-1 px-4 pt-4 shrink-0`
- Steps: `["Basics", "Agent & Voice", "Schedule", "Review"]`
- Each step circle: `w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-mono border`
  - Active: `bg-primary/20 border-primary text-primary`
  - Completed: `bg-primary/10 border-primary/30 text-primary/60`
  - Future: `bg-white/5 border-border text-muted-foreground`
- Step label: `text-[10px] font-mono` same color as circle
- Separator between steps: `<ChevronRight className="w-3 h-3 text-muted-foreground/40">`

#### Step 1: Basics
- Campaign Name: `<Input required>` with label "CAMPAIGN NAME"
- Campaign Type: two toggle buttons — Outbound / Inbound (active = `bg-primary/10 border-primary text-primary`)
- Description: `<Textarea>` optional, `min-h-[80px] resize-none`

#### Step 2: Agent & Voice
- Agent: `<Select>` from agents list, label "AI AGENT"
- Max Concurrent Calls: `<Input type="number">` default 1
- Transfer Number: `<Input>` optional, placeholder "+1XXXXXXXXXX"
- Routing Type: `<Select>` — Round Robin / Priority / Sequential

#### Step 3: Schedule
- Timezone: `<Select>` with common timezones
- Start Time + End Time: `<Input type="time">` in 2-col grid
- Working Days: 7 checkboxes (Mon Tue Wed Thu Fri Sat Sun)
- Note text: `"Leave blank to run 24/7"`

#### Step 4: Review
- Summary card: `bg-primary/5 border border-primary/20 rounded p-3`
- Each field row: muted label + foreground value in font-mono

#### Modal Footer
- `flex gap-2 px-4 py-3 border-t border-border shrink-0`
- Step > 0: Back button (outline left)
- Step 0: Cancel button (outline left)
- Step < last: Next button (primary right) + `<ChevronRight className="w-3 h-3 ml-1">` — disabled if step 0 and name empty
- Last step: "Create Campaign" button with `<Check className="w-3 h-3 mr-1">`

### Launch Campaign Modal
- `max-w-lg`, `max-h-[90vh]` with scrollable body
- Header: `<Rocket className="w-3.5 h-3.5 text-primary">` + "LAUNCH CAMPAIGN" + `<X>`

**Body sections (scrollable)**:

1. **Campaign info banner**: `bg-primary/5 border border-primary/20 rounded p-3 flex items-center justify-between`
   - Campaign name: `text-sm font-mono font-medium text-foreground`
   - Right: total leads count `<Users className="w-3 h-3">` + pending leads with colored dot

2. **Warning: all called** (if pending=0 and total>0): `border-yellow-500/20 bg-yellow-500/5 rounded p-3`
   - Message in yellow mono text
   - Checkbox with label "Re-call all leads (reset to pending)"

3. **No leads warning** (if total=0): yellow panel "No leads yet."

4. **Caller Number (From)**: `<Select>` with all phone numbers, label has `<Phone className="w-3 h-3">`

5. **Voice** (VoicePicker): `<Select>` or custom picker with play preview buttons per voice, label has `<Mic2 className="w-3 h-3">` + "(▶ to preview)"

6. **Background Ambience + Transfer Hold Music**: 2-col grid of `<Select>`:
   - Background options: None (silent) / Office Environment / Typing Sounds / Café Background
   - Hold Music options: None (silence) / Smooth Jazz / Corporate Upbeat / Relaxing Ambient / Light Classical

7. **Human-Like Mode toggle**: `flex items-center justify-between rounded border border-border px-3 py-2.5`
   - Left: `"Human-Like Mode"` `text-xs font-mono font-medium` + `"Natural fillers, pauses & empathy"` description `text-[10px] font-mono text-muted-foreground`
   - Right: Custom pill toggle `h-5 w-9` — ON: `bg-primary`; OFF: `bg-muted`; white `h-4 w-4` thumb slides

8. **Agent Script / Prompt Override** (collapsible):
   - Toggle: `<FileText className="w-3 h-3">` + "AGENT SCRIPT / PROMPT OVERRIDE" + `<ChevronRight>` rotates 90° when open
   - Body: `<Textarea className="font-mono text-xs min-h-[120px] resize-none">` placeholder "Override the agent script..."

**Footer**:
- Cancel (outline, flex-1) + Launch (green, flex-1)
- Launch: `bg-green-600 hover:bg-green-700 text-white`
- Loading: `w-2 h-2 rounded-full bg-white animate-pulse` + "Launching..."
- Ready: `<Rocket className="w-3 h-3">` + `"Launch (N leads)"` (N = effective pending count)
- Disabled when no effective pending leads

### Test Call Modal
- `max-w-lg`, scrollable body
- Header: `<Zap className="w-3.5 h-3.5 text-yellow-400">` + "TEST CALL" + `<span text-muted-foreground>— {campaign.name}</span>` + `<X>`

**Body**:

1. **System Status Row**: `flex items-center gap-4 text-[10px] font-mono`
   - API Server: colored dot (null=yellow pulse, ok=green, err=red) + "API Server: online/offline/checking..."
   - Worker: `w-1.5 h-1.5 rounded-full bg-green-400` + "Worker: ai-voice-worker1.replit.app" in green
   - From: `<Phone className="w-2.5 h-2.5">` + campaign.fromNumber or "default"

2. **Phone Number input**: label "TARGET PHONE NUMBER" + `flex gap-2`
   - Input: `font-mono text-sm flex-1` placeholder `"+1XXXXXXXXXX"`
   - Fire Call button: `bg-yellow-500 hover:bg-yellow-600 text-black font-mono text-xs uppercase tracking-wider shrink-0`
   - Loading: black `w-2 h-2 rounded-full bg-black animate-pulse` + "Firing..."
   - Ready: `<Zap className="w-3 h-3">` + "Fire Call"
   - Helper text: `"Uses the full campaign config (prompt, voice, background sound, hold music)"` muted mono

3. **Result panel** (conditional, after fire):
   - Success: `border-green-500/30 bg-green-500/5 rounded border px-3 py-2.5`
     - `<CheckCircle2 className="w-3.5 h-3.5 text-green-400">` + "Call queued successfully" in green
     - Grid `grid-cols-2 gap-x-4 text-[10px] font-mono text-muted-foreground pl-5`:
       - Job ID / To phone / From number / Voice
   - Failure: `border-red-500/30 bg-red-500/5`
     - `<AlertCircle className="w-3.5 h-3.5 text-red-400">` + "Call failed" in red
     - Error text below

4. **Recent Calls table** for this campaign:
   - Label `<Activity className="w-3 h-3">` + "RECENT CALLS — {campaign.name}" + Refresh button right
   - `border border-border rounded overflow-hidden`
   - Columns: `# | PHONE | STATUS | TIME`
   - Status with icon: completed=`<CheckCircle2 text-green-400>`, failed=`<AlertCircle text-red-400>`, initiated=`<Clock text-yellow-400>`, other=`<Activity text-blue-400>`

**Footer**: Close button (outline, full-width)

---

## 5. LEADS PAGE (`/leads`)

### PageHeader
- Title: `"LEAD LISTS"`, Subtitle: `"{n} leads total"`
- Action: `"Add Leads"` button with `<Upload className="w-3 h-3 mr-1.5">`

### Filters Bar
- `flex flex-wrap items-center gap-3 px-6 py-3 border-b border-border`
- Campaign filter: `<Select>` — All Campaigns + each campaign
- Status filter: `<Select>` — All / Pending / Called / Callback / Completed / Failed
- Search: input with `<Search className="absolute left-3 w-3.5 h-3.5 text-muted-foreground">` icon, `pl-8 font-mono text-sm`
- Right: "Export CSV" `<Button variant="outline" size="sm">`

### Leads Table
- Columns: `CONTACT | PHONE | CAMPAIGN | STATUS | CALLBACK TIME | ACTIONS`
- Contact cell: Name `text-foreground font-medium` + email `text-[10px] text-muted-foreground` below
- Phone: `text-foreground`
- Campaign: campaign name or `#id` muted
- Status: `<StatusBadge>`
- Callback Time: formatted short date or `—`
- Actions: `"Call Back"` button `border border-green-500/30 text-green-400 hover:bg-green-500/10 flex items-center gap-1 px-2.5 py-1 rounded text-[10px] ml-auto` + `<Phone className="w-2.5 h-2.5">`
- Empty state: `<CheckCircle2 className="w-6 h-6 text-green-400/50">` + "No leads found"
- Footer: `"Showing N leads"` centered `text-[10px] font-mono text-muted-foreground`

### Add Leads Modal
- `max-w-xl`
- Header: `<Upload>` + "ADD LEADS" + `<X>`
- Campaign selector (required)
- CSV drop zone: `border-2 border-dashed border-border rounded-lg p-8 text-center cursor-pointer hover:border-primary/40 hover:bg-primary/5 transition-all`
  - `<Upload className="w-8 h-8 text-muted-foreground mx-auto mb-3">`
  - "Drop CSV file here or click to browse" `text-sm font-mono text-muted-foreground`
  - Format note: `text-[10px] font-mono text-muted-foreground/60 mt-1`
- OR: Expandable manual entry — textarea one phone per line
- Submit: "Import Leads" button

---

## 6. VOICES PAGE (`/voices`)

### PageHeader
- Title: `"VOICES"`, Subtitle: `"{n} voices configured"`
- Action: `"Add Voice"` with `<Plus>`

### Voice Cards Grid
- `p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4`
- CSS required in page: `@keyframes wave { from { transform: scaleY(0.4); } to { transform: scaleY(1); } }`

#### VoiceCard
- Container: `border rounded bg-[hsl(224,71%,3%)] p-4 space-y-3 transition-all`
- Playing: `border-primary/40 shadow-[0_0_12px_rgba(0,255,255,0.08)]`
- Default: `border-border`

**Header row** (`flex items-start justify-between`):
- Icon box 28×28px `rounded flex items-center justify-center transition-all`
  - Playing: `bg-primary/20` + `<Volume2 className="w-3.5 h-3.5 text-primary animate-pulse">`
  - Idle: `bg-primary/10` + `<Mic2 className="w-3.5 h-3.5 text-primary">`
- Name: `text-sm font-mono font-medium text-foreground`
- Provider: `text-[10px] font-mono text-muted-foreground uppercase` ("ElevenLabs" / "PlayHT" / "Azure")
- Gender badge (top-right):
  - female: `border-pink-500/30 text-pink-400 bg-pink-500/5 text-[10px] font-mono px-1.5 py-0.5 rounded border`
  - male: `border-blue-500/30 text-blue-400 bg-blue-500/5`

**Meta rows**:
- `<User className="w-3 h-3 flex-shrink-0">` + voice ID (truncated) — `text-[10px] font-mono text-muted-foreground flex items-center gap-1.5`
- `<Globe className="w-3 h-3">` + accent + language — same style
- Description if present: `text-[10px] font-mono text-muted-foreground/60 truncate`

**Waveform Visualizer** (only when playing):
- `flex items-end gap-0.5 h-5 px-1`
- 16 bars: `flex-1 bg-primary/60 rounded-sm`
- Each bar: `height: ${30 + Math.sin(i * 0.8) * 50}%`
- Animation: `wave ${0.5 + (i % 3) * 0.15}s ease-in-out infinite alternate`
- Delay: `${i * 0.04}s`

**Play/Stop button** (full width):
- `w-full flex items-center justify-center gap-1.5 py-1.5 rounded text-[11px] font-mono border transition-all`
- Playing: `border-primary/40 bg-primary/10 text-primary hover:bg-primary/15` + `<Square className="w-3 h-3">` "Stop"
- Loading: `opacity-70 cursor-not-allowed` + `<Loader2 className="w-3 h-3 animate-spin">` "Generating…"
- Ready with preview: `border-border bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10` + `<Play className="w-3 h-3">` "Play Sample"
- Ready can generate: same + "Generate Sample"
- No preview: `border-border/30 text-muted-foreground/40 cursor-not-allowed select-none` + `<Mic2>` "No preview available"

### Add Voice Modal
- `max-w-md`
- Header: "ADD VOICE" + `<X>`
- Display Name: full-width input placeholder "e.g. Sarah US Female"
- 2-col grid: Provider select (ElevenLabs/PlayHT/Azure) + Gender select (Female/Male)
- Voice ID: input placeholder "e.g. EXAVITQu4vr4xnSDxMaL" + helper text `"The provider-specific voice identifier used in API calls"` in `text-[10px] text-muted-foreground font-mono`
- 2-col grid: Accent select (US/UK/Indian/Australian/Canadian/Other) + Language Code input placeholder "en"
- Submit: "Add Voice" button

---

## 7. CALLS PAGE / CDR (`/calls`)

### PageHeader
- Title: `"CDR"`, Subtitle: `"Call detail records"`

### Tab Bar
- `flex gap-1 px-6 py-3 border-b border-border`
- Two tabs: "CDR" and "Campaign Logs"
- Active: `bg-primary/10 border border-primary/20 text-primary font-mono text-xs uppercase tracking-wider px-3 py-1.5 rounded`
- Inactive: `text-muted-foreground hover:text-foreground hover:bg-white/5 font-mono text-xs uppercase tracking-wider px-3 py-1.5 rounded transition-colors`

### CDR Tab
- Filters: `flex gap-2 px-6 py-3` — Campaign select + Status select + Search input (same as Leads page)
- Table: `border border-border rounded bg-[hsl(224,71%,3%)] overflow-hidden mx-6 mt-3`

**CDR Table Columns**: `# | CAMPAIGN | LEAD | DIRECTION | PROVIDER | STATUS | DISPOSITION | DURATION | DATE | ACTIONS`

- `#` = `#{id}` muted
- Direction:
  - outbound: `<ArrowUpRight className="w-3 h-3 text-blue-400">` + "Out" in `text-[10px] text-blue-400`
  - inbound: `<ArrowDownLeft className="w-3 h-3 text-green-400">` + "In" in green
- Status: `<StatusBadge>`
- Disposition: `<DispositionBadge>` or `—`
- Duration: `"{n}s"` or `—`
- Date: short formatted date
- ACTIONS: expand/collapse toggle button `text-[10px] border border-border rounded px-2 py-0.5 font-mono text-muted-foreground hover:text-foreground`
  - Collapsed: "Expand ▾"
  - Expanded: "Collapse ▴"

**Expandable Row** (spans all columns, `colSpan={10}` or however many):
- `bg-white/[0.015] border-t border-border/30`
- `grid grid-cols-3 gap-4 px-4 py-3`

  **Col 1 — Disposition Updater**:
  - Label `"DISPOSITION"` muted mono + current badge
  - Native `<select>` all disposition values → on change: `PATCH /api/calls/:id` with `{ disposition }`
  - `w-full bg-background border border-border rounded px-2 py-1 text-xs font-mono text-foreground mt-1`
  - After save: refetch

  **Col 2 — Export**:
  - Label `"EXPORT"` muted mono
  - Two buttons side-by-side: `flex gap-1.5 mt-1`
    - TXT: `<FileText className="w-3 h-3">` + "TXT"
    - PDF: `<Download className="w-3 h-3">` + "PDF"
    - Both: `flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-border text-muted-foreground hover:text-foreground hover:bg-white/5 font-mono`
    - Fetch with auth header → blob → object URL → auto-download as `call-{id}.txt` or `call-{id}.pdf`

  **Col 3 — Recording**:
  - Label `"RECORDING"` muted mono
  - If URL: `<a>` link button `flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-border text-muted-foreground hover:text-foreground mt-1` + `<ExternalLink className="w-3 h-3">` + "Listen"
  - If none: `"—"` in muted

### Campaign Logs Tab
- Same filter bar
- Columns: `# | PHONE | CAMPAIGN | DIRECTION | STATUS | DISPOSITION | DURATION | TIME | ACTIONS`
- Same expandable row pattern

---

## 8. AI AGENTS PAGE (`/agents`)

### PageHeader
- Title: `"AI AGENTS"`, Subtitle: `"{n} deployed"`
- Action: `"New Agent"` + `<Plus>` (h-7 small)

### Agents Grid
- `p-6 grid grid-cols-1 lg:grid-cols-2 gap-3`
- Each card: `border border-border rounded bg-[hsl(224,71%,3%)] p-4 space-y-3`

**Card structure**:
- Header: `flex items-start justify-between gap-2`
  - Left: icon box 28×28px `bg-primary/15 border border-primary/25 rounded` + `<Bot className="w-3.5 h-3.5 text-primary">`
  - Name `text-xs font-mono font-semibold text-foreground` + language `text-[10px] font-mono text-muted-foreground uppercase`
  - Right: Voice badge (if assigned) `border-primary/30 text-primary/70 text-[9px] font-mono` + `<Mic className="w-2 h-2 mr-1">` + "Voice #N"
- Prompt: `text-[11px] font-mono text-muted-foreground leading-relaxed line-clamp-3`
- Footer: `border-t border-border/50 pt-1` + "Agent ID #N" `text-[10px] font-mono text-muted-foreground/60`

### Create Agent Modal
- `max-w-lg`
- Header: "NEW AI AGENT" + `<X>`
- Agent Name: full-width input (required)
- 2-col: Language input (default "en") + Default Voice `<Select>` ("Select voice" placeholder)
- System Prompt: `<Textarea className="font-mono text-sm min-h-[120px] resize-none">` placeholder "You are a professional sales representative..."
- Submit: "Deploy Agent"

---

## 9. USERS / TEAM PAGE (`/users`)

### PageHeader
- Title: `"TEAM"`, Subtitle: `"{n} members"`
- Action: `"Add Member"` + `<Plus>`

### Users Table
- `border border-border rounded bg-[hsl(224,71%,3%)] overflow-hidden mx-6`
- Columns: `MEMBER | EMAIL | ROLE | STATUS`
- Member cell: `flex items-center gap-2.5`
  - Icon box 24×24px `bg-primary/10 border border-primary/20` with role icon
  - admin → `<ShieldCheck className="w-3 h-3 text-primary">`
  - supervisor → `<Shield className="w-3 h-3 text-primary">`
  - agent → `<User className="w-3 h-3 text-primary">`
  - Name `text-foreground font-medium`
- Email: `text-muted-foreground`
- Role badges:
  - admin: `border-cyan-500/30 text-cyan-400 bg-cyan-500/5`
  - supervisor: `border-purple-500/30 text-purple-400 bg-purple-500/5`
  - agent: `border-border text-muted-foreground`
- Status: `<StatusBadge>`

### Add Team Member Modal
- `max-w-md`
- Header: "ADD TEAM MEMBER" + `<X>`
- Full Name input, Email input, Password input (minLength=8), Role select (Agent/Supervisor/Admin)
- Submit: "Add Member"

---

## 10. PHONE NUMBERS / DIDs PAGE (`/numbers`)

### PageHeader
- Title: `"PHONE NUMBERS"`, Subtitle: `"{n} configured"`
- Action: `"Add Number"` + `<Plus>`

### Numbers Table
- Columns: `NUMBER | PROVIDER | CAMPAIGN | PRIORITY | STATUS`
- Number: `text-foreground font-mono font-medium`
- Provider badges:
  - voip: `border-blue-500/30 text-blue-400 bg-blue-500/5`
  - telnyx: `border-purple-500/30 text-purple-400 bg-purple-500/5`
  - twilio: `border-red-500/30 text-red-400 bg-red-500/5`
- Campaign: name or "Unassigned" in muted
- Priority: number in muted
- Status: `<StatusBadge>`

### Add Phone Number Modal
- `max-w-md`
- Header: "ADD PHONE NUMBER" + `<X>`
- Phone Number: input placeholder "+14155550100" with label "PHONE NUMBER (E.164)"
- 2-col: Provider select (VoIP/Telnyx/Twilio) + Priority number input min=1
- Campaign: `<Select>` "Unassigned" + all campaigns
- Submit: "Add Number"

---

## 11. DIALER PAGE (`/dialer`) — Agent Only

### PageHeader
- Title: `"DIALER"`, Subtitle: `"Telnyx WebRTC Softphone"`
- Action right: SIP status badge — dot + label in `text-[10px] font-mono text-muted-foreground`:
  - disconnected: `bg-gray-400` dot + "SIP: Offline"
  - connecting: `bg-yellow-400 animate-pulse` dot + "SIP: Connecting…"
  - connected: `bg-green-400` dot + "SIP: Ready"
  - error: `bg-red-400` dot + "SIP: Error"

### Page body: `p-6 flex justify-center` → inner `w-full max-w-sm space-y-4`

#### Caller ID Selector
- Label: `"CALLER ID"` `text-[10px] font-mono uppercase text-muted-foreground block mb-1`
- `<select className="w-full bg-background border border-border rounded px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary">` — disabled when in call
- Options: `{number} — {friendlyName}` or just `{number}`
- If no numbers: "No numbers configured"

#### Active Call Overlay (shows when callState ≠ "idle")
- Panel: `rounded-lg border p-4 text-center`
- active: `border-green-500/40 bg-green-500/5`
- ringing: `border-yellow-500/40 bg-yellow-500/5 animate-pulse`
- calling/held: `border-border bg-white/[0.02]`
- Icon + state label row: `flex items-center justify-center gap-2 mb-1`
  - calling: `<Loader2 className="w-3.5 h-3.5 text-primary animate-spin">`
  - ringing: `<PhoneIncoming className="w-3.5 h-3.5 text-yellow-400">`
  - active: `<PhoneCall className="w-3.5 h-3.5 text-green-400">`
  - Label: `font-mono text-xs capitalize text-muted-foreground`
- Phone number: `font-mono text-lg text-foreground`
- Timer (active only): `font-mono text-xl text-green-400 mt-1` — MM:SS counting up live

#### Dial Pad Card: `bg-[hsl(224,71%,3%)] border border-border rounded-lg p-4`
- **Number display**: `flex items-center gap-2 min-h-[44px] mb-4`
  - `flex-1 text-xl font-mono text-foreground tracking-widest text-center` — number or `<span className="text-muted-foreground text-base">Enter number...</span>`
  - Delete button (if number): `<Delete className="w-4 h-4">` in muted, hover foreground
- **Digits**: `grid grid-cols-3 gap-2 mb-3`
  - Layout rows: [1,2,3] [4,5,6] [7,8,9] [*,0,#]
  - Each: `h-12 rounded-lg bg-white/5 hover:bg-white/10 border border-border/50 hover:border-border font-mono text-lg text-foreground transition-all active:scale-95 disabled:opacity-40`
  - Disabled when callState === "ringing"
- **Manual input**: `<Input className="font-mono text-sm text-center mb-4">` placeholder `"+1XXXXXXXXXX"` — disabled when in call
- **Call Button** (when idle):
  - `w-full h-12 bg-green-600 hover:bg-green-700 text-white font-mono uppercase tracking-wider text-sm`
  - SIP connecting: `<Loader2 className="w-4 h-4 animate-spin">` + "Connecting SIP…"
  - SIP ready: `<Phone className="w-4 h-4">` + "Call"
  - Disabled if not connected or no number typed
- **In-call controls**: `flex gap-2`
  - **Mute** (flex-1, h-12): `rounded-lg border font-mono text-xs flex items-center justify-center gap-1.5 transition-all`
    - Muted: `border-red-500/50 bg-red-500/10 text-red-400` + `<MicOff>` "Unmute"
    - Active: `border-border bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10` + `<Mic>` "Mute"
    - Disabled (not active call): `opacity-40 cursor-not-allowed`
  - **Answer** (flex-1, h-12 — only when ringing): `rounded-lg border border-green-500/40 bg-green-500/10 text-green-400 hover:bg-green-500/20` + `<Phone>` "Answer"
  - **Hang Up** (flex-1, h-12): `rounded-lg bg-red-600 hover:bg-red-700 text-white font-mono text-xs flex items-center justify-center gap-1.5` + `<PhoneOff>` "Hang Up"

#### Reconnect Button (disconnected or error state only)
- `w-full flex items-center justify-center gap-2 py-2 rounded border border-border text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-white/5 transition-all`
- `<Radio className="w-3 h-3">` + "Reconnect SIP"

#### Error Alert (error state only)
- `flex items-start gap-2 bg-red-500/5 border border-red-500/20 rounded px-3 py-2`
- `<AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5">` + `"SIP connection failed. Check your network and click Reconnect."` in `text-[10px] font-mono text-red-300`

---

## 12. CALLBACKS PAGE (`/callbacks`) — Agent Only

### PageHeader
- Title: `"CALLBACKS"`, Subtitle: `"{n} leads awaiting callback"`
- Action: Refresh button `variant="outline" size="sm"` with `<RefreshCw className="w-3 h-3 mr-1.5">` + "Refresh"

### Search input: full-width, `pl-8`, `<Search>` icon, placeholder "Search by phone or name..."

### Callbacks Table
- `border border-border rounded bg-[hsl(224,71%,3%)] overflow-hidden`
- Columns: `CONTACT | PHONE | CAMPAIGN | ⏰ QUEUED | ACTION`
- QUEUED header: `flex items-center gap-1` with `<Clock className="w-2.5 h-2.5">` + "Queued"
- Contact: Name `text-foreground font-medium` + email `text-[10px] text-muted-foreground` below
- Phone: `text-foreground`
- Campaign: name or `#id` muted
- Queued time: short formatted date (e.g. "Apr 11, 02:30 PM") or `—`
- ACTION (right-aligned):
  - `flex items-center gap-1 px-2.5 py-1 rounded text-[10px] border border-green-500/30 text-green-400 hover:bg-green-500/10 transition-colors ml-auto disabled:opacity-50`
  - Ready: `<Phone className="w-2.5 h-2.5">` + "Call Back"
  - Calling: `<RefreshCw className="w-2.5 h-2.5 animate-spin">` + "Calling..."
- Empty state: `<CheckCircle2 className="w-6 h-6 text-green-400/50">` + "No callback leads — you're all caught up!"
- Footer: `"Showing N callbacks · auto-refreshes every 30s"` centered muted `text-[10px] font-mono`

---

## 13. QUEUES PAGE (`/queues`)

### PageHeader: Title "QUEUES", Subtitle "Call queue status and throughput"

### Stats Row (4 cards, `grid grid-cols-2 lg:grid-cols-4 gap-3`):
Each `border border-border rounded p-4 bg-[hsl(224,71%,3%)]`:
- Top row: label `text-[10px]` + icon right
- Value: `text-2xl font-bold font-mono text-foreground`
1. Active Queues — `<Layers className="w-3.5 h-3.5 text-primary">`
2. In Progress — `<Clock className="w-3.5 h-3.5 text-cyan-400">`
3. Pending — `<AlertCircle className="w-3.5 h-3.5 text-yellow-400">`
4. Completed — `<CheckCircle className="w-3.5 h-3.5 text-green-400">`

### Campaign Queues Table
- Panel header: `<Layers className="w-3.5 h-3.5 text-primary">` + "CAMPAIGN QUEUES"
- Columns: `CAMPAIGN | TYPE | ROUTING | CONCURRENCY | ACTIVE CALLS | STATUS`
- Active Calls cell: `flex items-center gap-2`
  - Progress bar: `w-16 h-1.5 bg-white/10 rounded overflow-hidden` with colored fill:
    - >75% util: `bg-red-400`
    - >40% util: `bg-yellow-400`
    - else: `bg-green-400`
  - Count: `text-muted-foreground`
- Status: `<Badge variant="outline">` green/yellow/muted
- Routing: replace `_` with space

---

## 14. LIVE MONITOR PAGE (`/live-monitor`)

### PageHeader
- Title: `"LIVE MONITOR"`, Subtitle: `"Real-time call activity"`
- Action: WebSocket status — `flex items-center gap-1.5 text-[10px] font-mono`
  - Connected: `text-green-400` + `<Wifi className="w-3 h-3">` + "Live · connected"
  - Disconnected: `text-red-400` + `<WifiOff className="w-3 h-3">` + "Reconnecting…"

### Stats Row (4 cards, `grid grid-cols-2 lg:grid-cols-4 gap-3`):
Each: `border border-border rounded p-4 bg-[hsl(224,71%,3%)] flex items-start justify-between gap-2`
- Left: label + colored `text-2xl font-bold font-mono` value
- Right: 32×32px icon box `w-8 h-8 rounded flex items-center justify-center bg-white/5 border border-border`
1. Active Calls — `text-green-400` — `<Phone className="w-4 h-4">`
2. Active Campaigns — `text-primary` — `<Megaphone className="w-4 h-4">`
3. Available Agents — `text-blue-400` — `<Users className="w-4 h-4">`
4. Success Rate Today — `text-yellow-400` — `<TrendingUp className="w-4 h-4">` — shows `"{n}%"`

### Active Calls Section
- Section header: `<Activity className="w-3.5 h-3.5 text-green-400">` + "ACTIVE CALLS" + green count `"({n})"` in `text-green-400`
- Empty state: icon circle `w-10 h-10 rounded-full bg-white/5 border border-border` + `<PhoneMissed className="w-5 h-5 text-muted-foreground/40">` + "No active calls right now" + connection hint
- Grid: `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3`

#### LiveCallCard
- `border border-green-500/20 rounded bg-[hsl(224,71%,3%)] p-4 space-y-3 relative overflow-hidden group hover:border-green-500/40 transition-colors`
- Top accent line: `absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r from-green-400/0 via-green-400/70 to-green-400/0 animate-pulse`
- Header: `flex items-start justify-between gap-2`
  - Left: `<span className="w-2 h-2 rounded-full bg-green-400 animate-pulse flex-shrink-0">` + phone/lead info
  - Right: "Live" badge + elapsed timer `text-[11px] font-mono font-bold text-green-400 tabular-nums`
- Info grid `grid grid-cols-2 gap-2 text-[10px] font-mono`:
  - `<Megaphone className="w-3 h-3 flex-shrink-0 text-primary/60">` + campaign name (truncate)
  - `<Bot className="w-3 h-3 flex-shrink-0 text-blue-400/60">` + "Agent #N" or "AI Agent"
  - `<Phone className="w-3 h-3 flex-shrink-0 text-muted-foreground/60">` + provider uppercase
  - `<Zap className="w-3 h-3 flex-shrink-0 text-yellow-400/60">` + from number (truncate)

### Event Log + Running Campaigns (2/3 + 1/3)
`grid grid-cols-1 lg:grid-cols-3 gap-4`

#### Event Log (lg:col-span-2)
- `border border-border rounded bg-[hsl(224,71%,3%)] flex flex-col` — fixed height 320px
- Header: `<Activity className="w-3.5 h-3.5 text-primary">` + "EVENT STREAM" + event count + green pulse dot right
- Body: scrollable, `divide-y divide-border/30`
  - Auto-scrolls to latest; "↓ scroll to latest" button appears when scrolled up
- Empty: `<Activity className="w-5 h-5 text-muted-foreground/30">` + "Waiting for events…"
- Each event: `flex items-start gap-3 px-4 py-2 hover:bg-white/2`
  - Time: `text-[9px] font-mono text-muted-foreground/50 w-16 flex-shrink-0 tabular-nums pt-0.5`
  - Icon: `w-3 h-3 flex-shrink-0 mt-0.5` with event color
  - Message: `text-[11px] font-mono` + optional detail in muted

Event type → icon → color:
```
call:queued      → <Clock>          → text-yellow-400
call:started     → <Phone>          → text-green-400
call:ended       → <CheckCircle2>   → text-blue-400
call:transferred → <ArrowRightLeft> → text-purple-400
call:inbound     → <PhoneIncoming>  → text-cyan-400
agent_status     → <Bot>            → text-muted-foreground
call_update      → <Activity>       → text-muted-foreground
campaign:started → <Megaphone>      → text-primary
campaign:stopped → <XCircle>        → text-red-400
connected        → <Wifi>           → text-green-400
```

#### Running Campaigns Panel (1/3)
- `border border-border rounded bg-[hsl(224,71%,3%)]` — maxHeight 320px, overflow-y auto
- Sticky header: `<Megaphone className="w-3.5 h-3.5 text-primary">` + "RUNNING CAMPAIGNS"
- Each campaign: `px-4 py-3 divide-y divide-border/30`
  - `flex items-center justify-between gap-2` — name + green pulse dot
  - Progress bar `h-1 bg-white/10 rounded-full` + `bg-primary/60` fill
  - `"{called} / {total} leads"` `text-[9px] font-mono text-muted-foreground`

### Bottom Stats (2-col)
- Total Calls Today: `text-xl font-bold font-mono text-foreground`
- Completed Today: `text-xl font-bold font-mono text-blue-400`

---

## 15. INBOUND ROUTES PAGE (`/inbound-routes`)

### PageHeader: Title "INBOUND ROUTES", Subtitle "{n} inbound routes configured"

### Telnyx Webhook Configuration Card
- Header: `<Zap className="w-3.5 h-3.5 text-primary">` + "TELNYX WEBHOOK CONFIGURATION"
- Description paragraph
- Webhook URL box: `rounded border border-primary/20 bg-primary/5 px-3 py-2.5 flex items-center gap-2`
  - `<Terminal className="w-3.5 h-3.5 text-primary flex-shrink-0">` + URL in `font-mono text-xs text-primary flex-1 truncate`
  - Copy button: icon toggles `<Copy>` → `<CheckCheck text-green-400>` after 2s
- Setup Steps numbered list (6 steps):
  - Each: circle `w-4 h-4 rounded-full bg-primary/10 border border-primary/20 text-primary text-[9px]` + step text `text-[10px] font-mono text-muted-foreground leading-relaxed pt-0.5`
- Warning amber panel: `border-amber-500/20 bg-amber-500/5 px-3 py-2` + `<Shield className="w-3.5 h-3.5 text-amber-400">` + text

### AI Greeting Behavior Card
- Header: `<MessageSquare className="w-3.5 h-3.5 text-primary">` + "AI GREETING BEHAVIOR"
- Flow diagram: `flex flex-wrap items-center gap-2 text-[10px] font-mono`
  - Nodes with `<ArrowRight className="w-3 h-3 text-muted-foreground/40">` separators
  - Call Received → `bg-blue-500/10 border-blue-500/20 text-blue-400`
  - Auto-Answer → `bg-green-500/10 border-green-500/20 text-green-400`
  - Greeting Spoken → `bg-primary/10 border-primary/20 text-primary`
  - Transfer / Gather → `bg-amber-500/10 border-amber-500/20 text-amber-400`
- Greeting template box: `border border-border bg-black/20 px-3 py-2.5`
  - Label `text-[9px] font-mono uppercase text-muted-foreground/60 mb-1.5`
  - `"Thank you for calling ` `[Campaign Name]` (in `text-primary`) `. This is ` `[Agent Name]` (in `text-primary`) `. How may I help you today?"`
- Transfer logic note `text-[10px] font-mono text-muted-foreground/60`

### Active Inbound Routes (list)
- Section label `text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-3`
- Empty state: dashed border card, icon circle, instruction
- Each route card: `border border-border rounded bg-[hsl(224,71%,3%)] p-4 space-y-4`
  - Header: name + status badge + agent badge `border-primary/20 bg-primary/5 text-primary flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded`
  - Greeting preview: `border border-border bg-black/20 px-3 py-2` — italic preview text
  - Assigned numbers: flex-wrap chips `border-border text-[10px] font-mono text-muted-foreground flex items-center gap-1 px-2 py-1 rounded`
  - Transfer: `<ArrowRight className="w-3 h-3 text-primary">` + "After greeting: transfer to {number}"

### Unassigned DIDs Card
- Header: `<Phone className="w-3.5 h-3.5 text-muted-foreground">` + "UNASSIGNED DIDS"
- Flex-wrap of DID chips or "All DIDs are assigned"

---

## 16. ANALYTICS PAGE (`/analytics`)

### PageHeader: Title "ANALYTICS", Subtitle "Platform performance metrics"

### Stats Row (4 cards):
Each: label + icon (`text-primary`) + big value + sub-text `text-[10px] font-mono text-muted-foreground mt-1`
1. Total Calls — `<Phone>` — "all time"
2. Completed — `<Target>` — "{N}% completion"
3. Avg Duration — `<TrendingUp>` — "{n}s per completed call"
4. Total Leads — `<BarChart2>` — "across N campaigns"

### Two-column charts:
`grid grid-cols-1 lg:grid-cols-2 gap-4`

#### Disposition Breakdown (MiniBarChart):
- `border border-border rounded bg-[hsl(224,71%,3%)] p-4`
- Label "DISPOSITION BREAKDOWN" muted mono
- Each disposition bar row: `flex items-center gap-3 text-[11px] font-mono`
  - Label: `w-24 text-muted-foreground truncate`
  - Track: `flex-1 h-4 bg-white/5 rounded overflow-hidden`
  - Fill: per-color `opacity-70` width proportional; count inside right if > 0: `text-[9px] text-white font-bold pr-1.5`
  - Count right: `w-6 text-right text-muted-foreground`

#### Calls by Provider:
- Same MiniBarChart — 3 rows: VOIP (bg-blue-400), TELNYX (bg-purple-400), TWILIO (bg-red-400)

### Campaign Performance Table:
- Header: `<BarChart2 className="w-3.5 h-3.5 text-primary">` + "CAMPAIGN PERFORMANCE"
- Columns: `CAMPAIGN | STATUS | TOTAL CALLS | INTERESTED | INTEREST RATE | PROGRESS`
- Interested: `text-green-400`
- Interest Rate: `text-foreground font-bold` (e.g. "47%")
- Progress: `w-24 h-1.5 bg-white/10 rounded overflow-hidden` + `bg-primary` fill

---

## 17. DISPOSITIONS PAGE (`/dispositions`)

### PageHeader: Title "DISPOSITIONS", Subtitle "Call outcome breakdown"

### Top 4 stat cards (first 4 dispositions):
- Each: disposition badge + count `text-2xl font-bold font-mono` + percentage `text-[10px] font-mono text-muted-foreground mt-1`

### Disposition Distribution Panel:
- Header: `<Tag className="w-3.5 h-3.5 text-primary">` + "DISPOSITION DISTRIBUTION" + total count right
- Each row: `flex items-center gap-3`
  - Badge: `w-28 flex-shrink-0`
  - Track: `flex-1 h-5 bg-white/5 rounded overflow-hidden` + colored fill `opacity-70`
  - Count: `w-8 text-right text-xs font-mono font-bold text-foreground`
  - Percentage: `w-10 text-right text-[10px] font-mono text-muted-foreground`
- All 7 dispositions:
  - interested=bg-green-400, not_interested=bg-red-400, connected=bg-blue-400, vm=bg-yellow-400, callback=bg-purple-400, no_answer=bg-muted-foreground, do_not_call=bg-orange-400

### Recent Dispositioned Calls Table:
- Header: "RECENT DISPOSITIONED CALLS"
- Columns: `CALL ID | LEAD | CAMPAIGN | PROVIDER | DISPOSITION | DURATION`
- Last 10 calls with disposition

---

## 18. SETTINGS PAGE (`/settings`)

### PageHeader: Title "SETTINGS", Subtitle "Platform configuration"

### Pattern — SettingSection:
- `border border-border rounded bg-[hsl(224,71%,3%)]`
- Header: `<Icon className="w-3.5 h-3.5 text-primary">` + label `text-[10px] font-mono uppercase tracking-widest text-muted-foreground`
- Body: `p-4 space-y-4`

### Pattern — SettingRow:
- `flex items-start justify-between gap-4`
- Left: label `text-xs font-mono text-foreground` + description `text-[10px] font-mono text-muted-foreground mt-0.5`
- Right: input or badge

### Settings StatusBadge (local):
- Active: `border-green-500/30 text-green-400 bg-green-500/5` + `<CheckCircle className="w-3 h-3">`
- Inactive: `border-border text-muted-foreground` + `<XCircle className="w-3 h-3">`
- `flex items-center gap-1.5 text-[10px] font-mono px-2 py-1 rounded border`

### Save buttons: `border-t border-border/50 pt-2` + `<Button size="sm">` "Save {N} Settings"

### 5 Sections:

**1. Platform** (`<Settings>`):
- Max Agents per Account: `<Input type="number" className="font-mono text-sm w-24 text-center">` (default 25)

**2. Authentication** (`<Shield>`):
- JWT Expiry: `<Input className="font-mono text-sm w-24 text-center">` (default "24h")
- Session Secret: read-only "Configured" active badge

**3. Telephony Providers** (`<Phone>`):
- VoIP Endpoint URL: full-width input + "Not Set" inactive badge in flex row
- Telnyx API Key: full-width password input + **"Configured"** green active badge (API key is set)
- Twilio Account SID + Auth Token: 2-col grid
- Footer: `"Provider priority: VoIP → Telnyx → Twilio (fallback chain)"` muted mono

**4. Queue (Redis / BullMQ)** (`<Zap>`):
- Queue Status row: "Disabled" inactive badge
- Redis Host + Port: 2-col inputs
- Footer: env var hint

**5. Integrations** (`<Radio>`):
- ElevenLabs — **active** (green "Enabled" badge — API key is configured)
- Telnyx WebRTC — **active** (green "Enabled" badge — API key is configured)
- PlayHT — **active** (green "Enabled" badge)
- Azure Cognitive Speech — **active** (green "Enabled" badge)
- WebSocket Monitoring — **active** (green "Enabled" badge)

---

## 19. API CONFIGURATION

### Base URL
```
https://shivanshbackend.replit.app
```

### Auth
- JWT Bearer: `Authorization: Bearer {token}` on all requests
- Token stored in `localStorage["auth_token"]`
- On 401: redirect to `/login?reason=session_expired`

### Complete Endpoints

```
POST   /api/auth/login              { email, password } → { token, user }
GET    /api/auth/me                 → { user }
POST   /api/auth/logout

GET    /api/campaigns               → Campaign[]
POST   /api/campaigns               Create
PATCH  /api/campaigns/:id           Update
DELETE /api/campaigns/:id
POST   /api/campaigns/:id/start
POST   /api/campaigns/:id/pause
POST   /api/campaigns/:id/resume
POST   /api/campaigns/:id/test-call { phone } → { success, jobId, fromNumber, voice, error? }
POST   /api/campaigns/:id/reset-leads

GET    /api/leads                   ?campaignId&status&limit&offset → Lead[]
POST   /api/leads                   Create single
POST   /api/leads/bulk              { leads[], campaignId }
GET    /api/leads/:id
PATCH  /api/leads/:id
DELETE /api/leads/:id
GET    /api/leads/export/csv        ?campaignId

GET    /api/calls                   → Call[]
GET    /api/calls/live              → LiveCall[]
GET    /api/calls/stats/today       → { total, completed }
GET    /api/calls/:id
PATCH  /api/calls/:id               { disposition }
GET    /api/calls/:id/export        ?format=txt|pdf → blob
POST   /api/calls/webrtc-token      → { token }

GET    /api/call-logs               ?campaignId&status → CallLog[]
GET    /api/call-logs/:id
GET    /api/call-logs/:id/export    ?format=txt|pdf → blob

GET    /api/voices                  → Voice[]
POST   /api/voices                  Create
GET    /api/voices/elevenlabs       → ElevenLabsVoice[]
GET    /api/voices/:id/preview      → audio blob
POST   /api/voices/:id/sample       { text } → audio blob

GET    /api/agents                  → Agent[]
POST   /api/agents                  Create
GET    /api/agents/available        → Agent[]

GET    /api/users                   → User[]
POST   /api/users                   Create
PATCH  /api/users/me/status         { status }

GET    /api/numbers                 → PhoneNumber[]
POST   /api/numbers                 { phoneNumber, provider, campaignId?, priority? }
DELETE /api/numbers/:id

GET    /api/healthz                 → { ok: true }
```

### WebSocket — Socket.IO
```
Path:  /api/ws
Auth:  { token } in socket.auth
Events (received from server):
  call:queued       { callId, leadId, campaignId, phoneNumber }
  call:started      { id, callId, leadId, campaignId, phoneNumber, providerUsed, selectedNumber, agentId }
  call:ended        { id, callId, disposition, duration }
  call:transferred  { callId, agentId }
  call:inbound      { callId, from, campaignId }
  call_update       { callId, id, status }
  campaign:started  { campaignId, name }
  campaign:stopped  { campaignId, name }
  agent_status      { agentId, status }
  agent:status_update { agentId, status }
```

---

## 20. DATA MODELS

```typescript
type CampaignStatus = "draft" | "active" | "paused" | "completed"
type CampaignType   = "outbound" | "inbound"

interface Campaign {
  id: number; name: string; type: CampaignType; status: CampaignStatus
  description?: string; agentId?: number; agentPrompt?: string
  voice?: string; fromNumber?: string; transferNumber?: string
  maxConcurrentCalls?: number
  routingType?: "round_robin" | "priority" | "sequential"
  timezone?: string; startTime?: string; endTime?: string; workingDays?: string[]
  backgroundSound?: "none"|"office"|"typing"|"cafe"
  holdMusic?: "none"|"jazz"|"corporate"|"smooth"|"classical"
  humanLike?: "true"|"false"
  totalLeads?: number; calledLeads?: number; createdAt: string
}

interface Lead {
  id: number; phone: string; name?: string; email?: string
  status: "pending"|"called"|"callback"|"completed"|"failed"
  campaignId: number; callbackTime?: string; updatedAt?: string
}

interface Call {
  id: number; campaignId?: number; leadId?: number; agentId?: number
  providerUsed?: string
  status: "initiated"|"in_progress"|"completed"|"failed"|"no_answer"
  disposition?: string; duration?: number; recordingUrl?: string
  transcript?: string; summary?: string
  direction?: "outbound"|"inbound"; createdAt: string
}

interface CallLog {
  id: number; campaignId?: number; phoneNumber?: string
  status: "initiated"|"completed"|"failed"
  duration?: number; disposition?: string; recordingUrl?: string
  direction?: "outbound"|"inbound"; timestamp?: string
}

interface Voice {
  id: number; name: string
  provider: "elevenlabs"|"playht"|"azure"
  voiceId: string; gender: "male"|"female"
  accent: "us"|"uk"|"indian"|"australian"|"canadian"|"other"
  language: string; previewUrl?: string; description?: string
}

interface Agent {
  id: number; name: string; prompt: string
  language: string; defaultVoiceId?: number; status?: string
}

interface User {
  id: number; name: string; email: string
  role: "admin"|"supervisor"|"agent"
  status: "available"|"busy"|"break"|"offline"|"inactive"
}

interface PhoneNumber {
  id: number; phoneNumber: string
  provider: "voip"|"telnyx"|"twilio"
  campaignId?: number; priority?: number; status: string; friendlyName?: string
}
```

---

## 21. ROUTING

```
/               → Dashboard (all roles)
/campaigns      → Campaigns (admin/supervisor)
/leads          → Lead Lists (admin/supervisor)
/voices         → Voices (admin/supervisor)
/dispositions   → Dispositions (admin/supervisor)
/users          → Team (admin)
/queues         → Queues (admin/supervisor)
/live-monitor   → Live Monitor (admin/supervisor)
/numbers        → DIDs (admin)
/inbound-routes → Inbound Routes (admin)
/calls          → CDR + Campaign Logs tabs (all roles)
/analytics      → Analytics (admin/supervisor)
/settings       → Settings (admin)
/dialer         → Dialer (agent)
/callbacks      → Callbacks (agent)
/login          → Login (unauthenticated only)
```

---

## 22. TECH STACK

- **Framework**: React 18 + TypeScript + Vite
- **Routing**: React Router v6 (or wouter)
- **Styling**: Tailwind CSS with the exact HSL tokens above
- **Data fetching**: TanStack Query v5 (react-query)
- **WebSocket**: socket.io-client
- **WebRTC**: `@telnyx/webrtc` SDK (TelnyxRTC class)
- **Icons**: lucide-react (exact icons as specified)
- **UI Base**: shadcn/ui — Button, Input, Label, Badge, Select, SelectTrigger, SelectContent, SelectItem, Textarea, Skeleton, Card, CardHeader, CardContent, CardTitle, CardDescription
- **Font**: JetBrains Mono / Fira Code — monospace everywhere
- **Auth**: JWT in localStorage, Bearer in all fetch headers

---

## 23. ABSOLUTE RULES

1. **Zero light backgrounds** — entire app is deep navy/black only
2. **100% monospace** — every character in every UI element uses `font-mono`
3. **All badges are outline variant** — colored border + text + very faint background fill
4. **All buttons uppercase** — `uppercase tracking-wider` always
5. **Page headers always border-bottom** — `border-b border-border`
6. **Panel/card headers always border-bottom** — same
7. **Section labels in SMALL-CAPS style** — `text-[10px] uppercase tracking-widest`
8. **Active sidebar has primary border** — `border border-primary/25` + `bg-primary/15`
9. **Hover states are extremely subtle** — max `hover:bg-white/5` or `hover:bg-white/[0.02]`
10. **Waveform on playing voice** — 16 bars, sine heights, scaleY keyframe animation
11. **Live call cards have gradient top accent line** — green gradient pulse
12. **CDR rows are expandable** — inline disposition updater + TXT/PDF export + recording link
13. **Campaign card footer has action buttons** — Test Call / Launch / Pause / Resume
14. **All modals use backdrop-blur** — `bg-black/60 backdrop-blur-sm`
15. **Primary color is electric cyan** — `hsl(183, 100%, 50%)` = `#00FFFF`
16. **App name is SHIVANSH** — not NexusCall, not anything else

---

*This document is the complete, authoritative spec for the Shivansh AI Calling SaaS frontend — covering all 17 pages, every modal, every component, every badge, every animation, every API call, and every visual detail.*
