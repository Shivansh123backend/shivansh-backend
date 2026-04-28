import { useState, useEffect, useRef, useCallback } from "react";
import { Layout, PageHeader } from "@/components/layout";
import { customFetch } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Phone, PhoneOff, Mic, MicOff, Pause, Play, PhoneIncoming,
  PhoneCall, Headphones, Clock, ArrowRightLeft, UserPlus,
  RefreshCw, Loader2, Volume2, VolumeX, Delete,
} from "lucide-react";
import Vapi from "@vapi-ai/web";

// ── Types ─────────────────────────────────────────────────────────────────────
type SdkStatus = "offline" | "connecting" | "online" | "error";
type CallState = "idle" | "calling" | "active" | "ended";

type PhoneNumber = { id: number; number: string; friendlyName?: string | null; vapiPhoneNumberId?: string | null };
type Campaign    = { id: number; name: string };

type LiveCall = {
  id: number | string;
  callControlId?: string;
  phoneNumber?: string | null;
  status?: string;
  startedAt?: string;
  campaignId?: number | null;
  campaignName?: string | null;
  agentName?: string | null;
  direction?: "inbound" | "outbound";
  providerUsed?: string;
};

type CdrCall = {
  id: number | string;
  phoneNumber?: string | null;
  direction?: string;
  status?: string;
  duration?: number | null;
  timestamp?: string | null;
};

