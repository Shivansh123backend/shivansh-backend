import { useState, Fragment, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useListCampaigns,
  customFetch,
} from "@workspace/api-client-react";
import { io, type Socket } from "socket.io-client";
import { Layout, PageHeader } from "@/components/layout";
import { StatusBadge, DispositionBadge } from "./dashboard";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Filter, ChevronDown, Phone, FileText, Download, Tag, Play, ExternalLink, RefreshCw, PhoneIncoming, PhoneOutgoing, Trash2 } from "lucide-react";

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

function formatDialedAt(ts?: string | null) {
  if (!ts) return { date: "-", time: "" };
  const d = new Date(ts);
  return {
    date: d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" }),
    time: d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  };
}

type Tab = "cdr" | "call-logs";

const DISPOSITION_OPTIONS = [
  { value: "interested", label: "Interested" },
  { value: "not_interested", label: "Not Interested" },
  { value: "connected", label: "Connected" },
  { value: "vm", label: "Voicemail" },
  { value: "no_answer", label: "No Answer" },
  { value: "busy", label: "Busy" },
  { value: "callback_requested", label: "Callback Requested" },
  { value: "transferred", label: "Transferred" },
  { value: "completed", label: "Completed" },
];

interface CdrRow {
  id: string;
  source: "calls" | "call_logs";
  direction: "inbound" | "outbound";
  phoneNumber: string | null;
  campaignId: number | null;
  leadId: number | null;
  providerUsed: string | null;
  status: string;
  disposition: string | null;
  duration: number | null;
  recordingUrl: string | null;
  transcript: string | null;
  summary: string | null;
  timestamp: string;
}

interface CallLog {
  id: number;
  phoneNumber: string;
  campaignId: number;
  status: string;
  disposition?: string | null;
  direction?: string | null;
  duration?: number | null;
  transcript?: string | null;
  summary?: string | null;
  recordingUrl?: string | null;
  timestamp: string;
}

