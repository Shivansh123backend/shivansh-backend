import { useState, Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useListCalls,
  useListCampaigns,
  customFetch,
} from "@workspace/api-client-react";
import { Layout, PageHeader } from "@/components/layout";
import { StatusBadge, DispositionBadge } from "./dashboard";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Filter, ChevronDown, Phone, FileText } from "lucide-react";

function formatDuration(seconds?: number | null) {
  if (!seconds) return "-";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatTimestamp(ts?: string | null) {
  if (!ts) return "-";
  return new Date(ts).toLocaleString();
}

type Tab = "cdr" | "call-logs";

interface CallLog {
  id: number;
  phoneNumber: string;
  campaignId: number;
  status: string;
  disposition?: string | null;
  timestamp: string;
}

function StatusPill({ status }: { status: string }) {
  const colors: Record<string, string> = {
    initiated: "text-yellow-400 border-yellow-400/40 bg-yellow-400/10",
    completed: "text-green-400 border-green-400/40 bg-green-400/10",
    failed: "text-red-400 border-red-400/40 bg-red-400/10",
    "no_answer": "text-muted-foreground border-border bg-muted/20",
  };
  const cls = colors[status] ?? "text-muted-foreground border-border bg-muted/20";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-mono uppercase tracking-wider ${cls}`}>
      {status}
    </span>
  );
}

export default function CallsPage() {
  const [activeTab, setActiveTab] = useState<Tab>("cdr");
  const [filterCampaign, setFilterCampaign] = useState("__all__");
  const [logFilterCampaign, setLogFilterCampaign] = useState("__all__");

  const { data: calls, isLoading: callsLoading } = useListCalls({
    campaignId: filterCampaign !== "__all__" ? parseInt(filterCampaign) : undefined,
  });
  const { data: campaigns } = useListCampaigns();
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const callLogsQuery = useQuery<CallLog[]>({
    queryKey: ["call-logs", logFilterCampaign],
    queryFn: async () => {
      const params = logFilterCampaign !== "__all__"
        ? `?campaignId=${logFilterCampaign}`
        : "";
      const res = await customFetch(`/api/call-logs${params}`);
      if (!res.ok) throw new Error("Failed to fetch call logs");
      return res.json();
    },
    enabled: activeTab === "call-logs",
    refetchInterval: activeTab === "call-logs" ? 10000 : false,
  });

  const campaignMap = Object.fromEntries(
    (campaigns ?? []).map((c: { id: number; name: string }) => [c.id, c.name]),
  );

  return (
    <Layout>
      <PageHeader
        title="Call Records"
        subtitle={activeTab === "cdr" ? `${(calls ?? []).length} full CDR entries` : `${(callLogsQuery.data ?? []).length} campaign log entries`}
      />

      {/* Tab strip */}
      <div className="px-6 py-0 border-b border-border flex items-center gap-0">
        {([
          { id: "cdr", label: "Full CDR", Icon: FileText },
          { id: "call-logs", label: "Campaign Logs", Icon: Phone },
        ] as { id: Tab; label: string; Icon: React.ElementType }[]).map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-2 px-4 py-3 text-xs font-mono border-b-2 transition-colors ${
              activeTab === id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {activeTab === "cdr" && (
        <>
          <div className="px-6 py-3 border-b border-border flex items-center gap-3">
            <Filter className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            <Select value={filterCampaign} onValueChange={setFilterCampaign}>
              <SelectTrigger className="font-mono text-xs h-7 w-48">
                <SelectValue placeholder="All campaigns" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All campaigns</SelectItem>
                {(campaigns ?? []).map((c: { id: number; name: string }) => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="p-6">
            <div className="border border-border rounded bg-[hsl(224,71%,3%)] overflow-hidden">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider w-8"></th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">ID</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Campaign</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Lead</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Provider</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Status</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Disposition</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {callsLoading ? (
                    [...Array(6)].map((_, i) => (
                      <tr key={i}>
                        {[...Array(8)].map((_, j) => (
                          <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>
                        ))}
                      </tr>
                    ))
                  ) : (calls ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">No call records found</td>
                    </tr>
                  ) : (calls ?? []).map((c: {
                    id: number;
                    campaignId?: number;
                    leadId?: number;
                    providerUsed?: string;
                    status: string;
                    disposition?: string;
                    duration?: number;
                    transcript?: string;
                    summary?: string;
                  }) => (
                    <Fragment key={c.id}>
                      <tr
                        className="border-b border-border/30 hover:bg-white/2 transition-colors cursor-pointer"
                        onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}
                      >
                        <td className="px-4 py-3 text-muted-foreground">
                          <ChevronDown className={`w-3 h-3 transition-transform ${expandedId === c.id ? "rotate-180" : ""}`} />
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">#{c.id}</td>
                        <td className="px-4 py-3">{c.campaignId ? campaignMap[c.campaignId] ?? `#${c.campaignId}` : "-"}</td>
                        <td className="px-4 py-3 text-muted-foreground">#{c.leadId ?? "-"}</td>
                        <td className="px-4 py-3 uppercase text-muted-foreground">{c.providerUsed ?? "-"}</td>
                        <td className="px-4 py-3"><StatusBadge status={c.status} /></td>
                        <td className="px-4 py-3">{c.disposition ? <DispositionBadge disp={c.disposition} /> : <span className="text-muted-foreground">-</span>}</td>
                        <td className="px-4 py-3 text-muted-foreground">{formatDuration(c.duration)}</td>
                      </tr>
                      {expandedId === c.id && (
                        <tr key={`${c.id}-expanded`} className="border-b border-border/30 bg-white/2">
                          <td colSpan={8} className="px-6 py-4 space-y-3">
                            {c.summary && (
                              <div>
                                <p className="text-[10px] font-mono uppercase text-muted-foreground mb-1">Summary</p>
                                <p className="text-xs font-mono text-foreground/80">{c.summary}</p>
                              </div>
                            )}
                            {c.transcript && (
                              <div>
                                <p className="text-[10px] font-mono uppercase text-muted-foreground mb-1">Transcript</p>
                                <p className="text-xs font-mono text-muted-foreground leading-relaxed max-h-32 overflow-y-auto">{c.transcript}</p>
                              </div>
                            )}
                            {!c.summary && !c.transcript && (
                              <p className="text-xs font-mono text-muted-foreground">No transcript or summary available</p>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {activeTab === "call-logs" && (
        <>
          <div className="px-6 py-3 border-b border-border flex items-center gap-3">
            <Filter className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            <Select value={logFilterCampaign} onValueChange={setLogFilterCampaign}>
              <SelectTrigger className="font-mono text-xs h-7 w-48">
                <SelectValue placeholder="All campaigns" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All campaigns</SelectItem>
                {(campaigns ?? []).map((c: { id: number; name: string }) => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {callLogsQuery.isFetching && (
              <span className="text-[10px] font-mono text-muted-foreground animate-pulse">refreshing...</span>
            )}
          </div>
          <div className="p-6">
            <div className="border border-border rounded bg-[hsl(224,71%,3%)] overflow-hidden">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">ID</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Phone</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Campaign</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Status</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Disposition</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Timestamp</th>
                  </tr>
                </thead>
                <tbody>
                  {callLogsQuery.isLoading ? (
                    [...Array(6)].map((_, i) => (
                      <tr key={i}>
                        {[...Array(6)].map((_, j) => (
                          <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>
                        ))}
                      </tr>
                    ))
                  ) : (callLogsQuery.data ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                        No campaign call logs yet. Launch a campaign to start recording calls.
                      </td>
                    </tr>
                  ) : (callLogsQuery.data ?? []).map((log) => (
                    <tr key={log.id} className="border-b border-border/30 hover:bg-white/2 transition-colors">
                      <td className="px-4 py-3 text-muted-foreground">#{log.id}</td>
                      <td className="px-4 py-3 text-green-400">{log.phoneNumber}</td>
                      <td className="px-4 py-3">{campaignMap[log.campaignId] ?? `#${log.campaignId}`}</td>
                      <td className="px-4 py-3"><StatusPill status={log.status} /></td>
                      <td className="px-4 py-3">{log.disposition ? <DispositionBadge disp={log.disposition} /> : <span className="text-muted-foreground">-</span>}</td>
                      <td className="px-4 py-3 text-muted-foreground">{formatTimestamp(log.timestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </Layout>
  );
}
