import { Layout, PageHeader } from "@/components/layout";
import {
  useGetLiveCalls,
  useListCampaigns,
  useGetAvailableAgents,
  useListCalls,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Phone, Megaphone, Bot, PhoneCall, Activity, Clock } from "lucide-react";

function StatCard({
  label,
  value,
  icon: Icon,
  accent,
  loading,
}: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  accent?: string;
  loading?: boolean;
}) {
  return (
    <div className="border border-border rounded p-4 bg-card">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{label}</p>
        <div className={`w-6 h-6 rounded flex items-center justify-center ${accent ?? "bg-primary/15 text-primary"}`}>
          <Icon className="w-3 h-3" />
        </div>
      </div>
      {loading ? (
        <Skeleton className="h-7 w-16" />
      ) : (
        <p className="text-2xl font-bold font-mono text-foreground">{value}</p>
      )}
    </div>
  );
}

function LiveCallRow({ call }: { call: { id: number; leadId?: number; campaignId?: number; providerUsed?: string; selectedVoice?: string } }) {
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-border/50 last:border-0">
      <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-mono text-foreground truncate">Call #{call.id}</p>
        <p className="text-[10px] text-muted-foreground font-mono">Campaign #{call.campaignId}</p>
      </div>
      <Badge variant="outline" className="text-[9px] font-mono border-green-500/30 text-green-400 bg-green-500/5">
        LIVE
      </Badge>
      {call.providerUsed && (
        <span className="text-[9px] font-mono text-muted-foreground uppercase">{call.providerUsed}</span>
      )}
    </div>
  );
}

