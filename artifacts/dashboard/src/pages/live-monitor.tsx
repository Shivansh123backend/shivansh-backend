import { useGetLiveCalls, useListCampaigns, useGetAvailableAgents, useListCalls } from "@workspace/api-client-react";
import { Layout, PageHeader } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, Phone, Bot, Megaphone, Mic } from "lucide-react";

function LiveCallCard({ call }: {
  call: {
    id: number;
    leadId?: number;
    campaignId?: number;
    agentId?: number;
    providerUsed?: string;
    selectedVoice?: string;
    selectedNumber?: string;
    status: string;
  }
}) {
  return (
    <div className="border border-border rounded bg-[hsl(224,71%,3%)] p-4 space-y-3 relative overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r from-green-400/50 via-green-400 to-green-400/50 animate-pulse" />
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-mono font-semibold text-foreground">Call #{call.id}</p>
            <p className="text-[10px] font-mono text-muted-foreground">Lead #{call.leadId ?? "-"}</p>
          </div>
        </div>
        <Badge variant="outline" className="text-[9px] font-mono border-green-500/30 text-green-400 bg-green-500/5 uppercase">
          Live
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Megaphone className="w-3 h-3 flex-shrink-0" />
          <span>Campaign #{call.campaignId ?? "-"}</span>
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Bot className="w-3 h-3 flex-shrink-0" />
          <span>Agent #{call.agentId ?? "-"}</span>
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Phone className="w-3 h-3 flex-shrink-0" />
          <span className="uppercase">{call.providerUsed ?? "-"}</span>
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Mic className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">{call.selectedNumber ?? "-"}</span>
        </div>
      </div>
    </div>
  );
}

export default function LiveMonitorPage() {
  const { data: liveCalls, isLoading: liveLoading } = useGetLiveCalls();
  const { data: campaigns, isLoading: campLoading } = useListCampaigns();
  const { data: availableAgents, isLoading: agentLoading } = useGetAvailableAgents();
  const { data: calls } = useListCalls();

  const liveCallsArr = Array.isArray(liveCalls) ? liveCalls : [];
  const activeCampaigns = (campaigns ?? []).filter((c: { status: string }) => c.status === "active");
  const recentCompleted = (calls ?? []).filter((c: { status: string }) => c.status === "completed").slice(0, 5);

  return (
    <Layout>
      <PageHeader
        title="Live Monitor"
        subtitle="Real-time call activity"
        action={
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-green-400">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            Live feed active
          </div>
        }
      />
      <div className="p-6 space-y-6">
        <div className="grid grid-cols-3 gap-3">
          <div className="border border-border rounded p-4 bg-[hsl(224,71%,3%)]">
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2">Live Calls</p>
            {liveLoading ? <Skeleton className="h-7 w-12" /> : (
              <p className="text-2xl font-bold font-mono text-green-400">{liveCallsArr.length}</p>
            )}
          </div>
          <div className="border border-border rounded p-4 bg-[hsl(224,71%,3%)]">
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2">Active Campaigns</p>
            {campLoading ? <Skeleton className="h-7 w-12" /> : (
              <p className="text-2xl font-bold font-mono text-primary">{activeCampaigns.length}</p>
            )}
          </div>
          <div className="border border-border rounded p-4 bg-[hsl(224,71%,3%)]">
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2">Available Agents</p>
            {agentLoading ? <Skeleton className="h-7 w-12" /> : (
              <p className="text-2xl font-bold font-mono text-foreground">{Array.isArray(availableAgents) ? availableAgents.length : 0}</p>
            )}
          </div>
        </div>

        <div>
          <div className="flex items-center gap-2 mb-3">
            <Activity className="w-3.5 h-3.5 text-green-400" />
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Active Calls</p>
          </div>
          {liveLoading ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
              {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-32 rounded" />)}
            </div>
          ) : liveCallsArr.length === 0 ? (
            <div className="border border-border rounded p-12 bg-[hsl(224,71%,3%)] flex flex-col items-center justify-center gap-3">
              <div className="w-10 h-10 rounded-full bg-white/5 border border-border flex items-center justify-center">
                <Activity className="w-5 h-5 text-muted-foreground" />
              </div>
              <p className="text-xs font-mono text-muted-foreground">No active calls at this moment</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
              {liveCallsArr.map((c: { id: number }) => <LiveCallCard key={c.id} call={c} />)}
            </div>
          )}
        </div>

        <div className="border border-border rounded bg-[hsl(224,71%,3%)]">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
            <Phone className="w-3.5 h-3.5 text-primary" />
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Recently Completed</p>
          </div>
          <div className="divide-y divide-border/50">
            {recentCompleted.length === 0 ? (
              <p className="text-xs font-mono text-muted-foreground px-4 py-6 text-center">No completed calls</p>
            ) : recentCompleted.map((c: {
              id: number;
              leadId?: number;
              campaignId?: number;
              providerUsed?: string;
              disposition?: string;
              duration?: number;
            }) => (
              <div key={c.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="text-[10px] font-mono text-muted-foreground w-12">#{c.id}</span>
                <span className="text-xs font-mono text-foreground flex-1">Lead #{c.leadId ?? "-"} · Campaign #{c.campaignId ?? "-"}</span>
                {c.disposition && (
                  <Badge variant="outline" className="text-[9px] font-mono uppercase border-blue-500/30 text-blue-400 bg-blue-500/5">
                    {c.disposition.replace(/_/g, " ")}
                  </Badge>
                )}
                <span className="text-[10px] font-mono text-muted-foreground">{c.duration ? `${c.duration}s` : "-"}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Layout>
  );
}
