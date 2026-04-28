import { useState, useEffect, useRef, useCallback } from "react";
import { Layout, PageHeader } from "@/components/layout";
import { customFetch } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Phone, PhoneOff, Mic, MicOff, Delete, Loader2,
  PhoneIncoming, PhoneCall, Pause, Play, UserPlus,
  ArrowRightLeft, Clock, Sparkles, Radio, Volume2, VolumeX,
} from "lucide-react";
import Vapi from "@vapi-ai/web";

// ── Types ─────────────────────────────────────────────────────────────────────
type BrowserCallState = "idle" | "connecting" | "active" | "error";

type PhoneNumber = { id: number; number: string; friendlyName?: string | null };
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

function elapsedSince(iso?: string): string {
  if (!iso) return "0:00";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || isNaN(ms)) return "0:00";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatTime(iso?: string | null) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch { return "—"; }
}

function formatDuration(s?: number | null) {
  if (!s || s < 1) return "—";
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

// ── Dial-pad digits ────────────────────────────────────────────────────────────
const NUMPAD = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  ["*", "0", "#"],
];

// ── Call timer ─────────────────────────────────────────────────────────────────
function useCallTimer(running: boolean) {
  const [elapsed, setElapsed] = useState(0);
  const ref = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (running) {
      setElapsed(0);
      ref.current = setInterval(() => setElapsed(s => s + 1), 1000);
    } else {
      if (ref.current) clearInterval(ref.current);
    }
    return () => { if (ref.current) clearInterval(ref.current); };
  }, [running]);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

// ── Vapi status badge ──────────────────────────────────────────────────────────
function VapiBadge({ state, sdkReady }: { state: BrowserCallState; sdkReady: boolean }) {
  const label =
    state === "active"     ? "Browser Session" :
    state === "connecting" ? "Connecting…"     :
    state === "error"      ? "Error"           :
    sdkReady               ? "Online"          : "Offline";

  const color =
    state === "active"     ? "bg-green-400 animate-pulse" :
    state === "connecting" ? "bg-yellow-400 animate-pulse":
    state === "error"      ? "bg-red-400"                 :
    sdkReady               ? "bg-green-400"               : "bg-white/30";

  return (
    <span className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground">
      <span className={cn("w-1.5 h-1.5 rounded-full", color)} />
      Vapi · {label}
    </span>
  );
}

