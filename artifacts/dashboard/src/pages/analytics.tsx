import { useListCalls, useListCampaigns, useListLeads, useListAgents } from "@workspace/api-client-react";
import { Layout, PageHeader } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart2, TrendingUp, Phone, Target } from "lucide-react";

const DISPOSITIONS = [
  { key: "interested", label: "Interested", color: "bg-green-400" },
  { key: "not_interested", label: "Not Interested", color: "bg-red-400" },
  { key: "connected", label: "Connected", color: "bg-blue-400" },
  { key: "vm", label: "Voicemail", color: "bg-yellow-400" },
  { key: "callback", label: "Callback", color: "bg-purple-400" },
  { key: "no_answer", label: "No Answer", color: "bg-gray-400" },
];

function MiniBarChart({ data }: { data: { label: string; value: number; color: string }[] }) {
  const max = Math.max(...data.map(d => d.value), 1);
  return (
    <div className="space-y-2.5">
      {data.map(d => (
        <div key={d.label} className="flex items-center gap-3 text-[11px] font-mono">
          <div className="w-24 text-muted-foreground truncate">{d.label}</div>
          <div className="flex-1 h-4 bg-white/5 rounded overflow-hidden">
            <div
              className={`h-full ${d.color} opacity-70 rounded transition-all flex items-center justify-end pr-1.5`}
              style={{ width: `${(d.value / max) * 100}%` }}
            >
              {d.value > 0 && <span className="text-[9px] text-white font-bold">{d.value}</span>}
            </div>
          </div>
          <span className="w-6 text-right text-muted-foreground">{d.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function AnalyticsPage() {
  const { data: calls, isLoading: callsLoading } = useListCalls();
  const { data: campaigns, isLoading: campLoading } = useListCampaigns();
  const { data: leads, isLoading: leadsLoading } = useListLeads();
  const { data: agents, isLoading: agentsLoading } = useListAgents();

  const isLoading = callsLoading || campLoading || leadsLoading || agentsLoading;

  const callsArr = calls ?? [];
  const totalCalls = callsArr.length;
  const completedCalls = callsArr.filter((c: { status: string }) => c.status === "completed").length;
  const inProgressCalls = callsArr.filter((c: { status: string }) => c.status === "in_progress").length;

  const avgDuration = (() => {
    const withDuration = callsArr.filter((c: { duration?: number }) => c.duration);
    if (withDuration.length === 0) return 0;
    return Math.round(withDuration.reduce((sum: number, c: { duration?: number }) => sum + (c.duration ?? 0), 0) / withDuration.length);
  })();

  const dispositionData = DISPOSITIONS.map(d => ({
    ...d,
    value: callsArr.filter((c: { disposition?: string }) => c.disposition === d.key).length,
  }));

  const campaignPerf = (campaigns ?? []).map((c: { id: number; name: string; status: string }) => {
    const campCalls = callsArr.filter((call: { campaignId?: number }) => call.campaignId === c.id);
    const interestedCount = campCalls.filter((call: { disposition?: string }) => call.disposition === "interested").length;
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      total: campCalls.length,
      interested: interestedCount,
      rate: campCalls.length > 0 ? Math.round((interestedCount / campCalls.length) * 100) : 0,
    };
  });

  const providerData = ["voip", "telnyx", "twilio"].map(p => ({
    label: p.toUpperCase(),
    value: callsArr.filter((c: { providerUsed?: string }) => c.providerUsed === p).length,
    color: p === "voip" ? "bg-blue-400" : p === "telnyx" ? "bg-purple-400" : "bg-red-400",
  }));

  return (
    <Layout>
      <PageHeader title="Analytics" subtitle="Platform performance metrics" />
      <div className="p-6 space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {isLoading ? (
            [...Array(4)].map((_, i) => <Skeleton key={i} className="h-20 rounded" />)
          ) : (
            <>
              <StatCard label="Total Calls" value={totalCalls} sub="all time" icon={Phone} />
              <StatCard label="Completed" value={completedCalls} sub={`${totalCalls > 0 ? Math.round((completedCalls / totalCalls) * 100) : 0}% completion`} icon={Target} />
              <StatCard label="Avg Duration" value={`${avgDuration}s`} sub="per completed call" icon={TrendingUp} />
              <StatCard label="Total Leads" value={(leads ?? []).length} sub={`across ${(campaigns ?? []).length} campaigns`} icon={BarChart2} />
            </>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="border border-border rounded bg-[hsl(224,71%,3%)] p-4">
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-4">Disposition Breakdown</p>
            {callsLoading ? <Skeleton className="h-40 w-full" /> : <MiniBarChart data={dispositionData} />}
          </div>

          <div className="border border-border rounded bg-[hsl(224,71%,3%)] p-4">
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-4">Calls by Provider</p>
            {callsLoading ? <Skeleton className="h-40 w-full" /> : <MiniBarChart data={providerData} />}
          </div>
        </div>

        <div className="border border-border rounded bg-[hsl(224,71%,3%)]">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
            <BarChart2 className="w-3.5 h-3.5 text-primary" />
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Campaign Performance</p>
          </div>
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Campaign</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Status</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Total Calls</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Interested</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Interest Rate</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Progress</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                [...Array(4)].map((_, i) => (
                  <tr key={i}>{[...Array(6)].map((_, j) => <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>)}</tr>
                ))
              ) : campaignPerf.map((c: { id: number; name: string; status: string; total: number; interested: number; rate: number }) => (
                <tr key={c.id} className="border-b border-border/30 hover:bg-white/2 transition-colors">
                  <td className="px-4 py-2.5 text-foreground font-medium">{c.name}</td>
                  <td className="px-4 py-2.5">
                    <Badge variant="outline" className={`text-[9px] font-mono uppercase ${
                      c.status === "active" ? "border-green-500/30 text-green-400 bg-green-500/5" :
                      c.status === "paused" ? "border-yellow-500/30 text-yellow-400 bg-yellow-500/5" :
                      "border-border text-muted-foreground"
                    }`}>{c.status}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{c.total}</td>
                  <td className="px-4 py-2.5 text-green-400">{c.interested}</td>
                  <td className="px-4 py-2.5 text-foreground font-bold">{c.rate}%</td>
                  <td className="px-4 py-2.5">
                    <div className="w-24 h-1.5 bg-white/10 rounded overflow-hidden">
                      <div className="h-full bg-primary rounded" style={{ width: `${c.rate}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}

function StatCard({ label, value, sub, icon: Icon }: { label: string; value: string | number; sub: string; icon: React.ElementType }) {
  return (
    <div className="border border-border rounded p-4 bg-[hsl(224,71%,3%)]">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{label}</p>
        <Icon className="w-3.5 h-3.5 text-primary" />
      </div>
      <p className="text-2xl font-bold font-mono text-foreground">{value}</p>
      <p className="text-[10px] font-mono text-muted-foreground mt-1">{sub}</p>
    </div>
  );
}
