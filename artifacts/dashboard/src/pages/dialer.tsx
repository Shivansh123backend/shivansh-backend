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
  Radio, AlertCircle, PhoneIncoming, PhoneCall,
  Pause, Play, UserPlus, ArrowRightLeft, Clock,
} from "lucide-react";
// @ts-expect-error — Telnyx SDK types bundled internally
import { TelnyxRTC } from "@telnyx/webrtc";

// ── Types ─────────────────────────────────────────────────────────────────────
type SipState = "disconnected" | "connecting" | "connected" | "error";
type CallState = "idle" | "calling" | "ringing" | "active" | "held";

type PhoneNumber = { id: number; number: string; friendlyName?: string | null };

type LiveCall = {
  id: number | string;
  callControlId?: string;
  phoneNumber?: string | null;
  status?: string;
  startedAt?: string;
  campaignId?: number | null;
};

type CdrCall = {
  id: number | string;
  phoneNumber?: string | null;
  direction?: string;
  status?: string;
  duration?: number | null;
  timestamp?: string | null;
};

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

// ── Dial-pad digits ──────────────────────────────────────────────────────────
const NUMPAD = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  ["*", "0", "#"],
];

// ── Helper: SIP status badge ──────────────────────────────────────────────────
function SipBadge({ state }: { state: SipState }) {
  const cfg: Record<SipState, { color: string; label: string }> = {
    disconnected: { color: "bg-gray-400", label: "SIP: Offline" },
    connecting:   { color: "bg-yellow-400 animate-pulse", label: "SIP: Connecting…" },
    connected:    { color: "bg-green-400", label: "SIP: Ready" },
    error:        { color: "bg-red-400", label: "SIP: Error" },
  };
  const { color, label } = cfg[state];
  return (
    <span className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground">
      <span className={cn("w-1.5 h-1.5 rounded-full", color)} />
      {label}
    </span>
  );
}

// ── Call timer ────────────────────────────────────────────────────────────────
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