// ── Main Dialer Component ──────────────────────────────────────────────────────
export default function DialerPage() {
  const [phone, setPhone]                       = useState("");
  const [campaignId, setCampaignId]             = useState<number | "">("");
  const [outboundCalling, setOutboundCalling]   = useState(false);
  const [browserState, setBrowserState]         = useState<BrowserCallState>("idle");
  const [muted, setMuted]                       = useState(false);
  const [agentSpeaking, setAgentSpeaking]       = useState(false);
  const [heldCallIds, setHeldCallIds]           = useState<Set<string>>(new Set());
  const [vapiSdkReady, setVapiSdkReady]         = useState(false);
  const vapiRef = useRef<Vapi | null>(null);
  const { toast } = useToast();
  const browserTimer = useCallTimer(browserState === "active");

  // 1-second tick to drive live elapsed timers in the active calls panel
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  void now;

  // ── Fetch data ──────────────────────────────────────────────────────────────
  const { data: numbers = [] } = useQuery<PhoneNumber[]>({
    queryKey: ["phone-numbers"],
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

  const { data: recentCdr = [], refetch: refetchCdr } = useQuery<CdrCall[]>({
    queryKey: ["calls-cdr-inbound"],
    queryFn: () => customFetch("/api/calls/cdr?direction=inbound&limit=10") as Promise<CdrCall[]>,
    refetchInterval: 8_000,
  });

  // ── Init Vapi Web SDK (browser session) ─────────────────────────────────────
  useEffect(() => {
    let instance: Vapi | null = null;
    customFetch("/api/vapi/web-key")
      .then((data) => {
        const { publicKey } = data as { publicKey: string };
        if (!publicKey) return;
        instance = new Vapi(publicKey);

        instance.on("call-start", () => {
          setBrowserState("active");
        });
        instance.on("call-end", () => {
          setBrowserState("idle");
          setMuted(false);
          setAgentSpeaking(false);
        });
        instance.on("error", (e: unknown) => {
          console.error("[Vapi] browser error:", e);
          setBrowserState("error");
        });
        instance.on("speech-start", () => setAgentSpeaking(true));
        instance.on("speech-end",   () => setAgentSpeaking(false));

        vapiRef.current = instance;
        setVapiSdkReady(true);
      })
      .catch(() => {
        setVapiSdkReady(false);
      });

    return () => {
      instance?.stop();
      vapiRef.current = null;
    };
  }, []);

  // ── Browser session (Vapi Web SDK) ─────────────────────────────────────────
  const startBrowserSession = useCallback(async () => {
    if (!vapiRef.current || browserState !== "idle") return;
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast({ title: "Mic blocked", description: "Allow microphone access and try again.", variant: "destructive" });
      return;
    }
    setBrowserState("connecting");
    try {
      // Inline (transient) assistant — no stored assistant needed
      await vapiRef.current.start({
        name: "Shivansh AI",
        firstMessage: "Hello! I'm Shivansh AI. How can I help you today?",
        model: {
          provider: "openai" as const,
          model: "gpt-4o-mini",
          messages: [{ role: "system" as const, content: "You are a friendly, professional AI assistant for Shivansh. Help the agent test and verify the AI script." }],
        },
        voice: { provider: "11labs" as const, voiceId: "21m00Tcm4TlvDq8ikWAM" },
      });
    } catch (err: unknown) {
      setBrowserState("error");
      toast({ title: "Connection failed", description: err instanceof Error ? err.message : "Could not start Vapi session", variant: "destructive" });
    }
  }, [browserState, toast]);

  const stopBrowserSession = useCallback(() => {
    vapiRef.current?.stop();
    setBrowserState("idle");
    setMuted(false);
    setAgentSpeaking(false);
  }, []);

  const toggleMute = useCallback(() => {
    if (!vapiRef.current || browserState !== "active") return;
    const next = !muted;
    vapiRef.current.setMuted(next);
    setMuted(next);
  }, [muted, browserState]);

  // ── Outbound: server-triggered Vapi call ───────────────────────────────────
  const makeOutboundCall = useCallback(async () => {
    if (!phone.trim()) {
      toast({ title: "Enter a number first", variant: "destructive" });
      return;
    }
    setOutboundCalling(true);
    try {
      await customFetch("/api/calls/manual", {
        method: "POST",
        body: JSON.stringify({
          phone: phone.trim(),
          campaignId: campaignId || undefined,
          provider: "vapi",
        }),
        headers: { "Content-Type": "application/json" },
      });
      toast({
        title: "Call initiated",
        description: `Vapi AI is calling ${phone.trim()} — see Active Calls below.`,
      });
      setPhone("");
      refetchLive();
    } catch (err: unknown) {
      toast({
        title: "Call failed",
        description: err instanceof Error ? err.message : "Check Vapi config / phone number setup",
        variant: "destructive",
      });
    } finally {
      setOutboundCalling(false);
    }
  }, [phone, campaignId, toast, refetchLive]);

  // ── Live-call action helpers ────────────────────────────────────────────────
  const callAction = useCallback(async (callControlId: string, action: "hangup" | "hold" | "unhold") => {
    try {
      await customFetch(`/api/calls/${encodeURIComponent(callControlId)}/${action}`, { method: "POST" });
      if (action === "hold")   setHeldCallIds(s => new Set(s).add(callControlId));
      if (action === "unhold") setHeldCallIds(s => { const n = new Set(s); n.delete(callControlId); return n; });
      toast({ title: action === "hangup" ? "Call ended" : action === "hold" ? "On hold" : "Resumed" });
      refetchLive();
    } catch (err: unknown) {
      toast({ title: `${action} failed`, description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    }
  }, [toast, refetchLive]);

  const promptAndAct = useCallback(async (callControlId: string, kind: "transfer" | "conference") => {
    const target = window.prompt(`Enter destination (E.164, e.g. +12035551234) for ${kind}:`);
    if (!target) return;
    if (!/^\+[1-9]\d{6,14}$/.test(target.trim())) {
      toast({ title: "Invalid number", description: "Must be E.164 like +12035551234", variant: "destructive" });
      return;
    }
    try {
      await customFetch(`/api/calls/${encodeURIComponent(callControlId)}/${kind}`, {
        method: "POST",
        body: JSON.stringify({ to: target.trim() }),
        headers: { "Content-Type": "application/json" },
      });
      toast({ title: kind === "transfer" ? "Transferring…" : "Bridging in…", description: target.trim() });
      refetchLive(); refetchCdr();
    } catch (err: unknown) {
      toast({ title: `${kind} failed`, description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    }
  }, [toast, refetchLive, refetchCdr]);

  // ── Dial pad digit ─────────────────────────────────────────────────────────
  const dial = (digit: string) => setPhone(p => (p + digit).slice(0, 16));

  const activeLiveCalls = liveCalls.filter(c => c.callControlId);

  return (
    <Layout>
      <PageHeader
        title="Softphone"
        subtitle="Vapi AI"
        action={<VapiBadge state={browserState} sdkReady={vapiSdkReady} />}
      />
      <div className="p-6 flex justify-center">
        <div className="w-full max-w-sm space-y-4">

          {/* ── Campaign context ─────────────────────────────────────────── */}
          <div>
            <label className="text-[10px] font-mono uppercase text-muted-foreground block mb-1">Campaign (optional)</label>
            <select
              value={campaignId}
              onChange={e => setCampaignId(e.target.value ? Number(e.target.value) : "")}
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">— Ad-hoc call —</option>
              {campaigns.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          {/* ── Dial pad card ────────────────────────────────────────────── */}
          <div className="bg-card border border-border rounded-lg p-4">
            {/* Number display */}
            <div className="flex items-center gap-2 min-h-[44px] mb-4">
              <span className="flex-1 text-xl font-mono text-foreground tracking-widest text-center">
                {phone || <span className="text-muted-foreground text-base">Enter number…</span>}
              </span>
              {phone && (
                <button type="button" onClick={() => setPhone(p => p.slice(0, -1))}
                  className="text-muted-foreground hover:text-foreground transition-colors">
                  <Delete className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Digits */}
            <div className="grid grid-cols-3 gap-2 mb-3">
              {NUMPAD.flat().map(digit => (
                <button key={digit} type="button" onClick={() => dial(digit)}
                  className="h-12 rounded-lg bg-white/5 hover:bg-white/10 border border-border/50 hover:border-border font-mono text-lg text-foreground transition-all active:scale-95">
                  {digit}
                </button>
              ))}
            </div>

            {/* Manual input */}
            <Input
              value={phone}
              onChange={e => setPhone(e.target.value.slice(0, 16))}
              className="font-mono text-sm text-center mb-4"
              placeholder="+1XXXXXXXXXX"
            />

            {/* Outbound call button */}
            <Button
              className="w-full h-12 bg-violet-600 hover:bg-violet-700 text-white font-mono uppercase tracking-wider text-sm"
              onClick={makeOutboundCall}
              disabled={outboundCalling || !phone.trim()}
            >
              {outboundCalling ? (
                <span className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Initiating…</span>
              ) : (
                <span className="flex items-center gap-2"><Phone className="w-4 h-4" />Call via Vapi AI</span>
              )}
            </Button>
          </div>

          {/* ── Browser session card ─────────────────────────────────────── */}
          {vapiSdkReady && (
            <div className={cn(
              "bg-card border rounded-lg p-4 transition-all",
              browserState === "active" ? "border-violet-500/50" : "border-border",
            )}>
              <div className="flex items-center gap-2 mb-3">
                <Radio className={cn("w-3.5 h-3.5", browserState === "active" ? "text-violet-400" : "text-muted-foreground")} />
                <h3 className="text-xs font-mono uppercase tracking-wider text-foreground">Browser AI Session</h3>
                <span className="ml-auto text-[10px] font-mono text-muted-foreground">
                  Talk to Vapi AI from browser
                </span>
              </div>

              {browserState === "active" ? (
                <>
                  {/* Active session display */}
                  <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-3 mb-3 text-center">
                    <div className="flex items-center justify-center gap-2 mb-1">
                      {agentSpeaking
                        ? <Volume2 className="w-3.5 h-3.5 text-violet-400 animate-pulse" />
                        : <VolumeX className="w-3.5 h-3.5 text-muted-foreground" />}
                      <span className="text-xs font-mono text-muted-foreground">
                        {agentSpeaking ? "AI speaking…" : "Listening…"}
                      </span>
                    </div>
                    <p className="font-mono text-2xl text-violet-400">{browserTimer}</p>
                  </div>

                  <div className="flex gap-2">
                    <button onClick={toggleMute}
                      className={cn(
                        "flex-1 h-10 rounded-lg border font-mono text-xs flex items-center justify-center gap-1.5 transition-all",
                        muted
                          ? "border-red-500/50 bg-red-500/10 text-red-400"
                          : "border-border bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
                      )}>
                      {muted ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
                      {muted ? "Unmute" : "Mute"}
                    </button>
                    <button onClick={stopBrowserSession}
                      className="flex-1 h-10 rounded-lg bg-red-600 hover:bg-red-700 text-white font-mono text-xs flex items-center justify-center gap-1.5 transition-all">
                      <PhoneOff className="w-3.5 h-3.5" />End Session
                    </button>
                  </div>
                </>
              ) : (
                <button
                  onClick={startBrowserSession}
                  disabled={browserState === "connecting" || !vapiRef.current}
                  className={cn(
                    "w-full h-10 rounded-lg border font-mono text-xs flex items-center justify-center gap-2 transition-all",
                    browserState === "error"
                      ? "border-red-500/30 bg-red-500/5 text-red-400"
                      : "border-violet-500/30 bg-violet-500/5 text-violet-300 hover:bg-violet-500/10"
                  )}
                >
                  {browserState === "connecting"
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Connecting…</>
                    : browserState === "error"
                    ? <><Sparkles className="w-3.5 h-3.5" />Retry Session</>
                    : <><Sparkles className="w-3.5 h-3.5" />Start Browser Session</>}
                </button>
              )}
            </div>
          )}

          {/* ── Active AI Calls ──────────────────────────────────────────── */}
          <div className="bg-card border border-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <PhoneCall className={cn("w-3.5 h-3.5", activeLiveCalls.length > 0 ? "text-green-400" : "text-muted-foreground")} />
              <h3 className="text-xs font-mono uppercase tracking-wider text-foreground">Active AI Calls</h3>
              <span className="ml-auto text-[10px] font-mono text-muted-foreground">
                {activeLiveCalls.length} live
              </span>
            </div>
            {activeLiveCalls.length === 0 ? (
              <div className="py-6 text-center">
                <div className="w-10 h-10 mx-auto mb-2 rounded-full border border-border/50 flex items-center justify-center">
                  <PhoneIncoming className="w-4 h-4 text-muted-foreground/50" />
                </div>
                <p className="text-[11px] font-mono text-muted-foreground">Waiting for calls…</p>
                <p className="text-[10px] font-mono text-muted-foreground/60 mt-1">Vapi calls appear here in real time</p>
              </div>
            ) : (
              <div className="space-y-3">
                {activeLiveCalls.map(c => {
                  const cid = c.callControlId!;
                  const held = heldCallIds.has(cid);
                  const isInbound = c.direction === "inbound";
                  const isVapi = c.providerUsed === "vapi" || cid.startsWith("vapi:");
                  return (
                    <div key={cid} className={cn(
                      "rounded-lg border p-3 transition-all",
                      held
                        ? "border-yellow-500/40 bg-yellow-500/5"
                        : isInbound
                          ? "border-blue-500/30 bg-blue-500/5"
                          : "border-green-500/30 bg-green-500/5"
                    )}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={cn(
                            "text-[9px] font-mono uppercase px-1.5 py-0.5 rounded shrink-0",
                            isInbound ? "bg-blue-500/20 text-blue-300" : "bg-green-500/20 text-green-300"
                          )}>
                            {isInbound ? "IN" : "OUT"}
                          </span>
                          {isVapi && (
                            <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 shrink-0">
                              Vapi
                            </span>
                          )}
                          <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", held ? "bg-yellow-400" : "bg-green-400 animate-pulse")} />
                          <span className="font-mono text-sm text-foreground truncate">{c.phoneNumber || "Unknown"}</span>
                        </div>
                        <span className="text-[10px] font-mono uppercase text-muted-foreground shrink-0 ml-2">
                          {held ? "On Hold" : "Live"}
                        </span>
                      </div>

                      <div className="flex items-baseline justify-between mb-3">
                        <div className="min-w-0">
                          {c.campaignName && (
                            <div className="text-[10px] font-mono text-muted-foreground truncate">
                              {c.campaignName}{c.agentName ? ` · ${c.agentName}` : ""}
                            </div>
                          )}
                        </div>
                        <div className={cn("font-mono text-xl tabular-nums", held ? "text-yellow-400" : "text-green-400")}>
                          {elapsedSince(c.startedAt)}
                        </div>
                      </div>

                      <div className="grid grid-cols-4 gap-1.5">
                        <button onClick={() => callAction(cid, held ? "unhold" : "hold")}
                          className={cn(
                            "h-10 rounded border font-mono text-[10px] flex flex-col items-center justify-center gap-0.5 transition-all",
                            held
                              ? "border-green-500/40 bg-green-500/10 text-green-400 hover:bg-green-500/20"
                              : "border-border bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
                          )}>
                          {held ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                          <span>{held ? "Resume" : "Hold"}</span>
                        </button>
                        <button onClick={() => promptAndAct(cid, "transfer")}
                          className="h-10 rounded border border-border bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 font-mono text-[10px] flex flex-col items-center justify-center gap-0.5 transition-all">
                          <ArrowRightLeft className="w-3 h-3" />
                          <span>Transfer</span>
                        </button>
                        <button onClick={() => promptAndAct(cid, "conference")}
                          className="h-10 rounded border border-border bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 font-mono text-[10px] flex flex-col items-center justify-center gap-0.5 transition-all">
                          <UserPlus className="w-3 h-3" />
                          <span>Conf</span>
                        </button>
                        <button onClick={() => callAction(cid, "hangup")}
                          className="h-10 rounded bg-red-600 hover:bg-red-700 text-white font-mono text-[10px] flex flex-col items-center justify-center gap-0.5 transition-all">
                          <PhoneOff className="w-3 h-3" />
                          <span>End</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── Recent Inbound ───────────────────────────────────────────── */}
          <div className="bg-card border border-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <PhoneIncoming className="w-3.5 h-3.5 text-blue-400" />
              <h3 className="text-xs font-mono uppercase tracking-wider text-foreground">Recent Inbound</h3>
              <span className="ml-auto text-[10px] font-mono text-muted-foreground">{recentCdr.length}</span>
            </div>
            {recentCdr.length === 0 ? (
              <p className="text-[11px] font-mono text-muted-foreground text-center py-4">No inbound calls yet</p>
            ) : (
              <div className="space-y-1 max-h-[280px] overflow-y-auto">
                {recentCdr.map(c => (
                  <button key={c.id}
                    onClick={() => c.phoneNumber && setPhone(c.phoneNumber)}
                    className="w-full flex items-center gap-2 px-2 py-2 rounded hover:bg-white/5 transition-colors text-left"
                    title="Tap to call back via Vapi">
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-xs text-foreground truncate">{c.phoneNumber || "Unknown"}</div>
                      <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
                        <Clock className="w-2.5 h-2.5" />
                        <span>{formatTime(c.timestamp)}</span>
                        <span>·</span>
                        <span>{formatDuration(c.duration)}</span>
                      </div>
                    </div>
                    <span className={cn(
                      "text-[9px] font-mono uppercase px-1.5 py-0.5 rounded",
                      c.status === "completed" || c.status === "answered"
                        ? "bg-green-500/10 text-green-400"
                        : c.status === "missed" || c.status === "no-answer"
                        ? "bg-red-500/10 text-red-400"
                        : "bg-white/5 text-muted-foreground"
                    )}>
                      {c.status || "—"}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ── Numbers reference ────────────────────────────────────────── */}
          {numbers.length > 0 && (
            <div className="rounded border border-border/50 px-3 py-2">
              <p className="text-[10px] font-mono text-muted-foreground mb-1 uppercase tracking-wider">Your Numbers</p>
              {numbers.slice(0, 3).map(n => (
                <p key={n.id} className="font-mono text-[11px] text-foreground/80">
                  {n.number}{n.friendlyName ? ` — ${n.friendlyName}` : ""}
                </p>
              ))}
              {numbers.length > 3 && (
                <p className="font-mono text-[10px] text-muted-foreground/60 mt-0.5">+{numbers.length - 3} more</p>
              )}
            </div>
          )}

        </div>
      </div>
    </Layout>
  );
}