type TodayStats = {
  total: number;
  completed: number;
  failed: number;
  successRate: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function elapsedSince(iso?: string): string {
  if (!iso) return "0:00";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || isNaN(ms)) return "0:00";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function fmtTime(iso?: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch { return "—"; }
}

function fmtDur(s?: number | null) {
  if (!s || s < 1) return "—";
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const NUMPAD = [["1","2","3"],["4","5","6"],["7","8","9"],["*","0","#"]];

// ── Call timer ─────────────────────────────────────────────────────────────────
function useCallTimer(running: boolean) {
  const [sec, setSec] = useState(0);
  const ref = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (running) { setSec(0); ref.current = setInterval(() => setSec(s => s + 1), 1000); }
    else if (ref.current) clearInterval(ref.current);
    return () => { if (ref.current) clearInterval(ref.current); };
  }, [running]);
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function SoftphonePage() {
  // State
  const [sdkStatus, setSdkStatus]       = useState<SdkStatus>("offline");
  const [callState, setCallState]       = useState<CallState>("idle");
  const [phone, setPhone]               = useState("");
  const [callerId, setCallerId]         = useState("");   // selected phone number
  const [campaignId, setCampaignId]     = useState<number | "">("");
  const [muted, setMuted]               = useState(false);
  const [speaking, setSpeaking]         = useState(false);
  const [heldCalls, setHeldCalls]       = useState<Set<string>>(new Set());
  const [activeBrowserCall, setActiveBrowserCall] = useState<LiveCall | null>(null);

  const vapiRef  = useRef<Vapi | null>(null);
  const { toast } = useToast();
  const callTimer = useCallTimer(callState === "active");

  // Tick for live elapsed timers
  const [, setNow] = useState(Date.now);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  // ── Data queries ─────────────────────────────────────────────────────────────
  const { data: numbers = [] } = useQuery<PhoneNumber[]>({
    queryKey: ["numbers"],
    queryFn: () => customFetch("/api/numbers") as Promise<PhoneNumber[]>,
    staleTime: 60_000,
  });

  const { data: campaigns = [] } = useQuery<Campaign[]>({
    queryKey: ["campaigns-list"],
    queryFn: () => customFetch("/api/campaigns?limit=100") as Promise<Campaign[]>,
    staleTime: 60_000,
  });

  const { data: liveCalls = [], refetch: refetchLive } = useQuery<LiveCall[]>({
    queryKey: ["calls-live"],
    queryFn: () => customFetch("/api/calls/live") as Promise<LiveCall[]>,
    refetchInterval: 2_000,
  });

  const { data: recentCalls = [], refetch: refetchCdr } = useQuery<CdrCall[]>({
    queryKey: ["cdr-recent"],
    queryFn: () => customFetch("/api/calls/cdr?limit=12") as Promise<CdrCall[]>,
    refetchInterval: 10_000,
  });

  const { data: stats } = useQuery<TodayStats>({
    queryKey: ["stats-today"],
    queryFn: () => customFetch("/api/calls/stats/today") as Promise<TodayStats>,
    refetchInterval: 15_000,
  });

  // Auto-select first number
  useEffect(() => {
    if (numbers.length > 0 && !callerId) setCallerId(numbers[0].number);
  }, [numbers, callerId]);

  // ── Init Vapi Web SDK ─────────────────────────────────────────────────────
  const initSdk = useCallback(() => {
    setSdkStatus("connecting");
    customFetch("/api/vapi/web-key")
      .then((data) => {
        const { publicKey } = data as { publicKey: string };
        if (!publicKey) throw new Error("No public key");

        if (vapiRef.current) { try { vapiRef.current.stop(); } catch { /* ignore */ } }

        const instance = new Vapi(publicKey);
        instance.on("call-start", ()  => { setCallState("active"); });
        instance.on("call-end",   ()  => { setCallState("idle"); setMuted(false); setSpeaking(false); });
        instance.on("speech-start",() => setSpeaking(true));
        instance.on("speech-end",  () => setSpeaking(false));
        instance.on("error", (e: unknown) => {
          console.error("[Vapi SDK]", e);
          setSdkStatus("error");
        });
        vapiRef.current = instance;
        setSdkStatus("online");
      })
      .catch((err) => {
        console.error("[Vapi SDK init]", err);
        setSdkStatus("error");
      });
  }, []);

  useEffect(() => {
    initSdk();
    return () => { try { vapiRef.current?.stop(); } catch { /* ignore */ } };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Outbound: server-triggered Vapi call ──────────────────────────────────
  const makeCall = useCallback(async () => {
    if (!phone.trim()) { toast({ title: "Enter a number first", variant: "destructive" }); return; }
    setCallState("calling");
    try {
      await customFetch("/api/calls/manual", {
        method: "POST",
        body: JSON.stringify({
          phone: phone.trim(),
          campaignId: campaignId || undefined,
          provider: "vapi",
          fromNumber: callerId || undefined,
        }),
        headers: { "Content-Type": "application/json" },
      });
      toast({ title: "Call initiated via Vapi", description: `Calling ${phone.trim()}` });
      setPhone("");
      setCallState("active");
      refetchLive();
    } catch (err) {
      setCallState("idle");
      toast({ title: "Call failed", description: err instanceof Error ? err.message : "Check Vapi config", variant: "destructive" });
    }
  }, [phone, campaignId, callerId, toast, refetchLive]);

  // ── Browser session (Vapi Web SDK) ───────────────────────────────────────
  const startBrowserSession = useCallback(async () => {
    if (!vapiRef.current || sdkStatus !== "online") return;
    try { await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { toast({ title: "Mic blocked", description: "Allow microphone access", variant: "destructive" }); return; }
    setCallState("calling");
    try {
      await vapiRef.current.start({
        name: "Shivansh AI",
        firstMessage: "Hello! How can I help you today?",
        model: {
          provider: "openai" as const,
          model: "gpt-4o-mini",
          messages: [{ role: "system" as const, content: "You are Shivansh AI, a helpful assistant. Be concise and professional." }],
        },
        voice: { provider: "11labs" as const, voiceId: "21m00Tcm4TlvDq8ikWAM" },
      });
    } catch (err) {
      setCallState("idle");
      toast({ title: "Session failed", description: err instanceof Error ? err.message : "Could not connect", variant: "destructive" });
    }
  }, [sdkStatus, toast]);

  const endBrowserSession = useCallback(() => {
    vapiRef.current?.stop();
    setCallState("idle");
    setMuted(false);
    setSpeaking(false);
  }, []);

  const toggleMute = useCallback(() => {
    if (!vapiRef.current || callState !== "active") return;
    const next = !muted;
    vapiRef.current.setMuted(next);
    setMuted(next);
  }, [muted, callState]);

  // ── Live call controls ────────────────────────────────────────────────────
  const callAction = useCallback(async (cid: string, action: "hangup" | "hold" | "unhold") => {
    try {
      await customFetch(`/api/calls/${encodeURIComponent(cid)}/${action}`, { method: "POST" });
      if (action === "hold")   setHeldCalls(s => new Set(s).add(cid));
      if (action === "unhold") setHeldCalls(s => { const n = new Set(s); n.delete(cid); return n; });
      if (action === "hangup") { toast({ title: "Call ended" }); refetchLive(); }
      else toast({ title: action === "hold" ? "On hold" : "Resumed" });
    } catch (err) {
      toast({ title: `${action} failed`, description: err instanceof Error ? err.message : "Error", variant: "destructive" });
    }
  }, [toast, refetchLive]);

  const promptAndAct = useCallback(async (cid: string, kind: "transfer" | "conference") => {
    const target = window.prompt(`Destination number (E.164, e.g. +12035551234) for ${kind}:`);
    if (!target) return;
    if (!/^\+[1-9]\d{6,14}$/.test(target.trim())) {
      toast({ title: "Invalid number — must be E.164 like +12035551234", variant: "destructive" }); return;
    }
    try {
      await customFetch(`/api/calls/${encodeURIComponent(cid)}/${kind}`, {
        method: "POST",
        body: JSON.stringify({ to: target.trim() }),
        headers: { "Content-Type": "application/json" },
      });
      toast({ title: kind === "transfer" ? "Transferring…" : "Bridging in…" });
      refetchLive(); refetchCdr();
    } catch (err) {
      toast({ title: `${kind} failed`, description: err instanceof Error ? err.message : "Error", variant: "destructive" });
    }
  }, [toast, refetchLive, refetchCdr]);

  const dial = (d: string) => setPhone(p => (p + d).slice(0, 16));

  const activeLiveCalls = liveCalls.filter(c => c.callControlId);
  const selectedNumber = numbers.find(n => n.number === callerId);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <Layout>
      <PageHeader
        title="Softphone"
        subtitle="Browser-based agent line — handle inbound & outbound calls."
      />

      {/* ── Active AI Calls (full-width top panel) ───────────────────────── */}
      <div className="px-6 pt-4 pb-2">
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <PhoneCall className={cn("w-3.5 h-3.5", activeLiveCalls.length > 0 ? "text-green-400" : "text-muted-foreground")} />
            <h2 className="text-xs font-mono uppercase tracking-widest text-foreground">Active Calls</h2>
            <span className="ml-auto text-[10px] font-mono text-muted-foreground">{activeLiveCalls.length} live</span>
          </div>

          {activeLiveCalls.length === 0 ? (
            <div className="py-8 text-center">
              <PhoneIncoming className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">Waiting for calls…</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Inbound + outbound AI calls appear here in real time.</p>
            </div>
          ) : (
            <div className="flex gap-3 flex-wrap">
              {activeLiveCalls.map(c => {
                const cid = c.callControlId!;
                const held = heldCalls.has(cid);
                const isIn = c.direction === "inbound";
                return (
                  <div key={cid} className={cn(
                    "flex-1 min-w-[240px] rounded-lg border p-3",
                    held ? "border-yellow-500/40 bg-yellow-500/5" : isIn ? "border-blue-500/30 bg-blue-500/5" : "border-green-500/30 bg-green-500/5"
                  )}>
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-1.5">
                        <span className={cn("text-[9px] font-mono px-1.5 py-0.5 rounded uppercase",
                          isIn ? "bg-blue-500/20 text-blue-300" : "bg-green-500/20 text-green-300")}>{isIn ? "IN" : "OUT"}</span>
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                        <span className="font-mono text-sm">{c.phoneNumber || "Unknown"}</span>
                      </div>
                      <span className="font-mono text-lg text-green-400 tabular-nums">{elapsedSince(c.startedAt)}</span>
                    </div>
                    {c.campaignName && <p className="text-[10px] font-mono text-muted-foreground mb-2">{c.campaignName}</p>}
                    <div className="flex gap-1.5">
                      <button onClick={() => callAction(cid, held ? "unhold" : "hold")}
                        className={cn("flex-1 h-8 rounded border text-[10px] font-mono flex items-center justify-center gap-1 transition-all",
                          held ? "border-green-500/40 bg-green-500/10 text-green-400" : "border-border bg-white/5 text-muted-foreground hover:text-foreground")}>
                        {held ? <><Play className="w-3 h-3"/>Resume</> : <><Pause className="w-3 h-3"/>Hold</>}
                      </button>
                      <button onClick={() => promptAndAct(cid, "transfer")}
                        className="h-8 px-2 rounded border border-border bg-white/5 text-muted-foreground hover:text-foreground text-[10px] font-mono flex items-center gap-1 transition-all">
                        <ArrowRightLeft className="w-3 h-3"/>Xfer
                      </button>
                      <button onClick={() => promptAndAct(cid, "conference")}
                        className="h-8 px-2 rounded border border-border bg-white/5 text-muted-foreground hover:text-foreground text-[10px] font-mono flex items-center gap-1 transition-all">
                        <UserPlus className="w-3 h-3"/>Conf
                      </button>
                      <button onClick={() => callAction(cid, "hangup")}
                        className="h-8 px-3 rounded bg-red-600 hover:bg-red-700 text-white text-[10px] font-mono flex items-center gap-1 transition-all">
                        <PhoneOff className="w-3 h-3"/>End
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Three-column bottom section ──────────────────────────────────── */}
      <div className="px-6 pb-6 grid grid-cols-1 md:grid-cols-[280px_1fr_220px] gap-4 items-start">

        {/* ── LEFT: Dialer ─────────────────────────────────────────────── */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          {/* Status bar */}
          <button
            onClick={() => { if (sdkStatus === "offline" || sdkStatus === "error") initSdk(); }}
            className={cn(
              "w-full flex items-center justify-center gap-2 py-2 text-xs font-mono uppercase tracking-widest transition-colors",
              sdkStatus === "online"     ? "bg-green-500/10 text-green-400 border-b border-green-500/20 cursor-default" :
              sdkStatus === "connecting" ? "bg-yellow-500/10 text-yellow-400 border-b border-yellow-500/20 cursor-default" :
              sdkStatus === "error"      ? "bg-red-500/10 text-red-400 border-b border-red-500/20 hover:bg-red-500/20 cursor-pointer" :
                                          "bg-white/5 text-muted-foreground border-b border-border hover:bg-white/10 cursor-pointer"
            )}
            disabled={sdkStatus === "online" || sdkStatus === "connecting"}
          >
            <span className={cn("w-1.5 h-1.5 rounded-full",
              sdkStatus === "online" ? "bg-green-400" :
              sdkStatus === "connecting" ? "bg-yellow-400 animate-pulse" :
              sdkStatus === "error" ? "bg-red-400" : "bg-white/40"
            )} />
            {sdkStatus === "online"     ? "Online" :
             sdkStatus === "connecting" ? "Connecting…" :
             sdkStatus === "error"      ? "Error — click to retry" :
                                          "Offline — click to connect"}
          </button>

          <div className="p-4 space-y-3">
            {/* Caller ID */}
            <div>
              <label className="text-[10px] font-mono uppercase text-muted-foreground block mb-1">Caller ID</label>
              <select
                value={callerId}
                onChange={e => setCallerId(e.target.value)}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {numbers.length === 0
                  ? <option value="">No numbers configured</option>
                  : numbers.map(n => (
                    <option key={n.id} value={n.number}>
                      {n.friendlyName ? `${n.friendlyName} · ${n.number}` : n.number}
                      {n.vapiPhoneNumberId ? " ✓" : ""}
                    </option>
                  ))}
              </select>
              {selectedNumber && !selectedNumber.vapiPhoneNumberId && (
                <p className="text-[9px] font-mono text-yellow-500/80 mt-1">⚠ Not synced to Vapi — go to Numbers → Sync to Vapi</p>
              )}
            </div>

            {/* Campaign */}
            <div>
              <label className="text-[10px] font-mono uppercase text-muted-foreground block mb-1">Campaign (optional)</label>
              <select
                value={campaignId}
                onChange={e => setCampaignId(e.target.value ? Number(e.target.value) : "")}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="">— None —</option>
                {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            {/* Number display */}
            <div className="flex items-center gap-2 bg-background border border-border rounded px-3 py-2 min-h-[40px]">
              <span className="flex-1 font-mono text-base tracking-widest">
                {phone || <span className="text-muted-foreground text-sm">Enter number…</span>}
              </span>
              {phone && (
                <button onClick={() => setPhone(p => p.slice(0, -1))}
                  className="text-muted-foreground hover:text-foreground">
                  <Delete className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Numpad */}
            <div className="grid grid-cols-3 gap-1.5">
              {NUMPAD.flat().map(d => (
                <button key={d} onClick={() => dial(d)}
                  className="h-10 rounded bg-white/5 hover:bg-white/10 border border-border/50 hover:border-border font-mono text-base text-foreground transition-all active:scale-95">
                  {d}
                </button>
              ))}
            </div>

            {/* Call button */}
            {callState === "idle" ? (
              <button onClick={makeCall} disabled={!phone.trim() || sdkStatus !== "online"}
                className="w-full h-11 rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-mono text-sm flex items-center justify-center gap-2 transition-all">
                <Phone className="w-4 h-4" />Call via Vapi
              </button>
            ) : callState === "calling" ? (
              <button disabled
                className="w-full h-11 rounded-lg bg-yellow-600 text-white font-mono text-sm flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />Connecting…
              </button>
            ) : (
              <button onClick={endBrowserSession}
                className="w-full h-11 rounded-lg bg-red-600 hover:bg-red-700 text-white font-mono text-sm flex items-center justify-center gap-2 transition-all">
                <PhoneOff className="w-4 h-4" />End Call
              </button>
            )}

            {/* Browser AI session */}
            <div className="pt-1 border-t border-border/40">
              <p className="text-[9px] font-mono uppercase text-muted-foreground mb-1.5 tracking-wider">Browser AI Session</p>
              {callState === "idle" ? (
                <button onClick={startBrowserSession} disabled={sdkStatus !== "online"}
                  className="w-full h-9 rounded border border-violet-500/30 bg-violet-500/5 hover:bg-violet-500/10 disabled:opacity-40 disabled:cursor-not-allowed text-violet-300 font-mono text-xs flex items-center justify-center gap-2 transition-all">
                  <Headphones className="w-3.5 h-3.5" />Connect Browser
                </button>
              ) : callState === "active" ? (
                <div className="space-y-1.5">
                  <div className="rounded border border-violet-500/30 bg-violet-500/5 p-2 text-center">
                    <div className="flex items-center justify-center gap-1.5 mb-1">
                      {speaking
                        ? <Volume2 className="w-3 h-3 text-violet-400 animate-pulse"/>
                        : <VolumeX className="w-3 h-3 text-muted-foreground"/>}
                      <span className="text-[10px] font-mono text-muted-foreground">{speaking ? "AI speaking" : "Listening"}</span>
                    </div>
                    <span className="font-mono text-xl text-violet-400">{callTimer}</span>
                  </div>
                  <div className="flex gap-1.5">
                    <button onClick={toggleMute}
                      className={cn("flex-1 h-8 rounded border text-[10px] font-mono flex items-center justify-center gap-1 transition-all",
                        muted ? "border-red-500/50 bg-red-500/10 text-red-400" : "border-border bg-white/5 text-muted-foreground hover:text-foreground")}>
                      {muted ? <MicOff className="w-3 h-3"/> : <Mic className="w-3 h-3"/>}
                      {muted ? "Unmute" : "Mute"}
                    </button>
                    <button onClick={endBrowserSession}
                      className="flex-1 h-8 rounded bg-red-600 hover:bg-red-700 text-white text-[10px] font-mono flex items-center justify-center gap-1 transition-all">
                      <PhoneOff className="w-3 h-3"/>End
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {/* ── MIDDLE: Inbound / waiting ──────────────────────────────────── */}
        <div className="bg-card border border-border rounded-lg">
          <div className="p-4 border-b border-border/40">
            <div className="flex items-center gap-2">
              <PhoneIncoming className="w-3.5 h-3.5 text-blue-400" />
              <h2 className="text-xs font-mono uppercase tracking-widest">Inbound</h2>
            </div>
          </div>

          {activeBrowserCall ? (
            <div className="p-4">
              <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-4 text-center">
                <p className="font-mono text-lg text-foreground">{activeBrowserCall.phoneNumber}</p>
                <p className="text-xs font-mono text-green-400 mt-1">Active call</p>
              </div>
            </div>
          ) : (
            <div className="p-8 flex flex-col items-center justify-center min-h-[200px]">
              <Headphones className={cn("w-12 h-12 mb-3",
                sdkStatus === "online" ? "text-muted-foreground/40" : "text-muted-foreground/20")} />
              <p className="text-sm font-mono text-muted-foreground text-center">
                {sdkStatus === "online" ? "Waiting for calls" : "Phone is offline"}
              </p>
              <p className="text-xs font-mono text-muted-foreground/60 mt-1 text-center">
                {sdkStatus === "online"
                  ? "Inbound Vapi calls appear in Active Calls above."
                  : "Click the status bar to reconnect."}
              </p>
              {sdkStatus !== "online" && (
                <button onClick={initSdk}
                  className="mt-4 h-8 px-4 rounded border border-border bg-white/5 hover:bg-white/10 text-xs font-mono text-muted-foreground hover:text-foreground flex items-center gap-1.5 transition-all">
                  <RefreshCw className={cn("w-3 h-3", sdkStatus === "connecting" && "animate-spin")} />
                  {sdkStatus === "connecting" ? "Connecting…" : "Reconnect"}
                </button>
              )}
            </div>
          )}

          {/* Recent calls list */}
          {recentCalls.length > 0 && (
            <div className="border-t border-border/40">
              <div className="px-4 py-2 flex items-center gap-2">
                <Clock className="w-3 h-3 text-muted-foreground" />
                <span className="text-[10px] font-mono uppercase text-muted-foreground tracking-wider">Recent</span>
              </div>
              <div className="max-h-[280px] overflow-y-auto">
                {recentCalls.map(c => (
                  <button key={c.id}
                    onClick={() => c.phoneNumber && setPhone(c.phoneNumber)}
                    title="Click to call back via Vapi"
                    className="w-full flex items-center gap-3 px-4 py-2 hover:bg-white/5 transition-colors text-left">
                    <div className="flex-1 min-w-0">
                      <p className="font-mono text-xs text-foreground truncate">{c.phoneNumber || "Unknown"}</p>
                      <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
                        <span className={cn("uppercase",
                          c.direction === "inbound" ? "text-blue-400/80" : "text-green-400/80")}>{c.direction || "—"}</span>
                        <span>·</span>
                        <span>{fmtTime(c.timestamp)}</span>
                        <span>·</span>
                        <span>{fmtDur(c.duration)}</span>
                      </div>
                    </div>
                    <span className={cn("text-[9px] font-mono uppercase px-1.5 py-0.5 rounded",
                      c.status === "completed" || c.status === "answered"
                        ? "bg-green-500/10 text-green-400"
                        : c.status === "missed" || c.status === "no-answer"
                        ? "bg-red-500/10 text-red-400"
                        : "bg-white/5 text-muted-foreground"
                    )}>{c.status || "—"}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT: Today's stats ──────────────────────────────────────── */}
        <div className="space-y-3">
          <div className="bg-card border border-border rounded-lg p-4">
            <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-3">Today</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-3xl font-mono text-foreground tabular-nums">{stats?.total ?? 0}</p>
                <p className="text-[10px] font-mono text-muted-foreground mt-0.5">Calls</p>
              </div>
              <div>
                <p className="text-3xl font-mono text-foreground tabular-nums">{stats?.successRate ?? 0}%</p>
                <p className="text-[10px] font-mono text-muted-foreground mt-0.5">Success rate</p>
              </div>
            </div>
            {(stats?.total ?? 0) === 0 && (
              <p className="text-[11px] font-mono text-muted-foreground/60 mt-3">No calls yet today.</p>
            )}
          </div>

          <div className="bg-card border border-border rounded-lg p-4">
            <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-3">Breakdown</p>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-mono text-green-400">Completed</span>
                <span className="text-sm font-mono text-foreground tabular-nums">{stats?.completed ?? 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-mono text-red-400">Failed</span>
                <span className="text-sm font-mono text-foreground tabular-nums">{stats?.failed ?? 0}</span>
              </div>
            </div>
          </div>

          {/* Numbers reference */}
          {numbers.length > 0 && (
            <div className="bg-card border border-border rounded-lg p-4">
              <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">Your Numbers</p>
              <div className="space-y-1">
                {numbers.slice(0, 5).map(n => (
                  <div key={n.id} className="flex items-center gap-1.5">
                    <span className={cn("w-1.5 h-1.5 rounded-full shrink-0",
                      n.vapiPhoneNumberId ? "bg-green-400" : "bg-yellow-400")} />
                    <span className="font-mono text-[10px] text-foreground/80 truncate">
                      {n.friendlyName || n.number}
                    </span>
                  </div>
                ))}
                {numbers.length > 5 && (
                  <p className="text-[9px] font-mono text-muted-foreground/60">+{numbers.length - 5} more</p>
                )}
              </div>
              <p className="text-[9px] font-mono text-muted-foreground/50 mt-2">Green = synced to Vapi ✓</p>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
