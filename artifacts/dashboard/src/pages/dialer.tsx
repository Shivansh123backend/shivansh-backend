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
} from "lucide-react";
// @ts-expect-error — Telnyx SDK types bundled internally
import { TelnyxRTC } from "@telnyx/webrtc";

// ── Types ─────────────────────────────────────────────────────────────────────
type SipState = "disconnected" | "connecting" | "connected" | "error";
type CallState = "idle" | "calling" | "ringing" | "active" | "held";

type PhoneNumber = { id: number; number: string; friendlyName?: string | null };

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
    try {
      const { token } = await customFetch("/api/calls/webrtc-token") as { token: string };

      const client = new TelnyxRTC({ login_token: token });
      clientRef.current = client;

      client.on("telnyx.ready", () => setSipState("connected"));

      client.on("telnyx.error", (err: unknown) => {
        console.error("Telnyx error:", err);
        setSipState("error");
        toast({ title: "SIP Error", description: "WebRTC connection failed", variant: "destructive" });
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

  // Auto-connect on mount
  useEffect(() => {
    connect();
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
