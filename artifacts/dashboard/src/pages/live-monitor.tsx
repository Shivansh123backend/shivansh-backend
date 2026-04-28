import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { io, type Socket } from "socket.io-client";
import { useListCampaigns, useGetAvailableAgents, customFetch } from "@workspace/api-client-react";
import { Layout, PageHeader } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Activity, Phone, Bot, Megaphone, Zap, Wifi, WifiOff,
  CheckCircle2, XCircle, PhoneIncoming, PhoneMissed, ArrowRightLeft,
  Clock, Users, TrendingUp, MessageSquare, Volume2, VolumeX, Headphones, PhoneOff,
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

// ── Audio system — Web Audio API ─────────────────────────────────────────────
// The AudioContext must be resumed after a user gesture (browser policy).
// We gate everything through getCtx() which resumes lazily.
let _audioCtx: AudioContext | null = null;
let _ambientStop: (() => void) | null = null;

async function getCtx(): Promise<AudioContext | null> {
  try {
    if (!_audioCtx) _audioCtx = new AudioContext();
    if (_audioCtx.state === "suspended") await _audioCtx.resume();
    return _audioCtx;
  } catch { return null; }
}

function playKeyClick(ctx: AudioContext, vol = 0.05) {
  const bufSize = Math.floor(ctx.sampleRate * 0.028);
  const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / bufSize);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = vol;
  const f = ctx.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = 2800 + Math.random() * 800;
  f.Q.value = 0.9;
  src.connect(f);
  f.connect(g);
  g.connect(ctx.destination);
  src.start();
}

function startAmbientSound(ctx: AudioContext): () => void {
  let stopped = false;

  // Brown noise — low rumble like HVAC / office ventilation
  const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
  const noiseData = noiseBuffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < noiseData.length; i++) {
    const w = Math.random() * 2 - 1;
    noiseData[i] = last = (last + 0.015 * w) / 1.015;
  }
  const noiseSource = ctx.createBufferSource();
  noiseSource.buffer = noiseBuffer;
  noiseSource.loop = true;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0.055;
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = "lowpass";
  noiseFilter.frequency.value = 250;
  noiseSource.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(ctx.destination);
  noiseSource.start();

  // Random keyboard bursts — people typing in the background
  function scheduleTypingBurst() {
    if (stopped) return;
    const delay = 1200 + Math.random() * 4000;
    setTimeout(() => {
      if (stopped) return;
      const count = 1 + Math.floor(Math.random() * 6);
      for (let i = 0; i < count; i++) {
        setTimeout(() => { if (!stopped) playKeyClick(ctx, 0.025 + Math.random() * 0.02); },
          i * (40 + Math.random() * 70));
      }
      scheduleTypingBurst();
    }, delay);
  }
  scheduleTypingBurst();

  return () => {
    stopped = true;
    try { noiseSource.stop(); } catch { /* already stopped */ }
  };
}

async function enableAmbient() {
  const ctx = await getCtx();
  if (!ctx || _ambientStop) return;
  _ambientStop = startAmbientSound(ctx);
}

function disableAmbient() {
  _ambientStop?.();
  _ambientStop = null;
}

async function playTypingSound() {
  const ctx = await getCtx();
  if (!ctx) return;
  playKeyClick(ctx, 0.06);
}

// ── Live listen — µ-law decode + Web Audio streaming ─────────────────────────
// Each call being listened to gets its own AudioContext with a running clock so
// we can schedule buffers without gaps.

interface CallAudioPlayer {
  ctx: AudioContext;
  nextTime: number;     // scheduled end of last queued buffer (ctx.currentTime scale)
  gainCaller: GainNode; // volume for caller side
  gainAgent: GainNode;  // volume for agent side
}

const _callPlayers = new Map<string, CallAudioPlayer>();

/** G.711 µ-law → normalised float32 samples (8 kHz mono) */
function decodeMulaw(b64: string): Float32Array {
  const raw = atob(b64);
  const samples = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const u = ~raw.charCodeAt(i) & 0xff;
    const sign  = u & 0x80;
    const exp   = (u >> 4) & 0x07;
    const mant  = u & 0x0f;
    let   val   = ((mant << 3) + 132) << exp;
    if (!sign) val = -val;
    samples[i] = Math.max(-1, Math.min(1, val / 32768));
  }
  return samples;
}