// ── Main Dialer Component ─────────────────────────────────────────────────────
export default function DialerPage() {
  const [sipState, setSipState] = useState<SipState>("disconnected");
  const [callState, setCallState] = useState<CallState>("idle");
  const [phone, setPhone] = useState("");
  const [callerId, setCallerId] = useState("");
  const [muted, setMuted] = useState(false);
  const [activeCallPhone, setActiveCallPhone] = useState("");
  const clientRef = useRef<InstanceType<typeof TelnyxRTC> | null>(null);
  const callRef = useRef<ReturnType<InstanceType<typeof TelnyxRTC>["newCall"]> | null>(null);
  const { toast } = useToast();
  const callTimer = useCallTimer(callState === "active");

  // Fetch available phone numbers for caller ID selection
  const { data: numbers = [] } = useQuery<PhoneNumber[]>({
    queryKey: ["phone-numbers"],
    queryFn: () => customFetch("/api/numbers") as Promise<PhoneNumber[]>,
  });

  // ── Active AI calls (poll every 4s) — to render live call controls ─────────
  const { data: liveCalls = [], refetch: refetchLive } = useQuery<LiveCall[]>({
    queryKey: ["calls-live"],
    queryFn: () => customFetch("/api/calls/live") as Promise<LiveCall[]>,
    refetchInterval: 4_000,
  });

  // ── Recent inbound calls (poll every 8s) — "who called" panel ──────────────
  const { data: recentCdr = [], refetch: refetchCdr } = useQuery<CdrCall[]>({
    queryKey: ["calls-cdr-inbound"],
    queryFn: () => customFetch("/api/calls/cdr?direction=inbound&limit=10") as Promise<CdrCall[]>,
    refetchInterval: 8_000,
  });

  // Track which calls are on hold so the UI knows whether to show Hold or Resume
  const [heldCallIds, setHeldCallIds] = useState<Set<string>>(new Set());

  // ── Live-call action helpers ───────────────────────────────────────────────
  const callAction = useCallback(async (callControlId: string, action: "hangup" | "hold" | "unhold", body?: object) => {
    try {
      await customFetch(`/api/calls/${encodeURIComponent(callControlId)}/${action}`, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined,
        headers: body ? { "Content-Type": "application/json" } : undefined,
      });
      if (action === "hold") setHeldCallIds(s => new Set(s).add(callControlId));
      if (action === "unhold") setHeldCallIds(s => { const n = new Set(s); n.delete(callControlId); return n; });
      toast({ title: action === "hangup" ? "Call ended" : action === "hold" ? "On hold" : "Resumed" });
      refetchLive();
    } catch (err: unknown) {
      toast({
        title: `${action} failed`,
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }, [toast, refetchLive]);

  const promptAndAct = useCallback(async (callControlId: string, kind: "transfer" | "conference") => {
    const target = window.prompt(`Enter destination phone (E.164, e.g. +12035551234) for ${kind}:`);
    if (!target) return;
    if (!/^\+[1-9]\d{6,14}$/.test(target.trim())) {
      toast({ title: "Invalid number", description: "Must be E.164 format like +12035551234", variant: "destructive" });
      return;
    }
    try {
      await customFetch(`/api/calls/${encodeURIComponent(callControlId)}/${kind}`, {
        method: "POST",
        body: JSON.stringify({ to: target.trim() }),
        headers: { "Content-Type": "application/json" },
      });
      toast({ title: kind === "transfer" ? "Transferring…" : "Bridging in…", description: target.trim() });
      refetchLive();
      refetchCdr();
    } catch (err: unknown) {
      toast({
        title: `${kind} failed`,
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }, [toast, refetchLive, refetchCdr]);

  // Set default caller ID once numbers load
  useEffect(() => {
    if (numbers.length > 0 && !callerId) {
      setCallerId(numbers[0].number);
    }
  }, [numbers, callerId]);

  // ── Connect to Telnyx SIP ────────────────────────────────────────────────
  const connect = useCallback(async () => {
    if (sipState === "connecting" || sipState === "connected") return;
    setSipState("connecting");

    // Step 1: Request mic permission FIRST (mobile browsers need user gesture).
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Release the test stream — Telnyx SDK will request its own.
      stream.getTracks().forEach(t => t.stop());
    } catch (err: unknown) {
      setSipState("error");
      const msg = err instanceof Error ? err.message : "Microphone access denied";
      toast({
        title: "Microphone blocked",
        description: msg.includes("Permission") || msg.includes("denied")
          ? "Tap the lock icon → Site Settings → Microphone → Allow, then reload."
          : msg,
        variant: "destructive",
      });
      return;
    }

    try {
      // Step 2: Get a fresh Telnyx JWT.
      const { token } = await customFetch("/api/calls/webrtc-token") as { token: string };

      // Step 3: Build SDK with mobile-friendly opts (UDP/RTC over wss only).
      const client = new TelnyxRTC({
        login_token: token,
        ringtoneFile: undefined,
        ringbackFile: undefined,
      });
      clientRef.current = client;

      client.on("telnyx.ready", () => {
        console.info("[Telnyx] SIP ready");
        setSipState("connected");
      });

      client.on("telnyx.error", (err: unknown) => {
        console.error("[Telnyx] error:", err);
        setSipState("error");
        const e = err as { error?: string; message?: string; cause?: string };
        toast({
          title: "SIP Error",
          description: e?.cause ?? e?.message ?? e?.error ?? "WebRTC negotiation failed — check network/firewall.",
          variant: "destructive",
        });
      });

      client.on("telnyx.socket.close", () => {
        setSipState("disconnected");
        setCallState("idle");
        callRef.current = null;
      });

      client.on("telnyx.notification", (notification: { type: string; call: Record<string, unknown> }) => {
        if (notification.type !== "callUpdate") return;
        const call = notification.call as {
          state: string;
          id: string;
          remoteCallerNumber?: string;
          answer: () => void;
          hangup: () => void;
          muteAudio: () => void;
          unmuteAudio: () => void;
        };
        callRef.current = call as ReturnType<InstanceType<typeof TelnyxRTC>["newCall"]>;

        switch (call.state) {
          case "ringing":
            setCallState("ringing");
            setActiveCallPhone(call.remoteCallerNumber ?? "Unknown");
            break;
          case "active":
            setCallState("active");
            break;
          case "held":
            setCallState("held");
            break;
          case "hangup":
          case "destroy":
          case "purge":
            setCallState("idle");
            setActiveCallPhone("");
            setMuted(false);
            callRef.current = null;
            break;
        }
      });

      client.connect();
    } catch (err: unknown) {
      setSipState("error");
      toast({
        title: "Connection Failed",
        description: err instanceof Error ? err.message : "Could not get WebRTC credentials",
        variant: "destructive",
      });
    }
  }, [sipState, toast]);

  // Auto-connect on desktop only — mobile browsers (iOS Safari, mobile Chrome)
  // require a user gesture before getUserMedia / WebRTC, so we wait for tap.
  useEffect(() => {
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (!isMobile) connect();
    return () => {
      if (clientRef.current) {
        clientRef.current.disconnect();
        clientRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Dial pad ──────────────────────────────────────────────────────────────
  const dial = (digit: string) => {
    setPhone(p => (p + digit).slice(0, 16));
    // DTMF during active call
    if (callRef.current && callState === "active") {
      try { (callRef.current as unknown as { dtmf: (d: string) => void }).dtmf(digit); } catch { /* ignore */ }
    }
  };

  // ── Make call ─────────────────────────────────────────────────────────────
  const makeCall = () => {
    if (!clientRef.current || sipState !== "connected") {
      toast({ title: "Not connected", description: "SIP client is not ready yet", variant: "destructive" });
      return;
    }
    if (!phone.trim()) {
      toast({ title: "Enter a number first", variant: "destructive" });
      return;
    }
    try {
      const call = clientRef.current.newCall({
        destinationNumber: phone.trim(),
        callerNumber: callerId || undefined,
      });
      callRef.current = call;
      setCallState("calling");
      setActiveCallPhone(phone.trim());
    } catch (err: unknown) {
      toast({ title: "Call failed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    }
  };

  // ── Hangup ────────────────────────────────────────────────────────────────
  const hangup = () => {
    try { callRef.current?.hangup(); } catch { /* ignore */ }
    setCallState("idle");
    setActiveCallPhone("");
    setMuted(false);
    callRef.current = null;
  };

  // ── Answer (incoming) ────────────────────────────────────────────────────
  const answer = () => {
    try { callRef.current?.answer(); } catch { /* ignore */ }
  };

  // ── Mute toggle ───────────────────────────────────────────────────────────
  const toggleMute = () => {
    if (!callRef.current) return;
    try {
      if (muted) callRef.current.unmuteAudio();
      else callRef.current.muteAudio();
      setMuted(m => !m);
    } catch { /* ignore */ }
  };

  const inCall = callState === "calling" || callState === "ringing" || callState === "active" || callState === "held";

  return (
    <Layout>
      <PageHeader
        title="Dialer"
        subtitle="Telnyx WebRTC Softphone"
        action={<SipBadge state={sipState} />}
      />
      <div className="p-6 flex justify-center">
        <div className="w-full max-w-sm space-y-4">

          {/* Caller ID selector */}
          <div>
            <label className="text-[10px] font-mono uppercase text-muted-foreground block mb-1">Caller ID</label>
            <select
              value={callerId}
              onChange={e => setCallerId(e.target.value)}
              disabled={inCall}
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {numbers.map(n => (
                <option key={n.id} value={n.number}>{n.number}{n.friendlyName ? ` — ${n.friendlyName}` : ""}</option>
              ))}
              {numbers.length === 0 && <option value="">No numbers configured</option>}
            </select>
          </div>

          {/* Active call overlay */}
          {inCall && (
            <div className={cn(
              "rounded-lg border p-4 text-center",
              callState === "active" ? "border-green-500/40 bg-green-500/5" :
              callState === "ringing" ? "border-yellow-500/40 bg-yellow-500/5 animate-pulse" :
              "border-border bg-white/[0.02]"
            )}>
              <div className="flex items-center justify-center gap-2 mb-1">
                {callState === "calling" && <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />}
                {callState === "ringing" && <PhoneIncoming className="w-3.5 h-3.5 text-yellow-400" />}
                {callState === "active" && <PhoneCall className="w-3.5 h-3.5 text-green-400" />}
                <span className="font-mono text-xs capitalize text-muted-foreground">{callState}</span>
              </div>
              <p className="font-mono text-lg text-foreground">{activeCallPhone}</p>
              {callState === "active" && (
                <p className="font-mono text-xl text-green-400 mt-1">{callTimer}</p>
              )}
            </div>
          )}

          {/* Dial pad card */}
          <div className="bg-[hsl(224,71%,3%)] border border-border rounded-lg p-4">
            {/* Number display */}
            <div className="flex items-center gap-2 min-h-[44px] mb-4">
              <span className="flex-1 text-xl font-mono text-foreground tracking-widest text-center">
                {phone || <span className="text-muted-foreground text-base">Enter number...</span>}
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
                  disabled={callState === "ringing"}
                  className="h-12 rounded-lg bg-white/5 hover:bg-white/10 border border-border/50 hover:border-border font-mono text-lg text-foreground transition-all active:scale-95 disabled:opacity-40">
                  {digit}
                </button>
              ))}
            </div>

            {/* Manual input */}
            <Input
              value={phone}
              onChange={e => setPhone(e.target.value.slice(0, 16))}
              disabled={inCall}
              className="font-mono text-sm text-center mb-4"
              placeholder="+1XXXXXXXXXX"
            />

            {/* Call controls */}
            {!inCall ? (
              <Button
                className="w-full h-12 bg-green-600 hover:bg-green-700 text-white font-mono uppercase tracking-wider text-sm"
                onClick={makeCall}
                disabled={sipState !== "connected" || !phone.trim()}
              >
                {sipState === "connecting" ? (
                  <span className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Connecting SIP…</span>
                ) : (
                  <span className="flex items-center gap-2"><Phone className="w-4 h-4" />Call</span>
                )}
              </Button>
            ) : (
              <div className="flex gap-2">
                {/* Mute */}
                <button onClick={toggleMute} disabled={callState !== "active"}
                  className={cn(
                    "flex-1 h-12 rounded-lg border font-mono text-xs flex items-center justify-center gap-1.5 transition-all",
                    muted
                      ? "border-red-500/50 bg-red-500/10 text-red-400"
                      : "border-border bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10",
                    callState !== "active" && "opacity-40 cursor-not-allowed"
                  )}>
                  {muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                  {muted ? "Unmute" : "Mute"}
                </button>

                {/* Answer (if ringing) */}
                {callState === "ringing" && (
                  <button onClick={answer}
                    className="flex-1 h-12 rounded-lg border border-green-500/40 bg-green-500/10 text-green-400 hover:bg-green-500/20 font-mono text-xs flex items-center justify-center gap-1.5 transition-all">
                    <Phone className="w-4 h-4" />Answer
                  </button>
                )}

                {/* Hangup */}
                <button onClick={hangup}
                  className="flex-1 h-12 rounded-lg bg-red-600 hover:bg-red-700 text-white font-mono text-xs flex items-center justify-center gap-1.5 transition-all">
                  <PhoneOff className="w-4 h-4" />Hang Up
                </button>
              </div>
            )}
          </div>

          {/* ── Active AI Calls (live, with controls) ─────────────────────── */}
          {liveCalls.filter(c => c.callControlId).length > 0 && (
            <div className="bg-[hsl(224,71%,3%)] border border-border rounded-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                <PhoneCall className="w-3.5 h-3.5 text-green-400" />
                <h3 className="text-xs font-mono uppercase tracking-wider text-foreground">Active AI Calls</h3>
                <span className="ml-auto text-[10px] font-mono text-muted-foreground">
                  {liveCalls.filter(c => c.callControlId).length} live
                </span>
              </div>
              <div className="space-y-2">
                {liveCalls.filter(c => c.callControlId).map(c => {
                  const cid = c.callControlId!;
                  const held = heldCallIds.has(cid);
                  return (
                    <div key={cid} className="rounded-md border border-border bg-white/[0.02] p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className={cn(
                            "w-1.5 h-1.5 rounded-full",
                            held ? "bg-yellow-400" : "bg-green-400 animate-pulse"
                          )} />
                          <span className="font-mono text-sm text-foreground">{c.phoneNumber || "Unknown"}</span>
                        </div>
                        <span className="text-[10px] font-mono uppercase text-muted-foreground">
                          {held ? "On Hold" : (c.status || "in_progress")}
                        </span>
                      </div>
                      <div className="grid grid-cols-4 gap-1.5">
                        <button onClick={() => callAction(cid, held ? "unhold" : "hold")}
                          className={cn(
                            "h-9 rounded border font-mono text-[10px] flex flex-col items-center justify-center gap-0.5 transition-all",
                            held
                              ? "border-green-500/40 bg-green-500/10 text-green-400 hover:bg-green-500/20"
                              : "border-border bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10"
                          )}
                          title={held ? "Resume call" : "Hold call"}
                        >
                          {held ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                          <span>{held ? "Resume" : "Hold"}</span>
                        </button>
                        <button onClick={() => promptAndAct(cid, "transfer")}
                          className="h-9 rounded border border-border bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 font-mono text-[10px] flex flex-col items-center justify-center gap-0.5 transition-all"
                          title="Blind transfer to another number"
                        >
                          <ArrowRightLeft className="w-3 h-3" />
                          <span>Transfer</span>
                        </button>
                        <button onClick={() => promptAndAct(cid, "conference")}
                          className="h-9 rounded border border-border bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10 font-mono text-[10px] flex flex-col items-center justify-center gap-0.5 transition-all"
                          title="Bridge a third party into this call"
                        >
                          <UserPlus className="w-3 h-3" />
                          <span>Conf</span>
                        </button>
                        <button onClick={() => callAction(cid, "hangup")}
                          className="h-9 rounded bg-red-600 hover:bg-red-700 text-white font-mono text-[10px] flex flex-col items-center justify-center gap-0.5 transition-all"
                          title="End this call"
                        >
                          <PhoneOff className="w-3 h-3" />
                          <span>End</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Recent Inbound Calls (who has called) ─────────────────────── */}
          <div className="bg-[hsl(224,71%,3%)] border border-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <PhoneIncoming className="w-3.5 h-3.5 text-blue-400" />
              <h3 className="text-xs font-mono uppercase tracking-wider text-foreground">Recent Inbound</h3>
              <span className="ml-auto text-[10px] font-mono text-muted-foreground">
                {recentCdr.length}
              </span>
            </div>
            {recentCdr.length === 0 ? (
              <p className="text-[11px] font-mono text-muted-foreground text-center py-4">
                No inbound calls yet
              </p>
            ) : (
              <div className="space-y-1 max-h-[280px] overflow-y-auto">
                {recentCdr.map(c => (
                  <button
                    key={c.id}
                    onClick={() => c.phoneNumber && setPhone(c.phoneNumber)}
                    className="w-full flex items-center gap-2 px-2 py-2 rounded hover:bg-white/5 transition-colors text-left"
                    title="Tap to dial back"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-xs text-foreground truncate">
                        {c.phoneNumber || "Unknown"}
                      </div>
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

          {/* Reconnect button if error/disconnected */}
          {(sipState === "error" || sipState === "disconnected") && (
            <button onClick={connect}
              className="w-full flex items-center justify-center gap-2 py-2 rounded border border-border text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-white/5 transition-all">
              <Radio className="w-3 h-3" />Reconnect SIP
            </button>
          )}

          {sipState === "error" && (
            <div className="flex items-start gap-2 bg-red-500/5 border border-red-500/20 rounded px-3 py-2">
              <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
              <p className="text-[10px] font-mono text-red-300">
                SIP connection failed. Check your network and click Reconnect.
              </p>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
