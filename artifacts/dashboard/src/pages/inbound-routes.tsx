import { useState } from "react";
import { useListCampaigns, useListNumbers, useListAgents } from "@workspace/api-client-react";
import { Layout, PageHeader } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { GitBranch, Phone, Bot, ArrowRight, Plus } from "lucide-react";

export default function InboundRoutesPage() {
  const { data: campaigns, isLoading: campLoading } = useListCampaigns();
  const { data: numbers, isLoading: numLoading } = useListNumbers();
  const { data: agents, isLoading: agentLoading } = useListAgents();
  const [showInfo, setShowInfo] = useState(false);

  const isLoading = campLoading || numLoading || agentLoading;

  const inboundCampaigns = (campaigns ?? []).filter((c: { type: string }) => c.type === "inbound");
  const agentMap = Object.fromEntries((agents ?? []).map((a: { id: number; name: string }) => [a.id, a.name]));

  const numbersByCampaign = (numbers ?? []).reduce((acc: Record<number, { id: number; phoneNumber: string; provider: string }[]>, n: { id: number; phoneNumber: string; provider: string; campaignId?: number }) => {
    if (n.campaignId) {
      acc[n.campaignId] = acc[n.campaignId] ?? [];
      acc[n.campaignId].push(n);
    }
    return acc;
  }, {});

  return (
    <Layout>
      <PageHeader
        title="Inbound Routes"
        subtitle={`${inboundCampaigns.length} inbound routes configured`}
        action={
          <Button size="sm" className="font-mono text-xs uppercase tracking-wider h-7 px-3" onClick={() => setShowInfo(true)}>
            <Plus className="w-3 h-3 mr-1.5" /> Add Route
          </Button>
        }
      />
      <div className="p-6 space-y-4">
        {showInfo && (
          <div className="border border-primary/20 rounded bg-primary/5 px-4 py-3 flex items-start gap-3">
            <GitBranch className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
            <p className="text-xs font-mono text-primary/80 leading-relaxed">
              To create an inbound route, create a Campaign with type <span className="font-bold text-primary">Inbound</span> and assign phone numbers to it. The AI agent will handle incoming calls on those DIDs.
              <button onClick={() => setShowInfo(false)} className="ml-2 text-primary/60 hover:text-primary underline">Dismiss</button>
            </p>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-32 rounded" />)}
          </div>
        ) : inboundCampaigns.length === 0 ? (
          <div className="border border-border rounded p-16 bg-[hsl(224,71%,3%)] flex flex-col items-center justify-center gap-4">
            <div className="w-12 h-12 rounded-full bg-white/5 border border-border flex items-center justify-center">
              <GitBranch className="w-6 h-6 text-muted-foreground" />
            </div>
            <div className="text-center">
              <p className="text-xs font-mono text-foreground mb-1">No inbound routes configured</p>
              <p className="text-[10px] font-mono text-muted-foreground">Create a campaign with type "Inbound" to define routing rules</p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {inboundCampaigns.map((c: {
              id: number;
              name: string;
              status: string;
              routingType?: string;
              agentId?: number;
              maxConcurrentCalls?: number;
            }) => {
              const assignedNumbers = numbersByCampaign[c.id] ?? [];
              return (
                <div key={c.id} className="border border-border rounded bg-[hsl(224,71%,3%)] p-4">
                  <div className="flex items-start justify-between gap-4 mb-4">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-sm font-mono font-semibold text-foreground">{c.name}</p>
                        <Badge variant="outline" className={`text-[9px] font-mono uppercase ${
                          c.status === "active" ? "border-green-500/30 text-green-400 bg-green-500/5" : "border-border text-muted-foreground"
                        }`}>{c.status}</Badge>
                      </div>
                      <p className="text-[10px] font-mono text-muted-foreground">
                        Routing: {c.routingType?.replace(/_/g, " ") ?? "-"} · Max {c.maxConcurrentCalls ?? "-"} concurrent
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 flex-wrap">
                    <div className="flex flex-col gap-1.5">
                      <p className="text-[10px] font-mono uppercase text-muted-foreground">Incoming DIDs</p>
                      {assignedNumbers.length === 0 ? (
                        <p className="text-[10px] font-mono text-muted-foreground/60">No numbers assigned</p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {assignedNumbers.map(n => (
                            <div key={n.id} className="flex items-center gap-1 px-2 py-1 rounded border border-border text-[10px] font-mono text-muted-foreground">
                              <Phone className="w-2.5 h-2.5" />
                              {n.phoneNumber}
                              <span className="uppercase text-[8px] text-primary/60 ml-1">{n.provider}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <ArrowRight className="w-4 h-4 text-muted-foreground/40 flex-shrink-0" />

                    <div className="flex flex-col gap-1.5">
                      <p className="text-[10px] font-mono uppercase text-muted-foreground">Handles With</p>
                      <div className="flex items-center gap-1.5 px-2 py-1 rounded border border-primary/20 bg-primary/5 text-[10px] font-mono text-primary">
                        <Bot className="w-3 h-3" />
                        {c.agentId ? agentMap[c.agentId] ?? `Agent #${c.agentId}` : "No agent assigned"}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="border border-border rounded bg-[hsl(224,71%,3%)]">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
            <Phone className="w-3.5 h-3.5 text-primary" />
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Unassigned Inbound Numbers</p>
          </div>
          <div className="px-4 py-3">
            {(numbers ?? []).filter((n: { status: string; campaignId?: number }) => !n.campaignId).length === 0 ? (
              <p className="text-xs font-mono text-muted-foreground py-2">All DIDs are assigned to routes</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {(numbers ?? [])
                  .filter((n: { campaignId?: number }) => !n.campaignId)
                  .map((n: { id: number; phoneNumber: string; provider: string; status: string }) => (
                    <div key={n.id} className="flex items-center gap-1 px-2 py-1 rounded border border-border text-[10px] font-mono text-muted-foreground/60">
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