function getOrCreatePlayer(callControlId: string): CallAudioPlayer | null {
  if (_callPlayers.has(callControlId)) return _callPlayers.get(callControlId)!;
  try {
    const ctx = new AudioContext({ sampleRate: 8000 });
    const gainCaller = ctx.createGain(); gainCaller.gain.value = 1.0;
    const gainAgent  = ctx.createGain(); gainAgent.gain.value  = 0.9;
    gainCaller.connect(ctx.destination);
    gainAgent.connect(ctx.destination);
    const player: CallAudioPlayer = { ctx, nextTime: 0, gainCaller, gainAgent };
    _callPlayers.set(callControlId, player);
    return player;
  } catch { return null; }
}

function destroyPlayer(callControlId: string): void {
  const p = _callPlayers.get(callControlId);
  if (!p) return;
  try { p.ctx.close(); } catch { /* ignore */ }
  _callPlayers.delete(callControlId);
}

function enqueueAudioChunk(callControlId: string, b64: string, side: "caller" | "agent"): void {
  const player = getOrCreatePlayer(callControlId);
  if (!player) return;
  const { ctx } = player;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});

  const samples = decodeMulaw(b64);
  if (samples.length === 0) return;

  const buf = ctx.createBuffer(1, samples.length, 8000);
  buf.copyToChannel(samples, 0);

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(side === "caller" ? player.gainCaller : player.gainAgent);

  const now = ctx.currentTime;
  // Prime a small buffer gap at start to avoid stutter; drain slowly thereafter
  if (player.nextTime < now + 0.02) player.nextTime = now + 0.08;
  src.start(player.nextTime);
  player.nextTime += buf.duration;
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
    <div className="border border-border rounded p-4 bg-card flex items-start justify-between gap-2">
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
  isListening,
  onToggleListen,
  onBargeIn,
  onDrop,
}: {
  call: LiveCall;
  campaignMap: Record<number, string>;
  transcriptLines: TranscriptLine[];
  isListening: boolean;
  onToggleListen: () => void;
  onBargeIn: () => void;
  onDrop: () => void;
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
    <div className={`border rounded bg-card p-4 space-y-3 relative overflow-hidden transition-colors ${
      isListening
        ? "border-cyan-500/60 shadow-[0_0_12px_rgba(6,182,212,0.15)]"
        : "border-green-500/20 hover:border-green-500/40"
    }`}>
      <div className={`absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r from-transparent via-green-400/70 to-transparent animate-pulse ${isListening ? "via-cyan-400/80" : "via-green-400/70"}`} />

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
        <div className="flex items-center gap-2">
          {/* Live listen button */}
          {call.callControlId && (
            <button
              onClick={onToggleListen}
              title={isListening ? "Stop listening" : "Listen to this call live"}
              className={`flex items-center gap-1 text-[9px] font-mono px-2 py-1 rounded border transition-all ${
                isListening
                  ? "border-cyan-400/60 text-cyan-400 bg-cyan-400/10 hover:bg-cyan-400/20 shadow-[0_0_6px_rgba(6,182,212,0.3)]"
                  : "border-border/50 text-muted-foreground hover:text-cyan-400 hover:border-cyan-400/40"
              }`}
            >
              <Headphones className="w-2.5 h-2.5" />
              {isListening ? "Listening" : "Listen"}
            </button>
          )}
          {/* Barge-in (3-way) — bridge the supervisor's phone into the live call */}
          {call.callControlId && (
            <button
              onClick={onBargeIn}
              title="Barge in: dial your phone and bridge into this call"
              className="flex items-center gap-1 text-[9px] font-mono px-2 py-1 rounded border border-border/50 text-muted-foreground hover:text-orange-400 hover:border-orange-400/40 transition-all"
            >
              <Phone className="w-2.5 h-2.5" />
              Barge
            </button>
          )}
          {/* Drop — force-end this call */}
          {call.callControlId && (
            <button
              onClick={onDrop}
              title="Drop: force-end this call now"
              className="flex items-center gap-1 text-[9px] font-mono px-2 py-1 rounded border border-border/50 text-muted-foreground hover:text-red-400 hover:border-red-400/40 transition-all"
            >
              <PhoneOff className="w-2.5 h-2.5" />
              Drop
            </button>
          )}
          <div className="text-right">
            <Badge variant="outline" className="text-[9px] font-mono border-green-500/30 text-green-400 bg-green-500/5 uppercase mb-1">
              Live
            </Badge>
            <p className="text-[11px] font-mono font-bold text-green-400 tabular-nums">{elapsed}</p>
          </div>
        </div>
      </div>

      {/* Listening indicator bar */}
      {isListening && (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-cyan-500/8 border border-cyan-500/20">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
          <span className="text-[9px] font-mono text-cyan-400 uppercase tracking-wider">Live audio streaming</span>
          <div className="flex items-end gap-px ml-auto h-3">
            {[1,2,3,4,3,2].map((h, i) => (
              <div key={i} className="w-0.5 bg-cyan-400/60 rounded-sm animate-pulse" style={{ height: `${h * 2}px`, animationDelay: `${i * 100}ms` }} />
            ))}
          </div>
        </div>
      )}

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
          style={{ maxHeight: 130 }}
        >
          {transcriptLines.length === 0 ? (
            <p className="text-[9px] font-mono text-muted-foreground/40 italic text-center py-2">
              Waiting for speech…
            </p>
          ) : (
            transcriptLines.slice(-8).map((line, i) => (
              <div key={i} className="flex gap-1.5 items-start">
                <span className={`text-[8px] font-mono font-bold flex-shrink-0 pt-0.5 w-5 ${
                  line.speaker === "agent" ? "text-primary" : "text-cyan-400"
                }`}>
                  {line.speaker === "agent" ? "AI" : "You"}
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
    <div className="border border-border rounded bg-card flex flex-col" style={{ height: 320 }}>
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

interface AgentStat {
  id: number;
  name: string;
  phone_number: string;
  status: string;
  current_call: string | null;
  stats: { callsToday: number; avgDuration: number; dispositions: Record<string, number> };
}

export default function LiveMonitorPage() {
  const { data: campaigns, isLoading: campLoading } = useListCampaigns();
  const { data: availableAgents, isLoading: agentLoading } = useGetAvailableAgents();
  const qc = useQueryClient();

  const AGENT_STATS_KEY = ["agent-stats"] as const;
  const { data: agentStats, isLoading: agentStatsLoading } = useQuery<AgentStat[]>({
    queryKey: AGENT_STATS_KEY,
    queryFn: () => customFetch<AgentStat[]>("/api/agents/stats"),
    staleTime: 30_000,
  });

  const [connected, setConnected] = useState(false);
  const [activeCalls, setActiveCalls] = useState<Map<number, LiveCall>>(new Map());
  const [liveTranscripts, setLiveTranscripts] = useState<Map<string, TranscriptLine[]>>(new Map());
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [totalToday, setTotalToday] = useState<number>(0);
  const [completedToday, setCompletedToday] = useState<number>(0);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [listeningCallControlId, setListeningCallControlId] = useState<string | null>(null);
  const soundEnabledRef = useRef(false); // live ref for socket handlers (avoids stale closure)
  const listeningRef = useRef<string | null>(null); // live ref for audio handler
  const socketRef = useRef<Socket | null>(null);

  // Keep refs in sync with state
  useEffect(() => { soundEnabledRef.current = soundEnabled; }, [soundEnabled]);
  useEffect(() => { listeningRef.current = listeningCallControlId; }, [listeningCallControlId]);

  // Start/stop ambient sound when toggled
  useEffect(() => {
    if (soundEnabled) { enableAmbient(); }
    else { disableAmbient(); }
    return () => { disableAmbient(); };
  }, [soundEnabled]);

  const campaignMap = Object.fromEntries(
    (campaigns ?? []).map((c: { id: number; name: string }) => [c.id, c.name]),
  );
  const activeCampaigns = (campaigns ?? []).filter((c: { status: string }) => c.status === "active");

  const addEvent = useCallback((ev: EventEntry) => {
    setEvents(prev => [...prev.slice(-199), ev]); // keep last 200
  }, []);

  // Clear the event stream when no calls are active. This keeps the panel
  // clean — historical noise from yesterday's runs or completed calls doesn't
  // linger once the system goes idle. Events repopulate as soon as a new call
  // starts. We delay 5s so the "Call ended" event stays visible briefly.
  useEffect(() => {
    if (activeCalls.size === 0 && events.length > 0) {
      const t = setTimeout(() => setEvents([]), 5_000);
      return () => clearTimeout(t);
    }
  }, [activeCalls.size, events.length]);

  // Fetch + periodically re-sync live calls snapshot from the server.
  // The server is the source of truth (filters out stale rows >2min old). If a
  // socket event was missed (network blip, abnormal call end, id mismatch),
  // this 10s poll wipes any orphaned ghost rows from the local map.
  useEffect(() => {
    const refresh = () => {
      customFetch<{ id: number; status: string; campaignId?: number; leadId?: number; providerUsed?: string; selectedNumber?: string }[]>("/api/calls/live").then(data => {
        if (!Array.isArray(data)) return;
        const serverIds = new Set<number>();
        const incoming: Array<{ id: number; status: string; campaignId?: number; leadId?: number; providerUsed?: string; selectedNumber?: string }> = [];
        data.forEach(c => {
          if (c.status === "initiated" || c.status === "in_progress") {
            serverIds.add(c.id);
            incoming.push(c);
          }
        });
        setActiveCalls(prev => {
          const next = new Map<number, LiveCall>();
          // Keep server-confirmed rows, preserving any local _localStart timestamps
          incoming.forEach(c => {
            const existing = prev.get(c.id);
            next.set(c.id, existing ? { ...existing, ...c } : { ...c, _localStart: Date.now() });
          });
          return next;
        });
      }).catch(() => {});
    };

    refresh();
    const intv = setInterval(refresh, 10_000);

    customFetch<{ total: number; completed: number }>("/api/calls/stats/today").then(data => {
      if (data && typeof data === "object") {
        setTotalToday((data as { total?: number }).total ?? 0);
        setCompletedToday((data as { completed?: number }).completed ?? 0);
      }
    }).catch(() => {});

    return () => clearInterval(intv);
  }, []);

  // Socket.IO connection
  useEffect(() => {
    const token = localStorage.getItem("auth_token");
    if (!token) return;

    const apiOrigin = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") || window.location.origin;
    const socket = io(apiOrigin, {
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
      setActiveCalls(prev => {
        const m = new Map(prev);
        // Prefer numeric id when present, otherwise fall back to scanning by
        // callControlId so events that only carry the control id (e.g. stale
        // bridge cleanups) still prune the row instantly.
        if (id) {
          m.delete(id);
        } else if (data.callControlId) {
          for (const [k, v] of m) {
            if (v.callControlId === data.callControlId) m.delete(k);
          }
        }
        return m;
      });
      // Clear transcripts + stop listening + destroy audio player for this call
      if (data.callControlId) {
        setLiveTranscripts(prev => { const m = new Map(prev); m.delete(data.callControlId!); return m; });
        if (listeningRef.current === data.callControlId) {
          setListeningCallControlId(null);
        }
        destroyPlayer(data.callControlId);
      }
      setCompletedToday(n => n + 1);
      addEvent(makeEvent("call:ended", `Call #${id || "?"} ended`, data.disposition ? `· ${data.disposition.replace(/_/g, " ")}` : data.duration ? `· ${data.duration}s` : undefined));
    });

    // ── Live audio streaming ──────────────────────────────────────────────
    socket.on("call:audio", (data: { callControlId: string; payload: string; side: "caller" | "agent" }) => {
      if (listeningRef.current !== data.callControlId) return; // not listening to this call
      enqueueAudioChunk(data.callControlId, data.payload, data.side);
    });

    socket.on("call:transcription", (data: { callId?: number; callControlId?: string; speaker?: "caller" | "agent"; text?: string; ts?: number }) => {
      const ccid = data.callControlId;
      if (!ccid || !data.text || !data.speaker) return;
      const line: TranscriptLine = { speaker: data.speaker, text: data.text, ts: data.ts ?? Date.now() };
      setLiveTranscripts(prev => {
        const m = new Map(prev);
        const prev_lines = m.get(ccid) ?? [];
        m.set(ccid, [...prev_lines.slice(-29), line]);
        return m;
      });
      if (soundEnabledRef.current) playTypingSound();
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

    socket.on("agent:stats:refresh", () => {
      qc.invalidateQueries({ queryKey: ["agent-stats"] });
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [addEvent, qc]);

  const activeCallsArr = Array.from(activeCalls.values());
  const successRate = totalToday > 0 ? Math.round((completedToday / totalToday) * 100) : 0;

  const bargeIn = useCallback(async (callControlId: string) => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem("supervisor_phone") : "";
    const to = window.prompt(
      "Enter your phone number in E.164 format (e.g. +14155551234). We will dial you and bridge you into the call.",
      saved ?? ""
    );
    if (!to) return;
    const trimmed = to.trim();
    if (!/^\+\d{8,15}$/.test(trimmed)) {
      alert("Phone must be E.164 format starting with + and 8–15 digits.");
      return;
    }
    try {
      window.localStorage.setItem("supervisor_phone", trimmed);
      const res = await fetch(`/api/calls/${encodeURIComponent(callControlId)}/conference`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: trimmed }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Barge failed: ${err.error || res.statusText}`);
        return;
      }
      alert(`Dialing ${trimmed} — answer your phone to join the call.`);
    } catch (e) {
      alert(`Barge failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const dropCall = useCallback(async (callControlId: string) => {
    if (!window.confirm("Drop this call now? The remote party will be hung up immediately.")) return;
    try {
      // Use customFetch so the Authorization Bearer header is added (raw fetch
      // with `credentials: include` would fail because the API uses Bearer auth,
      // not cookies).
      await customFetch(`/api/calls/${encodeURIComponent(callControlId)}/hangup`, {
        method: "POST",
      });
      // Optimistically prune from local map; the WS call:ended + 10s poll will reconcile
      setActiveCalls(prev => {
        const next = new Map(prev);
        for (const [id, c] of next) {
          if (c.callControlId === callControlId) next.delete(id);
        }
        return next;
      });
    } catch (e) {
      alert(`Drop failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const toggleListen = useCallback((callControlId: string) => {
    const socket = socketRef.current;
    if (!socket) return;

    if (listeningCallControlId === callControlId) {
      // Stop listening to this call
      socket.emit("listen:leave", callControlId);
      destroyPlayer(callControlId);
      setListeningCallControlId(null);
    } else {
      // Stop previous listen if any
      if (listeningCallControlId) {
        socket.emit("listen:leave", listeningCallControlId);
        destroyPlayer(listeningCallControlId);
      }
      // Start listening — AudioContext must be created from a user gesture
      socket.emit("listen:join", callControlId);
      setListeningCallControlId(callControlId);
    }
  }, [listeningCallControlId]);

  return (
    <Layout>
      <PageHeader
        title="Live Monitor"
        subtitle="Real-time call activity"
        action={
          <div className="flex items-center gap-3">
            {/* Sound toggle — requires click to unlock browser AudioContext */}
            <button
              onClick={() => setSoundEnabled(v => !v)}
              title={soundEnabled ? "Disable ambient sound" : "Enable office ambient sound + transcript clicks"}
              className={`flex items-center gap-1.5 text-[10px] font-mono px-2.5 py-1 rounded border transition-colors ${
                soundEnabled
                  ? "border-primary/50 text-primary bg-primary/10 hover:bg-primary/20"
                  : "border-border text-muted-foreground hover:text-foreground hover:border-border/80"
              }`}
            >
              {soundEnabled ? <Volume2 className="w-3 h-3" /> : <VolumeX className="w-3 h-3" />}
              {soundEnabled ? "Sound on" : "Sound off"}
            </button>
            <div className={`flex items-center gap-1.5 text-[10px] font-mono ${connected ? "text-green-400" : "text-red-400"}`}>
              {connected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              {connected ? "Live · connected" : "Reconnecting…"}
            </div>
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
            <div className="border border-border/50 rounded p-10 bg-card flex flex-col items-center justify-center gap-3">
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
                  isListening={!!c.callControlId && listeningCallControlId === c.callControlId}
                  onToggleListen={() => c.callControlId && toggleListen(c.callControlId)}
                  onBargeIn={() => c.callControlId && bargeIn(c.callControlId)}
                  onDrop={() => c.callControlId && dropCall(c.callControlId)}
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
          <div className="border border-border rounded bg-card" style={{ maxHeight: 320, overflowY: "auto" }}>
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border sticky top-0 bg-card">
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
          <div className="border border-border rounded p-4 bg-card">
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2">Total Calls Today</p>
            <p className="text-xl font-bold font-mono text-foreground">{totalToday}</p>
          </div>
          <div className="border border-border rounded p-4 bg-card">
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2">Completed Today</p>
            <p className="text-xl font-bold font-mono text-blue-400">{completedToday}</p>
          </div>
        </div>

        {/* Human Agent Performance */}
        <div className="border border-border rounded bg-card">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
            <Users className="w-3.5 h-3.5 text-blue-400" />
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Human Agent Performance · Today</p>
          </div>
          {agentStatsLoading ? (
            <div className="divide-y divide-border/30">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="px-4 py-3 flex items-center gap-4">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-4 w-32" />
                </div>
              ))}
            </div>
          ) : !agentStats || agentStats.length === 0 ? (
            <p className="text-[10px] font-mono text-muted-foreground/50 px-4 py-6 text-center">
              No human agents configured · add agents in the Agents page
            </p>
          ) : (
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="text-left px-4 py-2 text-[10px] text-muted-foreground uppercase tracking-wider">Agent</th>
                  <th className="text-left px-4 py-2 text-[10px] text-muted-foreground uppercase tracking-wider">Status</th>
                  <th className="text-right px-4 py-2 text-[10px] text-muted-foreground uppercase tracking-wider">Calls</th>
                  <th className="text-right px-4 py-2 text-[10px] text-muted-foreground uppercase tracking-wider">Avg Dur</th>
                  <th className="text-left px-4 py-2 text-[10px] text-muted-foreground uppercase tracking-wider">Top Disposition</th>
                  <th className="text-left px-4 py-2 text-[10px] text-muted-foreground uppercase tracking-wider">Current Call</th>
                </tr>
              </thead>
              <tbody>
                {agentStats.map(a => {
                  const topDisp = Object.entries(a.stats.dispositions).sort((x, y) => y[1] - x[1])[0];
                  const mins = Math.floor(a.stats.avgDuration / 60);
                  const secs = a.stats.avgDuration % 60;
                  return (
                    <tr key={a.id} className="border-b border-border/20 hover:bg-white/[0.02]">
                      <td className="px-4 py-2.5">
                        <p className="text-foreground font-medium">{a.name}</p>
                        <p className="text-[10px] text-muted-foreground">{a.phone_number}</p>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-flex items-center gap-1 text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border ${
                          a.status === "available"
                            ? "border-green-500/30 text-green-400 bg-green-500/5"
                            : "border-yellow-500/30 text-yellow-400 bg-yellow-500/5"
                        }`}>
                          <span className={`w-1 h-1 rounded-full ${a.status === "available" ? "bg-green-400" : "bg-yellow-400"} animate-pulse`} />
                          {a.status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-foreground tabular-nums">{a.stats.callsToday}</td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground tabular-nums">
                        {a.stats.avgDuration > 0 ? `${mins}:${String(secs).padStart(2, "0")}` : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground capitalize">
                        {topDisp ? `${topDisp[0].replace(/_/g, " ")} (${topDisp[1]})` : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground/70 text-[10px]">
                        {a.current_call ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Layout>
  );
}
