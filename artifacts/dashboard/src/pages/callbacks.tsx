import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layout, PageHeader } from "@/components/layout";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Phone, Search, CheckCircle2, AlertCircle, RefreshCw, Clock } from "lucide-react";

type Lead = {
  id: number;
  phone: string;
  name?: string | null;
  email?: string | null;
  status: string;
  campaignId: number;
  callbackTime?: string | null;
  updatedAt?: string | null;
};

type Campaign = { id: number; name: string };

export default function CallbacksPage() {
  const [search, setSearch] = useState("");
  const [calling, setCalling] = useState<number | null>(null);
  const { toast } = useToast();

  const { data: leads = [], isLoading, refetch } = useQuery<Lead[]>({
    queryKey: ["callback-leads"],
    queryFn: () => customFetch("/api/leads?status=callback&limit=200") as Promise<Lead[]>,
    refetchInterval: 30_000,
  });

  const { data: campaigns = [] } = useQuery<Campaign[]>({
    queryKey: ["campaigns-list"],
    queryFn: () => customFetch("/api/campaigns") as Promise<Campaign[]>,
  });

  const campaignMap = Object.fromEntries((campaigns ?? []).map(c => [c.id, c.name]));

  const filtered = (Array.isArray(leads) ? leads : []).filter(l =>
    !search || l.phone.includes(search) || l.name?.toLowerCase().includes(search.toLowerCase())
  );

  const handleCall = async (lead: Lead) => {
    setCalling(lead.id);
    try {
      const data = await customFetch(`/api/campaigns/${lead.campaignId}/test-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: lead.phone }),
      }) as { success: boolean; jobId?: string; error?: string };
      if (data.success) {
        toast({ title: `Calling ${lead.phone}`, description: `Job ID: ${data.jobId}` });
        refetch();
      } else {
        toast({ title: "Call failed", description: data.error, variant: "destructive" });
      }
    } catch (err: unknown) {
      toast({ title: "Call failed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    } finally {
      setCalling(null);
    }
  };

  return (
    <Layout>
      <PageHeader
        title="Callbacks"
        subtitle={`${filtered.length} leads awaiting callback`}
        action={
          <Button variant="outline" size="sm" className="font-mono text-xs uppercase tracking-wider h-7 px-3" onClick={() => refetch()}>
            <RefreshCw className="w-3 h-3 mr-1.5" /> Refresh
          </Button>
        }
      />
      <div className="p-6 space-y-4">
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 font-mono text-sm"
            placeholder="Search by phone or name..."
          />
        </div>

        {/* Table */}
        <div className="border border-border rounded bg-[hsl(224,71%,3%)] overflow-hidden">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Contact</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Phone</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Campaign</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                  <span className="flex items-center gap-1"><Clock className="w-2.5 h-2.5" /> Queued</span>
                </th>
                <th className="text-right px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Action</th>
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
                      <p className="text-xs font-mono">No callback leads — you're all caught up!</p>
                    </div>
                  </td>
                </tr>
              ) : filtered.map(lead => (
                <tr key={lead.id} className="border-b border-border/30 hover:bg-white/[0.02] transition-colors">
                  <td className="px-4 py-3">
                    <div>
                      <p className="text-foreground font-medium">{lead.name ?? "—"}</p>
                      {lead.email && <p className="text-[10px] text-muted-foreground">{lead.email}</p>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-foreground">{lead.phone}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {campaignMap[lead.campaignId] ?? `#${lead.campaignId}`}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {lead.updatedAt ? new Date(lead.updatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleCall(lead)}
                      disabled={calling === lead.id}
                      className="flex items-center gap-1 px-2.5 py-1 rounded text-[10px] border border-green-500/30 text-green-400 hover:bg-green-500/10 transition-colors ml-auto disabled:opacity-50"
                    >
                      {calling === lead.id
                        ? <><RefreshCw className="w-2.5 h-2.5 animate-spin" /> Calling...</>
                        : <><Phone className="w-2.5 h-2.5" /> Call Back</>}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {filtered.length > 0 && (
          <p className="text-[10px] font-mono text-muted-foreground text-center">
            Showing {filtered.length} callback{filtered.length !== 1 ? "s" : ""} · auto-refreshes every 30s
          </p>
        )}
      </div>
    </Layout>
  );
}