export default function DashboardPage() {
  // refetch every 5 s so the "Live Calls" stat clears when calls actually end
  // (without this, react-query caches the result forever and the count drifts).
  const { data: liveCalls, isLoading: liveLoading } = useGetLiveCalls({
    query: { refetchInterval: 5_000, refetchOnWindowFocus: true, staleTime: 0 },
  });
  const { data: campaigns, isLoading: campLoading } = useListCampaigns();
  const { data: availableAgents, isLoading: agentLoading } = useGetAvailableAgents();
  const { data: calls, isLoading: callsLoading } = useListCalls();

  const activeCampaigns = (campaigns ?? []).filter((c: { status: string }) => c.status === "active").length;
  const liveCallsArr = Array.isArray(liveCalls) ? liveCalls : [];
  const recentCalls = (calls ?? []).slice(0, 8);

  const completedCalls = (calls ?? []).filter((c: { status: string }) => c.status === "completed").length;
  const interestedCalls = (calls ?? []).filter((c: { disposition?: string }) => c.disposition === "interested").length;

  return (
    <Layout>
      <PageHeader title="Operations Overview" subtitle="Real-time system status" />
      <div className="p-6 space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="Live Calls" value={liveCallsArr.length} icon={Phone} loading={liveLoading} accent="bg-green-500/15 text-green-400" />
          <StatCard label="Active Campaigns" value={activeCampaigns} icon={Megaphone} loading={campLoading} />
          <StatCard label="Available Agents" value={Array.isArray(availableAgents) ? availableAgents.length : 0} icon={Bot} loading={agentLoading} />
          <StatCard label="Calls Today" value={completedCalls} icon={PhoneCall} loading={callsLoading} accent="bg-purple-500/15 text-purple-400" />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="border border-border rounded bg-card">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
              <Activity className="w-3.5 h-3.5 text-green-400" />
              <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Live Calls</p>
              {liveCallsArr.length > 0 && (
                <div className="ml-auto w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              )}
            </div>
            <div className="px-4 py-2">
              {liveLoading ? (
                <div className="space-y-2 py-2">
                  {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
                </div>
              ) : liveCallsArr.length === 0 ? (
                <p className="text-xs text-muted-foreground font-mono py-6 text-center">No active calls</p>
              ) : (
                liveCallsArr.map((call: { id: number }) => <LiveCallRow key={call.id} call={call} />)
              )}
            </div>
          </div>

          <div className="border border-border rounded bg-card">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
              <Megaphone className="w-3.5 h-3.5 text-primary" />
              <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Campaign Status</p>
            </div>
            <div className="px-4 py-2">
              {campLoading ? (
                <div className="space-y-2 py-2">
                  {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
                </div>
              ) : (campaigns ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground font-mono py-6 text-center">No campaigns</p>
              ) : (
                (campaigns ?? []).slice(0, 6).map((c: { id: number; name: string; status: string; type: string; maxConcurrentCalls?: number }) => (
                  <div key={c.id} className="flex items-center gap-3 py-2.5 border-b border-border/50 last:border-0">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-mono text-foreground truncate">{c.name}</p>
                      <p className="text-[10px] text-muted-foreground font-mono uppercase">{c.type}</p>
                    </div>
                    <StatusBadge status={c.status} />
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="border border-border rounded bg-card">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
            <Clock className="w-3.5 h-3.5 text-primary" />
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Recent Call Records</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-2 text-[10px] text-muted-foreground uppercase tracking-wider">ID</th>
                  <th className="text-left px-4 py-2 text-[10px] text-muted-foreground uppercase tracking-wider">Campaign</th>
                  <th className="text-left px-4 py-2 text-[10px] text-muted-foreground uppercase tracking-wider">Provider</th>
                  <th className="text-left px-4 py-2 text-[10px] text-muted-foreground uppercase tracking-wider">Status</th>
                  <th className="text-left px-4 py-2 text-[10px] text-muted-foreground uppercase tracking-wider">Disposition</th>
                  <th className="text-left px-4 py-2 text-[10px] text-muted-foreground uppercase tracking-wider">Duration</th>
                </tr>
              </thead>
              <tbody>
                {callsLoading ? (
                  [...Array(5)].map((_, i) => (
                    <tr key={i}>
                      {[...Array(6)].map((_, j) => (
                        <td key={j} className="px-4 py-2"><Skeleton className="h-4 w-full" /></td>
                      ))}
                    </tr>
                  ))
                ) : recentCalls.map((c: {
                  id: number;
                  campaignId?: number;
                  providerUsed?: string;
                  status: string;
                  disposition?: string;
                  duration?: number;
                }) => (
                  <tr key={c.id} className="border-b border-border/30 hover:bg-white/2 transition-colors">
                    <td className="px-4 py-2 text-muted-foreground">#{c.id}</td>
                    <td className="px-4 py-2">#{c.campaignId ?? "-"}</td>
                    <td className="px-4 py-2 uppercase text-muted-foreground">{c.providerUsed ?? "-"}</td>
                    <td className="px-4 py-2"><StatusBadge status={c.status} /></td>
                    <td className="px-4 py-2">{c.disposition ? <DispositionBadge disp={c.disposition} /> : <span className="text-muted-foreground">-</span>}</td>
                    <td className="px-4 py-2 text-muted-foreground">{c.duration ? `${c.duration}s` : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Layout>
  );
}

// Soft pastel pill badges — match the reference UI: rounded, low-saturation
// background, mid-tone text, no harsh borders. Designed for white-theme.
const PASTEL = {
  green:  "bg-emerald-100 text-emerald-700 border-emerald-200",
  blue:   "bg-sky-100 text-sky-700 border-sky-200",
  yellow: "bg-amber-100 text-amber-700 border-amber-200",
  red:    "bg-rose-100 text-rose-700 border-rose-200",
  purple: "bg-violet-100 text-violet-700 border-violet-200",
  cyan:   "bg-cyan-100 text-cyan-700 border-cyan-200",
  peach:  "bg-orange-100 text-orange-700 border-orange-200",
  gray:   "bg-slate-100 text-slate-600 border-slate-200",
} as const;

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active:      PASTEL.green,
    completed:   PASTEL.blue,
    paused:      PASTEL.yellow,
    draft:       PASTEL.gray,
    in_progress: `${PASTEL.cyan} animate-pulse`,
    available:   PASTEL.green,
    busy:        PASTEL.red,
    break:       PASTEL.yellow,
    offline:     PASTEL.gray,
    inactive:    PASTEL.gray,
  };
  return (
    <Badge variant="outline" className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium normal-case border ${map[status] ?? PASTEL.gray}`}>
      {status.replace("_", " ")}
    </Badge>
  );
}

export function DispositionBadge({ disp }: { disp: string }) {
  const key = disp.toLowerCase();
  const map: Record<string, string> = {
    interested:     PASTEL.green,
    not_interested: PASTEL.red,
    connected:      PASTEL.green,
    transferred:    PASTEL.green,
    vm:             PASTEL.yellow,
    voicemail:      PASTEL.yellow,
    no_answer:      PASTEL.peach,
    "no answer":    PASTEL.peach,
    busy:           PASTEL.peach,
    callback:       PASTEL.purple,
    failed:         PASTEL.gray,
  };
  // Match by prefix too — e.g. "failed:timeout", "failed:normal clearing"
  const cls =
    map[key] ??
    (key.startsWith("failed") ? PASTEL.gray :
     key.startsWith("connect") ? PASTEL.green :
     PASTEL.gray);
  return (
    <Badge variant="outline" className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium normal-case border ${cls}`}>
      {disp.replace("_", " ")}
    </Badge>
  );
}
