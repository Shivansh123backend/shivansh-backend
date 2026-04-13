import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCampaigns, useListNumbers, useListAgents,
  getListCampaignsQueryKey, getListNumbersQueryKey, getListAgentsQueryKey,
} from "@workspace/api-client-react";
import { io, type Socket } from "socket.io-client";
import { Layout, PageHeader } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  GitBranch, Phone, Bot, Copy, CheckCheck, Terminal,
  Radio, ArrowRight, Shield, Zap, MessageSquare, PhoneIncoming,
} from "lucide-react";

const WEBHOOK_URL = "https://shivanshbackend.replit.app/api/webhooks/telnyx";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <CheckCheck className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

export default function InboundRoutesPage() {
  const { data: campaigns, isLoading: campLoading } = useListCampaigns();
  const { data: numbers, isLoading: numLoading } = useListNumbers();
  const { data: agents, isLoading: agentLoading } = useListAgents();

  const isLoading = campLoading || numLoading || agentLoading;

  const qc = useQueryClient();
  const socketRef = useRef<Socket | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);
  // campaignIds currently ringing (active inbound call arriving)
  const [ringingCampaigns, setRingingCampaigns] = useState<Set<number>>(new Set());
  const ringingTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  // ── Socket.IO live connection ────────────────────────────────────────────────
  useEffect(() => {
    const socket = io(window.location.origin, {
      path: "/socket.io",
      transports: ["websocket", "polling"],
    });
    socketRef.current = socket;

    socket.on("connect", () => setLiveConnected(true));
    socket.on("disconnect", () => setLiveConnected(false));

    const refreshData = () => {
      qc.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
      qc.invalidateQueries({ queryKey: getListNumbersQueryKey() });
      qc.invalidateQueries({ queryKey: getListAgentsQueryKey() });
    };

    // Inbound call arrives → flash the matching route card for 45 s
    socket.on("call:inbound", (data: { campaignId?: number; from?: string }) => {
      refreshData();
      const cid = data?.campaignId;
      if (!cid) return;

      setRingingCampaigns(prev => new Set([...prev, cid]));

      // Clear any existing timer for this campaign then set a new 45s auto-clear
      const existing = ringingTimers.current.get(cid);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        setRingingCampaigns(prev => {
          const next = new Set(prev);
          next.delete(cid);
          return next;
        });
        ringingTimers.current.delete(cid);
      }, 45_000);
      ringingTimers.current.set(cid, timer);
    });

    // Call ended → clear ringing state + refresh data
    socket.on("call:ended", (data: { callControlId?: string }) => {
      refreshData();
      // We can't easily match callControlId → campaignId here, so just clear all after ended
      // A short delay lets the DB settle before re-fetching
      setTimeout(refreshData, 800);
    });

    socket.on("call:started", refreshData);
    socket.on("call:transferred", refreshData);
    socket.on("call_update", refreshData);

    return () => {
      socket.disconnect();
      socketRef.current = null;
      // Clear all ringing timers
      ringingTimers.current.forEach(t => clearTimeout(t));
    };
  }, [qc]);

  // ── Derived data ─────────────────────────────────────────────────────────────
  const inboundCampaigns = (campaigns ?? []).filter(
    (c: { type: string }) => c.type === "inbound" || c.type === "both"
  );

  const agentMap = Object.fromEntries(
    (agents ?? []).map((a: { id: number; name: string }) => [a.id, a.name])
  );

  const numbersByCampaign = (numbers ?? []).reduce(
    (acc: Record<number, { id: number; phoneNumber: string; provider: string }[]>, n: {
      id: number; phoneNumber: string; provider: string; campaignId?: number;
    }) => {
      if (n.campaignId) {
        acc[n.campaignId] = acc[n.campaignId] ?? [];
        acc[n.campaignId].push(n);
      }
      return acc;
    },
    {}
  );

  const buildGreeting = (campaignName: string, agentName: string) =>
    `Thank you for calling ${campaignName}. This is ${agentName}. How may I help you today?`;

  return (
    <Layout>
      <PageHeader
        title="Inbound Routes"
        subtitle={`${inboundCampaigns.length} inbound route${inboundCampaigns.length !== 1 ? "s" : ""} configured`}
        action={
          <div className="flex items-center gap-2">
            {ringingCampaigns.size > 0 && (
              <div className="flex items-center gap-1.5 text-[10px] font-mono text-cyan-400 animate-pulse">
                <PhoneIncoming className="w-3 h-3" />
                {ringingCampaigns.size} RINGING
              </div>
            )}
            <div className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground">
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${liveConnected ? "bg-primary animate-pulse" : "bg-muted-foreground/40"}`} />
              {liveConnected ? "LIVE" : "connecting..."}
            </div>
          </div>
        }
      />

      <div className="p-6 space-y-6">

        {/* ── Webhook config card ── */}
        <div className="border border-border rounded bg-[hsl(224,71%,3%)]">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
            <Zap className="w-3.5 h-3.5 text-primary" />
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Telnyx Webhook Configuration</p>
          </div>
          <div className="p-4 space-y-4">
            <p className="text-[11px] font-mono text-muted-foreground leading-relaxed">
              Point your Telnyx phone number's webhook URL to this endpoint. All inbound calls will be
              answered automatically by the configured AI agent.
            </p>

            <div className="rounded border border-primary/20 bg-primary/5 px-3 py-2.5 flex items-center gap-2">
              <Terminal className="w-3.5 h-3.5 text-primary flex-shrink-0" />
              <span className="font-mono text-xs text-primary flex-1 truncate">{WEBHOOK_URL}</span>
              <CopyButton text={WEBHOOK_URL} />
            </div>

            <div className="space-y-2">
              <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Setup Steps</p>
              <div className="space-y-1.5">
                {[
                  "Log in to Telnyx Mission Control Portal (portal.telnyx.com)",
                  "Go to Numbers → My Numbers → select your phone number",
                  "Under Voice Settings, set Connection to 'Call Control'",
                  "Paste the webhook URL above into the 'Webhook URL' field",
                  "Set Webhook API Version to v2 and save",
                  "Assign the number to an Inbound or Both campaign below",
                ].map((step, i) => (
                  <div key={i} className="flex items-start gap-2.5 text-[10px] font-mono text-muted-foreground">
                    <span className="w-4 h-4 rounded-full bg-primary/10 border border-primary/20 text-primary flex-shrink-0 flex items-center justify-center text-[9px]">
                      {i + 1}
                    </span>
                    <span className="leading-relaxed pt-0.5">{step}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-start gap-2 rounded border border-amber-500/20 bg-amber-500/5 px-3 py-2">
              <Shield className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
              <p className="text-[10px] font-mono text-amber-400/80 leading-relaxed">
                Ensure your TELNYX_API_KEY is configured on the server — it is used to answer calls and
                control the AI greeting via Telnyx Call Control v2.
              </p>
            </div>
          </div>
        </div>

        {/* ── Greeting behavior ── */}
        <div className="border border-border rounded bg-[hsl(224,71%,3%)]">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
            <MessageSquare className="w-3.5 h-3.5 text-primary" />
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">AI Greeting Behavior</p>
          </div>
          <div className="p-4 space-y-3">
            <p className="text-[11px] font-mono text-muted-foreground leading-relaxed">
              When a call comes in, the AI agent answers immediately and speaks a personalized greeting
              built from the campaign and agent names.
            </p>

            <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono">
              {[
                { icon: PhoneIncoming, label: "Call Received", color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20" },
                null,
                { icon: Radio, label: "Auto-Answer", color: "text-green-400", bg: "bg-green-500/10 border-green-500/20" },
                null,
                { icon: Bot, label: "Greeting Spoken", color: "text-primary", bg: "bg-primary/10 border-primary/20" },
                null,
                { icon: GitBranch, label: "Transfer / Gather", color: "text-amber-400", bg: "bg-amber-500/10 border-amber-500/20" },
              ].map((item, i) =>
                item === null ? (
                  <ArrowRight key={i} className="w-3 h-3 text-muted-foreground/40" />
                ) : (
                  <div key={i} className={`flex items-center gap-1.5 px-2 py-1 rounded border ${item.bg} ${item.color}`}>
                    <item.icon className="w-3 h-3" />
                    {item.label}
                  </div>
                )
              )}
            </div>

            <div className="rounded border border-border bg-black/20 px-3 py-2.5">
              <p className="text-[9px] font-mono uppercase text-muted-foreground/60 mb-1.5">Greeting Template</p>
              <p className="text-[11px] font-mono text-foreground leading-relaxed">
                "Thank you for calling{" "}
                <span className="text-primary">[Campaign Name]</span>. This is{" "}
                <span className="text-primary">[Agent Name]</span>. How may I help you today?"
              </p>
            </div>

            <p className="text-[10px] font-mono text-muted-foreground/60 leading-relaxed">
              After the greeting: if the campaign has a <span className="text-foreground">Transfer Number</span> configured,
              the call is transferred there automatically. Otherwise the system acknowledges the caller and closes politely.
            </p>
          </div>
        </div>

        {/* ── Active inbound routes ── */}
        <div>
          <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-3">Active Inbound Routes</p>

          {isLoading ? (
            <div className="space-y-3">
              {[...Array(2)].map((_, i) => <Skeleton key={i} className="h-36 rounded" />)}
            </div>
          ) : inboundCampaigns.length === 0 ? (
            <div className="border border-dashed border-border rounded p-12 bg-[hsl(224,71%,3%)] flex flex-col items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-white/5 border border-border flex items-center justify-center">
                <GitBranch className="w-5 h-5 text-muted-foreground" />
              </div>
              <div className="text-center">
                <p className="text-xs font-mono text-foreground mb-1">No inbound routes yet</p>
                <p className="text-[10px] font-mono text-muted-foreground">
                  Create a campaign with type <span className="text-primary font-bold">Inbound</span> or <span className="text-primary font-bold">Both</span> and assign a phone number to it
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {inboundCampaigns.map((c: {
                id: number;
                name: string;
                status: string;
                type: string;
                agentId?: number;
                transferNumber?: string;
              }) => {
                const assignedNumbers = numbersByCampaign[c.id] ?? [];
                const agentName = c.agentId ? agentMap[c.agentId] ?? `Agent #${c.agentId}` : null;
                const isRinging = ringingCampaigns.has(c.id);

                return (
                  <div
                    key={c.id}
                    className={`border rounded bg-[hsl(224,71%,3%)] p-4 space-y-4 transition-all duration-300 ${
                      isRinging
                        ? "border-cyan-500/60 shadow-[0_0_12px_rgba(0,255,255,0.08)]"
                        : "border-border"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-sm font-mono font-medium text-foreground">{c.name}</p>
                        <p className="text-[10px] font-mono text-muted-foreground mt-0.5">Campaign ID: {c.id}</p>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
                        {/* Live RINGING badge */}
                        {isRinging && (
                          <div className="flex items-center gap-1 px-2 py-0.5 rounded border border-cyan-500/40 bg-cyan-500/10 text-[9px] font-mono text-cyan-400 animate-pulse">
                            <PhoneIncoming className="w-2.5 h-2.5" />
                            RINGING
                          </div>
                        )}
                        {/* Campaign type badge */}
                        <Badge
                          variant="outline"
                          className={`text-[9px] font-mono uppercase ${
                            c.type === "both"
                              ? "border-purple-500/30 text-purple-400 bg-purple-500/5"
                              : "border-cyan-500/30 text-cyan-400 bg-cyan-500/5"
                          }`}
                        >
                          {c.type === "both" ? "↕ BOTH" : "↙ INBOUND"}
                        </Badge>
                        <Badge variant={c.status === "active" ? "default" : "secondary"} className="text-[9px] font-mono uppercase">
                          {c.status}
                        </Badge>
                        {agentName && (
                          <div className="flex items-center gap-1 px-2 py-0.5 rounded border border-primary/20 bg-primary/5 text-[10px] font-mono text-primary">
                            <Bot className="w-3 h-3" />
                            {agentName}
                          </div>
                        )}
                      </div>
                    </div>

                    {agentName && (
                      <div className="rounded border border-border bg-black/20 px-3 py-2">
                        <p className="text-[9px] font-mono uppercase text-muted-foreground/60 mb-1">AI Greeting Preview</p>
                        <p className="text-[11px] font-mono text-foreground/80 italic">
                          "{buildGreeting(c.name, agentName)}"
                        </p>
                      </div>
                    )}

                    <div className="space-y-2">
                      <p className="text-[10px] font-mono uppercase text-muted-foreground/60">Assigned DIDs</p>
                      {assignedNumbers.length === 0 ? (
                        <p className="text-[10px] font-mono text-muted-foreground/40">
                          No numbers assigned — assign a DID from the Numbers page
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {assignedNumbers.map(n => (
                            <div
                              key={n.id}
                              className={`flex items-center gap-1 px-2 py-1 rounded border text-[10px] font-mono transition-colors ${
                                isRinging
                                  ? "border-cyan-500/40 text-cyan-300/80 bg-cyan-500/5"
                                  : "border-border text-muted-foreground"
                              }`}
                            >
                              <Phone className="w-2.5 h-2.5" />
                              {n.phoneNumber}
                              <span className="text-[8px] uppercase ml-1 text-muted-foreground/50">{n.provider}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {c.transferNumber && (
                      <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground/70">
                        <ArrowRight className="w-3 h-3 text-primary" />
                        After greeting: transfer to{" "}
                        <span className="text-foreground font-medium">{c.transferNumber}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Unassigned numbers ── */}
        <div className="border border-border rounded bg-[hsl(224,71%,3%)]">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
            <Phone className="w-3.5 h-3.5 text-muted-foreground" />
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Unassigned DIDs</p>
          </div>
          <div className="px-4 py-3">
            {(numbers ?? []).filter((n: { campaignId?: number }) => !n.campaignId).length === 0 ? (
              <p className="text-[11px] font-mono text-muted-foreground py-1">All DIDs are assigned to campaigns</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {(numbers ?? [])
                  .filter((n: { campaignId?: number }) => !n.campaignId)
                  .map((n: { id: number; phoneNumber: string; provider: string }) => (
                    <div key={n.id} className="flex items-center gap-1 px-2 py-1 rounded border border-border/50 text-[10px] font-mono text-muted-foreground/50">
                      <Phone className="w-2.5 h-2.5" />
                      {n.phoneNumber}
                      <span className="uppercase text-[8px] ml-1">{n.provider}</span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>

      </div>
    </Layout>
  );
}
