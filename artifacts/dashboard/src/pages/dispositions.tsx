import { useListCalls } from "@workspace/api-client-react";
import { Layout, PageHeader } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "lucide-react";

const DISPOSITIONS = [
  { key: "interested", label: "Interested", color: "border-green-500/30 text-green-400 bg-green-500/5", bar: "bg-green-400" },
  { key: "not_interested", label: "Not Interested", color: "border-red-500/30 text-red-400 bg-red-500/5", bar: "bg-red-400" },
  { key: "connected", label: "Connected", color: "border-blue-500/30 text-blue-400 bg-blue-500/5", bar: "bg-blue-400" },
  { key: "vm", label: "Voicemail", color: "border-yellow-500/30 text-yellow-400 bg-yellow-500/5", bar: "bg-yellow-400" },
  { key: "callback", label: "Callback", color: "border-purple-500/30 text-purple-400 bg-purple-500/5", bar: "bg-purple-400" },
  { key: "no_answer", label: "No Answer", color: "border-border text-muted-foreground", bar: "bg-muted-foreground" },
  { key: "do_not_call", label: "Do Not Call", color: "border-orange-500/30 text-orange-400 bg-orange-500/5", bar: "bg-orange-400" },
];

export default function DispositionsPage() {
  const { data: calls, isLoading } = useListCalls();

  const callsArr = calls ?? [];
  const total = callsArr.filter((c: { disposition?: string }) => c.disposition).length;

  const counts = DISPOSITIONS.map(d => ({
    ...d,
    count: callsArr.filter((c: { disposition?: string }) => c.disposition === d.key).length,
  }));

  const maxCount = Math.max(...counts.map(d => d.count), 1);

  return (
    <Layout>
      <PageHeader title="Dispositions" subtitle="Call outcome breakdown" />
      <div className="p-6 space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {isLoading ? (
            [...Array(4)].map((_, i) => <Skeleton key={i} className="h-20 rounded" />)
          ) : counts.slice(0, 4).map(d => (
            <div key={d.key} className="border border-border rounded p-4 bg-[hsl(224,71%,3%)]">
              <div className="flex items-center justify-between mb-2">
                <Badge variant="outline" className={`text-[9px] font-mono uppercase ${d.color}`}>{d.label}</Badge>
              </div>
              <p className="text-2xl font-bold font-mono text-foreground">{d.count}</p>
              <p className="text-[10px] font-mono text-muted-foreground mt-1">
                {total > 0 ? Math.round((d.count / total) * 100) : 0}% of total
              </p>
            </div>
          ))}
        </div>

        <div className="border border-border rounded bg-[hsl(224,71%,3%)]">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
            <Tag className="w-3.5 h-3.5 text-primary" />
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Disposition Distribution</p>
            <span className="ml-auto text-[10px] font-mono text-muted-foreground">{total} total calls with disposition</span>
          </div>
          <div className="p-4 space-y-3">
            {isLoading ? (
              [...Array(7)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)
            ) : counts.map(d => (
              <div key={d.key} className="flex items-center gap-3">
                <div className="w-28 flex-shrink-0">
                  <Badge variant="outline" className={`text-[9px] font-mono uppercase ${d.color}`}>{d.label}</Badge>
                </div>
                <div className="flex-1 h-5 bg-white/5 rounded overflow-hidden">
                  <div
                    className={`h-full ${d.bar} opacity-70 rounded transition-all`}
                    style={{ width: `${maxCount > 0 ? (d.count / maxCount) * 100 : 0}%` }}
                  />
                </div>
                <span className="w-8 text-right text-xs font-mono font-bold text-foreground">{d.count}</span>
                <span className="w-10 text-right text-[10px] font-mono text-muted-foreground">
                  {total > 0 ? `${Math.round((d.count / total) * 100)}%` : "0%"}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="border border-border rounded bg-[hsl(224,71%,3%)] overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Recent Dispositioned Calls</p>
          </div>
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Call ID</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Lead</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Campaign</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Provider</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Disposition</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Duration</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                [...Array(4)].map((_, i) => (
                  <tr key={i}>{[...Array(6)].map((_, j) => <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>)}</tr>
                ))
              ) : callsArr
                .filter((c: { disposition?: string }) => c.disposition)
                .slice(0, 10)
                .map((c: { id: number; leadId?: number; campaignId?: number; providerUsed?: string; disposition?: string; duration?: number }) => {
                  const disp = counts.find(d => d.key === c.disposition);
                  return (
                    <tr key={c.id} className="border-b border-border/30 hover:bg-white/2 transition-colors">
                      <td className="px-4 py-2.5 text-muted-foreground">#{c.id}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">#{c.leadId ?? "-"}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">#{c.campaignId ?? "-"}</td>
                      <td className="px-4 py-2.5 uppercase text-muted-foreground">{c.providerUsed ?? "-"}</td>
                      <td className="px-4 py-2.5">
                        {disp && <Badge variant="outline" className={`text-[9px] font-mono uppercase ${disp.color}`}>{disp.label}</Badge>}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{c.duration ? `${c.duration}s` : "-"}</td>
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
