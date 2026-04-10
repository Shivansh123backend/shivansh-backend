import { useListCampaigns, useListCalls, useGetLiveCalls } from "@workspace/api-client-react";
import { Layout, PageHeader } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Layers, CheckCircle, Clock, AlertCircle, Info } from "lucide-react";

export default function QueuesPage() {
  const { data: campaigns, isLoading: campLoading } = useListCampaigns();
  const { data: calls, isLoading: callsLoading } = useListCalls();
  const { data: liveCalls, isLoading: liveLoading } = useGetLiveCalls();

  const isLoading = campLoading || callsLoading || liveLoading;

  const activeCampaigns = (campaigns ?? []).filter((c: { status: string }) => c.status === "active");
  const liveCallsArr = Array.isArray(liveCalls) ? liveCalls : [];
  const pendingCalls = (calls ?? []).filter((c: { status: string }) => c.status === "queued" || c.status === "pending");
  const completedToday = (calls ?? []).filter((c: { status: string }) => c.status === "completed");

  return (
    <Layout>
      <PageHeader title="Queues" subtitle="Call queue status and throughput" />
      <div className="p-6 space-y-4">
        <div className="border border-yellow-500/20 rounded bg-yellow-500/5 px-4 py-3 flex items-start gap-3">
          <Info className="w-4 h-4 text-yellow-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs font-mono text-yellow-400/80 leading-relaxed">
            Redis queue is disabled — set the <span className="font-bold text-yellow-400">REDIS_HOST</span> environment variable to enable BullMQ-powered queuing with retry logic, concurrency control, and priority scheduling.
          </p>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {isLoading ? (
            [...Array(4)].map((_, i) => <Skeleton key={i} className="h-20 rounded" />)
          ) : (
            <>
              <StatCard label="Active Queues" value={activeCampaigns.length} icon={Layers} color="text-primary" />
              <StatCard label="In Progress" value={liveCallsArr.length} icon={Clock} color="text-cyan-400" />
              <StatCard label="Pending" value={pendingCalls.length} icon={AlertCircle} color="text-yellow-400" />
              <StatCard label="Completed" value={completedToday.length} icon={CheckCircle} color="text-green-400" />
            </>
          )}
        </div>

        <div className="border border-border rounded bg-[hsl(224,71%,3%)]">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
            <Layers className="w-3.5 h-3.5 text-primary" />
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Campaign Queues</p>
          </div>
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Campaign</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Type</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Routing</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Concurrency</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Active Calls</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Status</th>
              </tr>
            </thead>
            <tbody>
              {campLoading ? (
                [...Array(4)].map((_, i) => (
                  <tr key={i}>{[...Array(6)].map((_, j) => <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>)}</tr>
                ))
              ) : (campaigns ?? []).map((c: { id: number; name: string; type: string; routingType?: string; maxConcurrentCalls?: number; status: string }) => {
                const activeCalls = liveCallsArr.filter((l: { campaignId?: number }) => l.campaignId === c.id).length;
                const util = c.maxConcurrentCalls ? Math.min(100, Math.round((activeCalls / c.maxConcurrentCalls) * 100)) : 0;
                return (
                  <tr key={c.id} className="border-b border-border/30 hover:bg-white/2 transition-colors">
                    <td className="px-4 py-2.5 text-foreground font-medium">{c.name}</td>
                    <td className="px-4 py-2.5 uppercase text-muted-foreground">{c.type}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{c.routingType?.replace(/_/g, " ") ?? "-"}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{c.maxConcurrentCalls ?? "-"}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-1.5 bg-white/10 rounded overflow-hidden">
                          <div className={`h-full rounded ${util > 75 ? "bg-red-400" : util > 40 ? "bg-yellow-400" : "bg-green-400"}`}
                            style={{ width: `${util}%` }} />
                        </div>
                        <span className="text-muted-foreground">{activeCalls}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant="outline" className={`text-[9px] font-mono uppercase ${
                        c.status === "active" ? "border-green-500/30 text-green-400 bg-green-500/5" :
                        c.status === "paused" ? "border-yellow-500/30 text-yellow-400 bg-yellow-500/5" :
                        "border-border text-muted-foreground"
                      }`}>{c.status}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}

function StatCard({ label, value, icon: Icon, color }: { label: string; value: number; icon: React.ElementType; color: string }) {
  return (
    <div className="border border-border rounded p-4 bg-[hsl(224,71%,3%)]">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{label}</p>
        <Icon className={`w-3.5 h-3.5 ${color}`} />
      </div>
      <p className="text-2xl font-bold font-mono text-foreground">{value}</p>
    </div>
  );
}
