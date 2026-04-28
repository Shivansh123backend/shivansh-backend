import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Layout, PageHeader } from "@/components/layout";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Phone, Search, CheckCircle2, RefreshCw, Clock, X, CalendarClock } from "lucide-react";

type CallbackLead = {
  id: number;
  phone: string;
  name?: string | null;
  email?: string | null;
  status: string;
  campaignId: number;
  campaignName?: string | null;
  callbackAt?: string | null;
  notes?: string | null;
};

export default function CallbacksPage() {
  const [search, setSearch] = useState("");
  const [calling, setCalling] = useState<number | null>(null);
  const [rescheduling, setRescheduling] = useState<number | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState("");
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: leads = [], isLoading, refetch } = useQuery<CallbackLead[]>({
    queryKey: ["callback-leads"],
    queryFn: () => customFetch("/api/callbacks") as Promise<CallbackLead[]>,
    refetchInterval: 30_000,
  });

  const filtered = (Array.isArray(leads) ? leads : []).filter(l =>
    !search || l.phone.includes(search) || l.name?.toLowerCase().includes(search.toLowerCase())
  );

  const handleCall = async (lead: CallbackLead) => {
    setCalling(lead.id);
    try {
      const data = await customFetch(`/api/campaigns/${lead.campaignId}/test-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: lead.phone }),
      }) as { success: boolean; jobId?: string; error?: string };
      if (data.success) {
        await customFetch(`/api/callbacks/${lead.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "called" }),
        });
        toast({ title: `Calling ${lead.phone}` });
        qc.invalidateQueries({ queryKey: ["callback-leads"] });
      } else {
        toast({ title: "Call failed", description: data.error, variant: "destructive" });
      }
    } catch (err: unknown) {
      toast({ title: "Call failed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    } finally {
      setCalling(null);
    }
  };

  const handleReschedule = async (lead: CallbackLead) => {
    if (!rescheduleDate) {
      toast({ title: "Pick a date/time first", variant: "destructive" });
      return;
    }
    try {
      await customFetch(`/api/callbacks/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callbackAt: new Date(rescheduleDate).toISOString() }),
      });
      toast({ title: "Callback rescheduled" });
      setRescheduling(null);
      setRescheduleDate("");
      qc.invalidateQueries({ queryKey: ["callback-leads"] });
    } catch {
      toast({ title: "Failed to reschedule", variant: "destructive" });
    }
  };

  const handleCancel = async (lead: CallbackLead) => {
    try {
      await customFetch(`/api/callbacks/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "pending" }),
      });
      toast({ title: "Callback cancelled — lead reset to pending" });
      qc.invalidateQueries({ queryKey: ["callback-leads"] });
    } catch {
      toast({ title: "Failed to cancel", variant: "destructive" });
    }
  };

  function formatScheduled(ts?: string | null) {
    if (!ts) return "—";
    const d = new Date(ts);
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    const diffMins = Math.round(diffMs / 60_000);
    const timeStr = d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    if (diffMs < 0) return <span className="text-red-400">{timeStr} <span className="text-[9px]">(overdue)</span></span>;
    if (diffMins < 60) return <span className="text-yellow-400">{timeStr} <span className="text-[9px]">(in {diffMins}m)</span></span>;
    return <span>{timeStr}</span>;
  }

  return (
    <Layout>
      <PageHeader
        title="Callbacks"
        subtitle={`${filtered.length} leads scheduled for callback`}
        action={
          <Button variant="outline" size="sm" className="font-mono text-xs uppercase tracking-wider h-7 px-3" onClick={() => refetch()}>
            <RefreshCw className="w-3 h-3 mr-1.5" /> Refresh
          </Button>
        }
      />
      <div className="p-6 space-y-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 font-mono text-sm"
            placeholder="Search by phone or name..."
          />
        </div>

        <div className="border border-border rounded bg-card overflow-hidden">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Contact</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Phone</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Campaign</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                  <span className="flex items-center gap-1"><Clock className="w-2.5 h-2.5" /> Scheduled For</span>
                </th>
                <th className="text-right px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                [...Array(5)].map((_, i) => (
                  <tr key={i} className="border-b border-border/30">
                    {[...Array(5)].map((_, j) => (
                      <td key={j} className="px-4 py-3"><Skeleton className="h-3.5 w-full" /></td>
                    ))}
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                    <div className="flex flex-col items-center gap-2">
                      <CheckCircle2 className="w-6 h-6 text-green-400/50" />
                      <p className="text-xs font-mono">No callbacks scheduled — you're all caught up!</p>
                    </div>
                  </td>
                </tr>
              ) : filtered.map(lead => (
                <>
                  <tr key={lead.id} className="border-b border-border/30 hover:bg-white/[0.02] transition-colors">
                    <td className="px-4 py-3">
                      <div>
                        <p className="text-foreground font-medium">{lead.name ?? "—"}</p>
                        {lead.email && <p className="text-[10px] text-muted-foreground">{lead.email}</p>}
                        {lead.notes && <p className="text-[10px] text-muted-foreground italic mt-0.5">"{lead.notes}"</p>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-foreground">{lead.phone}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {lead.campaignName ?? `#${lead.campaignId}`}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground font-mono text-[11px]">
                      {formatScheduled(lead.callbackAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 justify-end flex-wrap">
                        <button
                          onClick={() => handleCall(lead)}
                          disabled={calling === lead.id}
                          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-green-500/30 text-green-400 hover:bg-green-500/10 transition-colors disabled:opacity-50"
                        >
                          {calling === lead.id
                            ? <><RefreshCw className="w-2.5 h-2.5 animate-spin" /> Calling...</>
                            : <><Phone className="w-2.5 h-2.5" /> Call Now</>}
                        </button>
                        <button
                          onClick={() => { setRescheduling(rescheduling === lead.id ? null : lead.id); setRescheduleDate(""); }}
                          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-blue-500/30 text-blue-400 hover:bg-blue-500/10 transition-colors"
                        >
                          <CalendarClock className="w-2.5 h-2.5" /> Reschedule
                        </button>
                        <button
                          onClick={() => handleCancel(lead)}
                          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-border text-muted-foreground hover:text-red-400 hover:border-red-500/30 transition-colors"
                          title="Cancel callback — lead goes back to pending"
                        >
                          <X className="w-2.5 h-2.5" /> Cancel
                        </button>
                      </div>
                    </td>
                  </tr>
                  {rescheduling === lead.id && (
                    <tr key={`${lead.id}-reschedule`} className="border-b border-border/30 bg-blue-500/[0.03]">
                      <td colSpan={5} className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <CalendarClock className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
                          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">New time:</span>
                          <Input
                            type="datetime-local"
                            value={rescheduleDate}
                            onChange={e => setRescheduleDate(e.target.value)}
                            className="font-mono text-xs h-7 w-52"
                          />
                          <button
                            onClick={() => handleReschedule(lead)}
                            disabled={!rescheduleDate}
                            className="px-3 py-1 text-[10px] font-mono rounded bg-blue-500/20 text-blue-400 border border-blue-500/30 hover:bg-blue-500/30 transition-colors disabled:opacity-50"
                          >
                            Confirm
                          </button>
                          <button
                            onClick={() => { setRescheduling(null); setRescheduleDate(""); }}
                            className="px-2 py-1 text-[10px] font-mono rounded border border-border text-muted-foreground hover:text-foreground transition-colors"
                          >
                            Close
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>

        {filtered.length > 0 && (
          <p className="text-[10px] font-mono text-muted-foreground text-center">
            Showing {filtered.length} scheduled callback{filtered.length !== 1 ? "s" : ""} · auto-refreshes every 30s
          </p>
        )}
      </div>
    </Layout>
  );
}