function StatusPill({ status }: { status: string }) {
  const colors: Record<string, string> = {
    initiated: "text-yellow-400 border-yellow-400/40 bg-yellow-400/10",
    completed: "text-green-400 border-green-400/40 bg-green-400/10",
    failed: "text-red-400 border-red-400/40 bg-red-400/10",
    no_answer: "text-muted-foreground border-border bg-muted/20",
  };
  const cls = colors[status] ?? "text-muted-foreground border-border bg-muted/20";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-mono uppercase tracking-wider ${cls}`}>
      {status}
    </span>
  );
}

// ── Export button ─────────────────────────────────────────────────────────────
function ExportButtons({ endpoint, id }: { endpoint: "calls" | "call-logs"; id: number }) {
  const [loading, setLoading] = useState<"txt" | "pdf" | null>(null);
  const { toast } = useToast();

  const handleExport = async (format: "txt" | "pdf") => {
    setLoading(format);
    try {
      const token = localStorage.getItem("auth_token");
      const res = await fetch(`/api/${endpoint}/${id}/export?format=${format}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`Export failed: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${endpoint === "calls" ? "call" : "call-log"}-${id}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Export failed", description: "Could not download report", variant: "destructive" });
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={() => handleExport("txt")}
        disabled={loading !== null}
        className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors disabled:opacity-50"
      >
        {loading === "txt" ? <RefreshCw className="w-2.5 h-2.5 animate-spin" /> : <Download className="w-2.5 h-2.5" />}
        TXT
      </button>
      <button
        onClick={() => handleExport("pdf")}
        disabled={loading !== null}
        className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors disabled:opacity-50"
      >
        {loading === "pdf" ? <RefreshCw className="w-2.5 h-2.5 animate-spin" /> : <Download className="w-2.5 h-2.5" />}
        PDF
      </button>
    </div>
  );
}

// ── Inline disposition updater ────────────────────────────────────────────────
function DispositionUpdater({
  id,
  current,
  endpoint,
  onUpdate,
}: {
  id: number;
  current?: string | null;
  endpoint: "calls" | "call-logs";
  onUpdate: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const handleChange = async (value: string) => {
    setSaving(true);
    try {
      const token = localStorage.getItem("auth_token");
      const url = endpoint === "calls"
        ? `/api/calls/${id}/disposition`
        : `/api/call-logs/${id}/disposition`;
      const res = await fetch(url, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ disposition: value }),
      });
      if (!res.ok) throw new Error("Failed");
      toast({ title: "Disposition updated" });
      onUpdate();
    } catch {
      toast({ title: "Failed to update disposition", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Tag className="w-3 h-3 text-muted-foreground flex-shrink-0" />
      <Select value={current ?? ""} onValueChange={handleChange} disabled={saving}>
        <SelectTrigger className="font-mono text-[10px] h-6 w-40 border-dashed">
          <SelectValue placeholder="Set disposition…" />
        </SelectTrigger>
        <SelectContent>
          {DISPOSITION_OPTIONS.map(d => (
            <SelectItem key={d.value} value={d.value} className="font-mono text-xs">
              {d.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {saving && <RefreshCw className="w-3 h-3 animate-spin text-muted-foreground" />}
    </div>
  );
}

// ── Recording button — shows link if URL ready, refresh spinner if not ────────
function RecordingButton({ row, onRefreshed }: { row: CdrRow; onRefreshed: () => void }) {
  const [loading, setLoading] = useState(false);
  const [refreshedUrl, setRefreshedUrl] = useState<string | null>(null);
  const url = refreshedUrl ?? row.recordingUrl;

  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono rounded border border-border text-muted-foreground hover:text-foreground transition-colors"
      >
        <Play className="w-2.5 h-2.5" />
        Recording
        <ExternalLink className="w-2 h-2" />
      </a>
    );
  }

  if (row.source !== "call_logs") return null;
  const numId = parseInt(row.id.replace(/^[cl]-/, ""), 10);
  if (isNaN(numId)) return null;

  const handleRefresh = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem("auth_token");
      const res = await fetch(`/api/call-logs/${numId}/refresh-recording`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data: { recordingUrl?: string | null } = await res.json();
      if (data.recordingUrl) {
        setRefreshedUrl(data.recordingUrl);
        onRefreshed();
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleRefresh}
      disabled={loading}
      className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono rounded border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
      title="Recording may still be processing — click to check"
    >
      <RefreshCw className={`w-2.5 h-2.5 ${loading ? "animate-spin" : ""}`} />
      {loading ? "Checking…" : "Fetch Recording"}
    </button>
  );
}

// ── Delete button — permanently removes a record from history ─────────────────
function DeleteButton({
  id,
  endpoint,
  onDeleted,
}: {
  id: number;
  endpoint: "calls" | "call-logs";
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const handleDelete = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem("auth_token");
      const url = endpoint === "calls" ? `/api/calls/${id}` : `/api/call-logs/${id}`;
      const res = await fetch(url, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      toast({ title: "Record removed from history" });
      onDeleted();
    } catch {
      toast({ title: "Failed to delete record", variant: "destructive" });
    } finally {
      setLoading(false);
      setConfirming(false);
    }
  };

  if (confirming) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-mono text-red-400">Remove this record?</span>
        <button
          onClick={handleDelete}
          disabled={loading}
          className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
        >
          {loading ? <RefreshCw className="w-2.5 h-2.5 animate-spin" /> : "Yes, remove"}
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="px-2 py-1 text-[10px] font-mono rounded border border-border text-muted-foreground hover:text-foreground transition-colors"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono rounded border border-border text-muted-foreground hover:text-red-400 hover:border-red-500/30 transition-colors"
      title="Remove from history"
    >
      <Trash2 className="w-2.5 h-2.5" />
      Remove
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function CallsPage() {
  const [activeTab, setActiveTab] = useState<Tab>("cdr");
  const [filterCampaign, setFilterCampaign] = useState("__all__");
  const [filterDirection, setFilterDirection] = useState("__all__");
  const [logFilterCampaign, setLogFilterCampaign] = useState("__all__");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedLogId, setExpandedLogId] = useState<number | null>(null);

  const qc = useQueryClient();
  const socketRef = useRef<Socket | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);

  // ── Socket.IO live connection — refetch immediately on any call lifecycle event
  useEffect(() => {
    const token = localStorage.getItem("auth_token");
    const socket = io(window.location.origin, {
      path: "/api/ws",
      auth: token ? { token } : {},
      transports: ["websocket", "polling"],
    });
    socketRef.current = socket;

    socket.on("connect", () => setLiveConnected(true));
    socket.on("disconnect", () => setLiveConnected(false));

    const refreshAll = () => {
      qc.invalidateQueries({ queryKey: ["calls-cdr"] });
      qc.invalidateQueries({ queryKey: ["call-logs"] });
    };

    // Refetch immediately whenever a call changes state
    socket.on("call:ended", refreshAll);
    socket.on("call:started", refreshAll);
    socket.on("call:transferred", refreshAll);
    socket.on("call:inbound", refreshAll);
    socket.on("call_update", refreshAll);

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [qc]);

  // Unified CDR — both outbound (calls table) + inbound (call_logs) merged
  const cdrParams = new URLSearchParams();
  if (filterCampaign !== "__all__") cdrParams.set("campaignId", filterCampaign);
  if (filterDirection !== "__all__") cdrParams.set("direction", filterDirection);

  const { data: calls, isLoading: callsLoading, refetch: refetchCalls } = useQuery<CdrRow[]>({
    queryKey: ["calls-cdr", filterCampaign, filterDirection],
    queryFn: () => customFetch<CdrRow[]>(`/api/calls/cdr?${cdrParams.toString()}`),
    refetchInterval: activeTab === "cdr" ? 30000 : false,
    refetchOnWindowFocus: true,
  });
  const { data: campaigns } = useListCampaigns();

  const callLogsQuery = useQuery<CallLog[]>({
    queryKey: ["call-logs", logFilterCampaign],
    queryFn: async () => {
      const params = logFilterCampaign !== "__all__"
        ? `?campaignId=${logFilterCampaign}`
        : "";
      return await customFetch<CallLog[]>(`/api/call-logs${params}`);
    },
    enabled: activeTab === "call-logs",
    refetchInterval: activeTab === "call-logs" ? 30000 : false,
    refetchOnWindowFocus: true,
  });

  const campaignMap = Object.fromEntries(
    (campaigns ?? []).map((c: { id: number; name: string }) => [c.id, c.name]),
  );

  return (
    <Layout>
      <PageHeader
        title="Call Records"
        subtitle={activeTab === "cdr"
          ? `${(calls ?? []).length} full CDR entries`
          : `${(callLogsQuery.data ?? []).length} campaign log entries`}
        action={
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${liveConnected ? "bg-primary animate-pulse" : "bg-muted-foreground/40"}`} />
            {liveConnected ? "LIVE" : "connecting..."}
          </div>
        }
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

      {/* ── Full CDR tab ────────────────────────────────────────────────────── */}
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
            <Select value={filterDirection} onValueChange={setFilterDirection}>
              <SelectTrigger className="font-mono text-xs h-7 w-36">
                <SelectValue placeholder="All directions" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All directions</SelectItem>
                <SelectItem value="inbound">Inbound only</SelectItem>
                <SelectItem value="outbound">Outbound only</SelectItem>
              </SelectContent>
            </Select>
            {callsLoading && (
              <span className="text-[10px] font-mono text-muted-foreground animate-pulse">loading...</span>
            )}
          </div>
          <div className="p-6">
            <div className="border border-border rounded bg-card overflow-hidden">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider w-8"></th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Dir</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Phone</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Campaign</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Provider</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Status</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Disposition</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Duration</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider whitespace-nowrap">Dialed At</th>
                  </tr>
                </thead>
                <tbody>
                  {callsLoading ? (
                    [...Array(6)].map((_, i) => (
                      <tr key={i}>
                        {[...Array(9)].map((_, j) => (
                          <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>
                        ))}
                      </tr>
                    ))
                  ) : (calls ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">No call records found</td>
                    </tr>
                  ) : (calls ?? []).map((c) => (
                    <Fragment key={c.id}>
                      <tr
                        className="border-b border-border/30 hover:bg-white/2 transition-colors cursor-pointer"
                        onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}
                      >
                        <td className="px-4 py-3 text-muted-foreground">
                          <ChevronDown className={`w-3 h-3 transition-transform ${expandedId === c.id ? "rotate-180" : ""}`} />
                        </td>
                        <td className="px-4 py-3">
                          {c.direction === "inbound" ? (
                            <span className="inline-flex items-center gap-1 text-cyan-400">
                              <PhoneIncoming className="w-3 h-3" />
                              <span className="text-[9px] uppercase tracking-wider">IN</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-green-400">
                              <PhoneOutgoing className="w-3 h-3" />
                              <span className="text-[9px] uppercase tracking-wider">OUT</span>
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-foreground/80">{c.phoneNumber ?? "-"}</td>
                        <td className="px-4 py-3">{c.campaignId ? campaignMap[c.campaignId] ?? `#${c.campaignId}` : "-"}</td>
                        <td className="px-4 py-3 uppercase text-muted-foreground">{c.providerUsed ?? "-"}</td>
                        <td className="px-4 py-3"><StatusBadge status={c.status} /></td>
                        <td className="px-4 py-3">{c.disposition ? <DispositionBadge disp={c.disposition} /> : <span className="text-muted-foreground">-</span>}</td>
                        <td className="px-4 py-3 text-muted-foreground">{formatDuration(c.duration)}</td>
                        <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                          {(() => { const d = formatDialedAt(c.timestamp); return (
                            <div className="leading-tight">
                              <div className="text-foreground/90 text-xs">{d.date}</div>
                              <div className="text-[10px] text-muted-foreground">{d.time}</div>
                            </div>
                          ); })()}
                        </td>
                      </tr>
                      {expandedId === c.id && (
                        <tr key={`${c.id}-expanded`} className="border-b border-border/30 bg-white/2">
                          <td colSpan={9} className="px-6 py-4 space-y-3">
                            {/* Actions row */}
                            <div className="flex items-center gap-4 pb-2 border-b border-border/30 flex-wrap">
                              <DispositionUpdater
                                id={parseInt(c.id.replace(/^[cl]-/, ""))}
                                current={c.disposition}
                                endpoint={c.source === "call_logs" ? "call-logs" : "calls"}
                                onUpdate={() => refetchCalls()}
                              />
                              <ExportButtons
                                endpoint={c.source === "call_logs" ? "call-logs" : "calls"}
                                id={parseInt(c.id.replace(/^[cl]-/, ""))}
                              />
                              <RecordingButton row={c} onRefreshed={refetchCalls} />
                              <div className="ml-auto">
                                <DeleteButton
                                  id={parseInt(c.id.replace(/^[cl]-/, ""))}
                                  endpoint={c.source === "call_logs" ? "call-logs" : "calls"}
                                  onDeleted={refetchCalls}
                                />
                              </div>
                            </div>

                            {c.summary && (
                              <div>
                                <p className="text-[10px] font-mono uppercase text-muted-foreground mb-1">AI Summary</p>
                                <p className="text-xs font-mono text-foreground/80">{c.summary}</p>
                              </div>
                            )}
                            {c.transcript && (
                              <div>
                                <p className="text-[10px] font-mono uppercase text-muted-foreground mb-1">Transcript</p>
                                <p className="text-xs font-mono text-muted-foreground leading-relaxed max-h-32 overflow-y-auto whitespace-pre-wrap">{c.transcript}</p>
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

      {/* ── Campaign Logs tab ───────────────────────────────────────────────── */}
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
            <div className="border border-border rounded bg-card overflow-hidden">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider w-8"></th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">ID</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Phone</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Campaign</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Dir</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Status</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Disposition</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Duration</th>
                    <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider whitespace-nowrap">Dialed At</th>
                  </tr>
                </thead>
                <tbody>
                  {callLogsQuery.isLoading ? (
                    [...Array(6)].map((_, i) => (
                      <tr key={i}>
                        {[...Array(9)].map((_, j) => (
                          <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>
                        ))}
                      </tr>
                    ))
                  ) : (callLogsQuery.data ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">
                        No campaign call logs yet. Launch a campaign to start recording calls.
                      </td>
                    </tr>
                  ) : (callLogsQuery.data ?? []).map((log) => (
                    <Fragment key={log.id}>
                      <tr
                        className="border-b border-border/30 hover:bg-white/2 transition-colors cursor-pointer"
                        onClick={() => setExpandedLogId(expandedLogId === log.id ? null : log.id)}
                      >
                        <td className="px-4 py-3 text-muted-foreground">
                          <ChevronDown className={`w-3 h-3 transition-transform ${expandedLogId === log.id ? "rotate-180" : ""}`} />
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">#{log.id}</td>
                        <td className="px-4 py-3 text-green-400">{log.phoneNumber}</td>
                        <td className="px-4 py-3">{campaignMap[log.campaignId] ?? `#${log.campaignId}`}</td>
                        <td className="px-4 py-3 text-muted-foreground uppercase">{log.direction ?? "out"}</td>
                        <td className="px-4 py-3"><StatusPill status={log.status} /></td>
                        <td className="px-4 py-3">{log.disposition ? <DispositionBadge disp={log.disposition} /> : <span className="text-muted-foreground">-</span>}</td>
                        <td className="px-4 py-3 text-muted-foreground">{formatDuration(log.duration)}</td>
                        <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                          {(() => { const d = formatDialedAt(log.timestamp); return (
                            <div className="leading-tight">
                              <div className="text-foreground/90 text-xs">{d.date}</div>
                              <div className="text-[10px] text-muted-foreground">{d.time}</div>
                            </div>
                          ); })()}
                        </td>
                      </tr>
                      {expandedLogId === log.id && (
                        <tr key={`log-${log.id}-expanded`} className="border-b border-border/30 bg-white/2">
                          <td colSpan={9} className="px-6 py-4 space-y-3">
                            {/* Actions row */}
                            <div className="flex items-center gap-4 pb-2 border-b border-border/30 flex-wrap">
                              <DispositionUpdater
                                id={log.id}
                                current={log.disposition}
                                endpoint="call-logs"
                                onUpdate={() => callLogsQuery.refetch()}
                              />
                              <ExportButtons endpoint="call-logs" id={log.id} />
                              {log.recordingUrl && (
                                <a
                                  href={log.recordingUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono rounded border border-border text-muted-foreground hover:text-foreground transition-colors"
                                >
                                  <Play className="w-2.5 h-2.5" />
                                  Recording
                                  <ExternalLink className="w-2 h-2" />
                                </a>
                              )}
                              <div className="ml-auto">
                                <DeleteButton
                                  id={log.id}
                                  endpoint="call-logs"
                                  onDeleted={() => callLogsQuery.refetch()}
                                />
                              </div>
                            </div>

                            {log.summary && (
                              <div>
                                <p className="text-[10px] font-mono uppercase text-muted-foreground mb-1">AI Summary</p>
                                <p className="text-xs font-mono text-foreground/80">{log.summary}</p>
                              </div>
                            )}
                            {log.transcript && (
                              <div>
                                <p className="text-[10px] font-mono uppercase text-muted-foreground mb-1">Transcript</p>
                                <p className="text-xs font-mono text-muted-foreground leading-relaxed max-h-32 overflow-y-auto whitespace-pre-wrap">{log.transcript}</p>
                              </div>
                            )}
                            {!log.summary && !log.transcript && (
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
    </Layout>
  );
}
