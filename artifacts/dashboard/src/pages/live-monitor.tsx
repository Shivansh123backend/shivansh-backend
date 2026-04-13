import { useState, useEffect, useRef, useCallback } from "react";
import { io, type Socket } from "socket.io-client";
import { useListCampaigns, useGetAvailableAgents, customFetch } from "@workspace/api-client-react";
import { Layout, PageHeader } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Activity, Phone, Bot, Megaphone, Zap, Wifi, WifiOff,
  CheckCircle2, XCircle, PhoneIncoming, PhoneMissed, ArrowRightLeft,
  Clock, Users, TrendingUp, MessageSquare,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface LiveCall {
  id: number;
  callControlId?: string;
  leadId?: number;
  campaignId?: number;
  agentId?: number;
  providerUsed?: string;
  selectedVoice?: string;
  selectedNumber?: string;
  phoneNumber?: string;
  status: string;
  startedAt?: string;
  _localStart: number;
}

interface TranscriptLine {
  speaker: "caller" | "agent";
  text: string;
  ts: number;
}

interface EventEntry {
  id: string;
  type: "call:queued" | "call:started" | "call:ended" | "call:transferred" | "call:inbound" | "agent_status" | "call_update" | "campaign:started" | "campaign:stopped" | "connected";
  message: string;
  detail?: string;
  ts: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function useLiveClock(intervalMs = 1000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
}

function formatElapsed(startMs: number): string {
  const secs = Math.floor((Date.now() - startMs) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ── Typing sound using Web Audio API ─────────────────────────────────────────
let _audioCtx: AudioContext | null = null;
function playTypingSound() {
  try {
    if (!_audioCtx) _audioCtx = new AudioContext();
    const ctx = _audioCtx;
    const bufferSize = Math.floor(ctx.sampleRate * 0.035);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize) * 0.8;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = 0.04;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 3000;
    filter.Q.value = 0.7;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    src.start();
  } catch {
    // audio not available — ignore silently
  }
}

const EVENT_ICONS: Record<string, React.ElementType> = {
  "call:queued": Clock,
  "call:started": Phone,
  "call:ended": CheckCircle2,
  "call:transferred": ArrowRightLeft,
  "call:inbound": PhoneIncoming,
  "agent_status": Bot,
  "call_update": Activity,
  "campaign:started": Megaphone,
  "campaign:stopped": XCircle,
  connected: Wifi,
};

const EVENT_COLORS: Record<string, string> = {
  "call:queued": "text-yellow-400",
  "call:started": "text-green-400",
  "call:ended": "text-blue-400",
  "call:transferred": "text-purple-400",
  "call:inbound": "text-cyan-400",
  "agent_status": "text-muted-foreground",
  "call_update": "text-muted-foreground",
  "campaign:started": "text-primary",
  "campaign:stopped": "text-red-400",
  connected: "text-green-400",
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatCard({ label, value, color, loading, icon: Icon }: {
  label: string; value: number | string; color: string; loading?: boolean; icon: React.ElementType
}) {
  return (
    <div className="border border-border rounded p-4 bg-[hsl(224,71%,3%)] flex items-start justify-between gap-2">
      <div>
        <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2">{label}</p>
        {loading ? (
          <Skeleton className="h-7 w-12" />
        ) : (
          <p className={`text-2xl font-bold font-mono ${color}`}>{value}</p>
        )}
      </div>
      <div className={`w-8 h-8 rounded flex items-center justify-center bg-white/5 border border-border ${color}`}>
        <Icon className="w-4 h-4" />
      </div>
    </div>
  );
}

function LiveCallCard({
  call,
  campaignMap,
  transcriptLines,
}: {
  call: LiveCall;
  campaignMap: Record<number, string>;
  transcriptLines: TranscriptLine[];
}) {
  useLiveClock();
  const elapsed = formatElapsed(call._localStart);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [transcriptLines.length]);

  return (
    <div className="border border-green-500/20 rounded bg-[hsl(224,71%,3%)] p-4 space-y-3 relative overflow-hidden hover:border-green-500/40 transition-colors">
      <div className="absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r from-green-400/0 via-green-400/70 to-green-400/0 animate-pulse" />

      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse flex-shrink-0" />
          <div>
            <p className="text-xs font-mono font-semibold text-foreground">
              {call.phoneNumber ?? `Lead #${call.leadId ?? "-"}`}
            </p>
            <p className="text-[10px] font-mono text-muted-foreground">Call #{call.id}</p>
          </div>
        </div>
        <div className="text-right">
          <Badge variant="outline" className="text-[9px] font-mono border-green-500/30 text-green-400 bg-green-500/5 uppercase mb-1">
            Live
          </Badge>
          <p className="text-[11px] font-mono font-bold text-green-400 tabular-nums">{elapsed}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Megaphone className="w-3 h-3 flex-shrink-0 text-primary/60" />
          <span className="truncate">{call.campaignId ? (campaignMap[call.campaignId] ?? `#${call.campaignId}`) : "-"}</span>
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Bot className="w-3 h-3 flex-shrink-0 text-blue-400/60" />
          <span>{call.agentId ? `Agent #${call.agentId}` : "AI Agent"}</span>
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Phone className="w-3 h-3 flex-shrink-0 text-muted-foreground/60" />
          <span className="uppercase">{call.providerUsed ?? "telnyx"}</span>
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Zap className="w-3 h-3 flex-shrink-0 text-yellow-400/60" />
          <span className="truncate">{call.selectedNumber ?? "-"}</span>
        </div>
      </div>

      {/* Live transcript panel */}
      <div className="border border-border/50 rounded bg-black/30">
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border/30">
          <MessageSquare className="w-2.5 h-2.5 text-primary/60" />
          <span className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground">Live Transcript</span>
          {transcriptLines.length > 0 && (
            <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
          )}
        </div>
        <div
          ref={transcriptRef}
          className="overflow-y-auto px-2 py-1.5 space-y-1"
          style={{ maxHeight: 110 }}
        >
          {transcriptLines.length === 0 ? (
            <p className="text-[9px] font-mono text-muted-foreground/40 italic text-center py-2">
              Waiting for speech…
            </p>
          ) : (
            transcriptLines.slice(-6).map((line, i) => (
              <div key={i} className="flex gap-1.5 items-start">
                <span className={`text-[8px] font-mono font-bold flex-shrink-0 pt-0.5 ${
                  line.speaker === "agent" ? "text-primary" : "text-cyan-400"
                }`}>
                  {line.speaker === "agent" ? "AI" : "C"}
                </span>
                <p className="text-[9px] font-mono text-foreground/80 leading-relaxed break-words min-w-0">
                  {line.text}
                </p>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function EventLog({ events }: { events: EventEntry[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [events, autoScroll]);

  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
  };

  return (
    <div className="border border-border rounded bg-[hsl(224,71%,3%)] flex flex-col" style={{ height: 320 }}>
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <Activity className="w-3.5 h-3.5 text-primary" />
          <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Event Stream</p>
        </div>
        <div className="flex items-center gap-2">
          {events.length > 0 && (
            <span className="text-[9px] font-mono text-muted-foreground">{events.length} events</span>
          )}
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
        </div>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto divide-y divide-border/30 scroll-smooth"
      >
        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <Activity className="w-5 h-5 text-muted-foreground/30" />
            <p className="text-[10px] font-mono text-muted-foreground/50">Waiting for events…</p>
          </div>
        ) : (
          events.map((ev) => {
            const Icon = EVENT_ICONS[ev.type] ?? Activity;
            const color = EVENT_COLORS[ev.type] ?? "text-muted-foreground";
            return (
              <div key={ev.id} className="flex items-start gap-3 px-4 py-2 hover:bg-white/2 transition-colors">
                <span className="text-[9px] font-mono text-muted-foreground/50 w-16 flex-shrink-0 tabular-nums pt-0.5">
                  {formatTime(ev.ts)}
                </span>
                <Icon className={`w-3 h-3 flex-shrink-0 mt-0.5 ${color}`} />
                <div className="min-w-0">
                  <span className={`text-[11px] font-mono ${color}`}>{ev.message}</span>
                  {ev.detail && (
                    <span className="text-[10px] font-mono text-muted-foreground/60 ml-2">{ev.detail}</span>
                  )}
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>
      {!autoScroll && (
        <div className="px-4 py-1.5 border-t border-border flex-shrink-0">
          <button
            onClick={() => { setAutoScroll(true); bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }}
            className="text-[9px] font-mono text-primary hover:text-primary/80 transition-colors"
          >
            ↓ scroll to latest
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

let _eventCounter = 0;
function makeEvent(type: EventEntry["type"], message: string, detail?: string): EventEntry {
  return { id: `ev-${++_eventCounter}`, type, message, detail, ts: Date.now() };
}

export default function LiveMonitorPage() {
  const { data: campaigns, isLoading: campLoading } = useListCampaigns();
  const { data: availableAgents, isLoading: agentLoading } = useGetAvailableAgents();

  const [connected, setConnected] = useState(false);
  const [activeCalls, setActiveCalls] = useState<Map<number, LiveCall>>(new Map());
  const [liveTranscripts, setLiveTranscripts] = useState<Map<string, TranscriptLine[]>>(new Map());
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [totalToday, setTotalToday] = useState<number>(0);
  const [completedToday, setCompletedToday] = useState<number>(0);
  const socketRef = useRef<Socket | null>(null);

  const campaignMap = Object.fromEntries(
    (campaigns ?? []).map((c: { id: number; name: string }) => [c.id, c.name]),
  );
  const activeCampaigns = (campaigns ?? []).filter((c: { status: string }) => c.status === "active");

  const addEvent = useCallback((ev: EventEntry) => {
    setEvents(prev => [...prev.slice(-199), ev]); // keep last 200
  }, []);

  // Fetch initial live calls snapshot
  useEffect(() => {
    customFetch<{ id: number; status: string; campaignId?: number; leadId?: number; providerUsed?: string; selectedNumber?: string }[]>("/api/calls/live").then(data => {
      if (!Array.isArray(data)) return;
      const map = new Map<number, LiveCall>();
      data.forEach(c => {
        if (c.status === "initiated" || c.status === "in_progress") {
          map.set(c.id, { ...c, _localStart: Date.now() });
        }
      });
      setActiveCalls(map);
    }).catch(() => {});

    customFetch<{ total: number; completed: number }>("/api/calls/stats/today").then(data => {
      if (data && typeof data === "object") {
        setTotalToday((data as { total?: number }).total ?? 0);
        setCompletedToday((data as { completed?: number }).completed ?? 0);
      }
    }).catch(() => {});
  }, []);

  // Socket.IO connection
  useEffect(() => {
    const token = localStorage.getItem("auth_token");
    if (!token) return;

    const socket = io(window.location.origin, {
      path: "/api/ws",
      auth: { token },
      transports: ["websocket", "polling"],
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      addEvent(makeEvent("connected", "Connected to live monitor"));
    });

    socket.on("disconnect", () => {
      setConnected(false);
    });

    socket.on("call:queued", (data: { callId?: number; id?: number; leadId?: number; campaignId?: number; phoneNumber?: string }) => {
      const id = data.callId ?? data.id ?? 0;
      addEvent(makeEvent("call:queued", `Call #${id} queued`, data.phoneNumber ? `→ ${data.phoneNumber}` : data.campaignId ? `Campaign #${data.campaignId}` : undefined));
      setTotalToday(n => n + 1);
    });

    socket.on("call:started", (data: { id?: number; callId?: number; callControlId?: string; leadId?: number; campaignId?: number; phoneNumber?: string; providerUsed?: string; selectedNumber?: string; agentId?: number }) => {
      const id = data.id ?? data.callId ?? 0;
      const call: LiveCall = {
        id,
        callControlId: data.callControlId,
        leadId: data.leadId,
        campaignId: data.campaignId,
        agentId: data.agentId,
        providerUsed: data.providerUsed,
        selectedNumber: data.selectedNumber,
        phoneNumber: data.phoneNumber,
        status: "initiated",
        _localStart: Date.now(),
      };
      setActiveCalls(prev => new Map(prev).set(id, call));
      addEvent(makeEvent("call:started", `Call #${id} started`, data.phoneNumber ? `→ ${data.phoneNumber}` : undefined));
    });

    socket.on("call:ended", (data: { id?: number; callId?: number; callControlId?: string; disposition?: string; duration?: number }) => {
      const id = data.id ?? data.callId ?? 0;
      setActiveCalls(prev => { const m = new Map(prev); m.delete(id); return m; });
      // Clear transcripts for this call
      if (data.callControlId) {
        setLiveTranscripts(prev => { const m = new Map(prev); m.delete(data.callControlId!); return m; });
      }
      setCompletedToday(n => n + 1);
      addEvent(makeEvent("call:ended", `Call #${id} ended`, data.disposition ? `· ${data.disposition.replace(/_/g, " ")}` : data.duration ? `· ${data.duration}s` : undefined));
    });

    socket.on("call:transcription", (data: { callId?: number; callControlId?: string; speaker?: "caller" | "agent"; text?: string; ts?: number }) => {
      const ccid = data.callControlId;
      if (!ccid || !data.text || !data.speaker) return;
      const line: TranscriptLine = { speaker: data.speaker, text: data.text, ts: data.ts ?? Date.now() };
      setLiveTranscripts(prev => {
        const m = new Map(prev);
        const prev_lines = m.get(ccid) ?? [];
        m.set(ccid, [...prev_lines.slice(-29), line]); // keep last 30 lines
        return m;
      });
      playTypingSound();
    });

    socket.on("call:transferred", (data: { callId?: number; agentId?: number }) => {
      addEvent(makeEvent("call:transferred", `Call #${data.callId ?? "?"} transferred`, data.agentId ? `→ Agent #${data.agentId}` : undefined));
    });

    socket.on("call:inbound", (data: { callId?: number; from?: string; campaignId?: number }) => {
      addEvent(makeEvent("call:inbound", `Inbound call #${data.callId ?? "?"}`, data.from ? `from ${data.from}` : undefined));
    });

    socket.on("call_update", (data: { callId?: number; id?: number; status?: string }) => {
      const id = data.callId ?? data.id ?? 0;
      if (data.status === "completed" || data.status === "failed" || data.status === "no_answer") {
        setActiveCalls(prev => { const m = new Map(prev); m.delete(id); return m; });
      }
      addEvent(makeEvent("call_update", `Call #${id} → ${data.status ?? "updated"}`));
    });

    socket.on("campaign:started", (data: { campaignId?: number; name?: string }) => {
      addEvent(makeEvent("campaign:started", `Campaign started`, data.name ?? `#${data.campaignId}`));
    });

    socket.on("campaign:stopped", (data: { campaignId?: number; name?: string }) => {
      addEvent(makeEvent("campaign:stopped", `Campaign stopped`, data.name ?? `#${data.campaignId}`));
    });

    socket.on("agent_status", (data: { agentId?: number; status?: string }) => {
      addEvent(makeEvent("agent_status", `Agent #${data.agentId ?? "?"} → ${data.status ?? "updated"}`));
    });

    socket.on("agent:status_update", (data: { agentId?: number; status?: string }) => {
      addEvent(makeEvent("agent_status", `Agent #${data.agentId ?? "?"} → ${data.status ?? "updated"}`));
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [addEvent]);

  const activeCallsArr = Array.from(activeCalls.values());
  const successRate = totalToday > 0 ? Math.round((completedToday / totalToday) * 100) : 0;

  return (
    <Layout>
      <PageHeader
        title="Live Monitor"
        subtitle="Real-time call activity"
        action={
          <div className={`flex items-center gap-1.5 text-[10px] font-mono ${connected ? "text-green-400" : "text-red-400"}`}>
            {connected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
            {connected ? "Live · connected" : "Reconnecting…"}
          </div>
        }
      />

      <div className="p-6 space-y-5">
        {/* Stat cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            label="Active Calls"
            value={activeCallsArr.length}
            color="text-green-400"
            icon={Phone}
          />
          <StatCard
            label="Active Campaigns"
            value={activeCampaigns.length}
            color="text-primary"
            loading={campLoading}
            icon={Megaphone}
          />
          <StatCard
            label="Available Agents"
            value={Array.isArray(availableAgents) ? availableAgents.length : 0}
            color="text-blue-400"
            loading={agentLoading}
            icon={Users}
          />
          <StatCard
            label="Success Rate Today"
            value={`${successRate}%`}
            color="text-yellow-400"
            icon={TrendingUp}
          />
        </div>

        {/* Active calls grid */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Activity className="w-3.5 h-3.5 text-green-400" />
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              Active Calls
              {activeCallsArr.length > 0 && (
                <span className="ml-2 text-green-400">({activeCallsArr.length})</span>
              )}
            </p>
          </div>
          {activeCallsArr.length === 0 ? (
            <div className="border border-border/50 rounded p-10 bg-[hsl(224,71%,3%)] flex flex-col items-center justify-center gap-3">
              <div className="w-10 h-10 rounded-full bg-white/5 border border-border flex items-center justify-center">
                <PhoneMissed className="w-5 h-5 text-muted-foreground/40" />
              </div>
              <p className="text-xs font-mono text-muted-foreground">No active calls right now</p>
              <p className="text-[10px] font-mono text-muted-foreground/50">
                {connected ? "Listening for new calls…" : "Connecting to live feed…"}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {activeCallsArr.map(c => (
                <LiveCallCard
                  key={c.id}
                  call={c}
                  campaignMap={campaignMap}
                  transcriptLines={c.callControlId ? (liveTranscripts.get(c.callControlId) ?? []) : []}
                />
              ))}
            </div>
          )}
        </div>

        {/* Event log + campaign sidebar */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <EventLog events={events} />
          </div>

          {/* Active campaigns panel */}
          <div className="border border-border rounded bg-[hsl(224,71%,3%)]" style={{ maxHeight: 320, overflowY: "auto" }}>
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border sticky top-0 bg-[hsl(224,71%,3%)]">
              <Megaphone className="w-3.5 h-3.5 text-primary" />
              <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Running Campaigns</p>
            </div>
            <div className="divide-y divide-border/30">
              {campLoading ? (
                [...Array(3)].map((_, i) => (
                  <div key={i} className="px-4 py-3">
                    <Skeleton className="h-4 w-full" />
                  </div>
                ))
              ) : activeCampaigns.length === 0 ? (
                <p className="text-[10px] font-mono text-muted-foreground/50 px-4 py-6 text-center">
                  No campaigns running
                </p>
              ) : activeCampaigns.map((c: { id: number; name: string; status: string; totalLeads?: number; calledLeads?: number }) => (
                <div key={c.id} className="px-4 py-3 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] font-mono text-foreground font-medium truncate">{c.name}</p>
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse flex-shrink-0" />
                  </div>
                  {c.totalLeads != null && (
                    <div className="space-y-1">
                      <div className="h-1 bg-white/10 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary/60 rounded-full transition-all"
                          style={{ width: `${c.totalLeads > 0 ? Math.round(((c.calledLeads ?? 0) / c.totalLeads) * 100) : 0}%` }}
                        />
                      </div>
                      <p className="text-[9px] font-mono text-muted-foreground">
                        {c.calledLeads ?? 0} / {c.totalLeads} leads
                      </p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Calls stats row */}
        <div className="grid grid-cols-2 gap-3">
          <div className="border border-border rounded p-4 bg-[hsl(224,71%,3%)]">
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2">Total Calls Today</p>
            <p className="text-xl font-bold font-mono text-foreground">{totalToday}</p>
          </div>
          <div className="border border-border rounded p-4 bg-[hsl(224,71%,3%)]">
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2">Completed Today</p>
            <p className="text-xl font-bold font-mono text-blue-400">{completedToday}</p>
          </div>
        </div>
      </div>
    </Layout>
  );
}
