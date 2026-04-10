import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useListLeads,
  useListCampaigns,
  getListLeadsQueryKey,
  customFetch,
} from "@workspace/api-client-react";
import { Layout, PageHeader } from "@/components/layout";
import { StatusBadge } from "./dashboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Plus, X, Filter } from "lucide-react";

function CreateModal({ onClose, campaigns }: { onClose: () => void; campaigns: { id: number; name: string }[] }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const qc = useQueryClient();
  const { toast } = useToast();

  const addLead = useMutation({
    mutationFn: async () => {
      const res = await customFetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          phone_number: phone,
          email: email || undefined,
          campaign_id: parseInt(campaignId),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? "Failed to add lead");
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getListLeadsQueryKey() });
      toast({ title: "Lead added successfully" });
      onClose();
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!campaignId) {
      toast({ title: "Please select a campaign", variant: "destructive" });
      return;
    }
    addLead.mutate();
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[hsl(224,71%,3%)] border border-border rounded w-full max-w-md">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <p className="text-xs font-mono uppercase tracking-widest text-foreground">Add Lead</p>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Full Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} className="font-mono text-sm" placeholder="John Smith" required />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Phone Number</Label>
            <Input value={phone} onChange={e => setPhone(e.target.value)} className="font-mono text-sm" placeholder="+14155550100" required />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Email <span className="text-muted-foreground/50 normal-case">(optional)</span></Label>
            <Input value={email} onChange={e => setEmail(e.target.value)} className="font-mono text-sm" placeholder="john@example.com" type="email" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Campaign</Label>
            <Select value={campaignId} onValueChange={setCampaignId}>
              <SelectTrigger className="font-mono text-sm"><SelectValue placeholder="Select campaign" /></SelectTrigger>
              <SelectContent>
                {campaigns.map(c => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" className="w-full font-mono text-xs uppercase tracking-wider" disabled={addLead.isPending}>
            {addLead.isPending ? "Adding..." : "Add Lead"}
          </Button>
        </form>
      </div>
    </div>
  );
}

export default function LeadsPage() {
  const [filterCampaign, setFilterCampaign] = useState("__all__");
  const [filterStatus, setFilterStatus] = useState("__all__");
  const { data: leads, isLoading } = useListLeads({ campaignId: filterCampaign !== "__all__" ? parseInt(filterCampaign) : undefined, status: filterStatus !== "__all__" ? filterStatus : undefined });
  const { data: campaigns } = useListCampaigns();
  const [showCreate, setShowCreate] = useState(false);

  const campaignMap = Object.fromEntries((campaigns ?? []).map((c: { id: number; name: string }) => [c.id, c.name]));

  return (
    <Layout>
      {showCreate && <CreateModal onClose={() => setShowCreate(false)} campaigns={campaigns ?? []} />}
      <PageHeader
        title="Leads"
        subtitle={`${(leads ?? []).length} records`}
        action={
          <Button size="sm" className="font-mono text-xs uppercase tracking-wider h-7 px-3" onClick={() => setShowCreate(true)}>
            <Plus className="w-3 h-3 mr-1.5" /> Add Lead
          </Button>
        }
      />
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
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="font-mono text-xs h-7 w-40">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All statuses</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="called">Called</SelectItem>
            <SelectItem value="callback">Callback</SelectItem>
            <SelectItem value="do_not_call">Do Not Call</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="p-6">
        <div className="border border-border rounded bg-[hsl(224,71%,3%)] overflow-hidden">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">ID</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Name</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Phone</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Campaign</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Status</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                [...Array(6)].map((_, i) => (
                  <tr key={i}>
                    {[...Array(5)].map((_, j) => (
                      <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>
                    ))}
                  </tr>
                ))
              ) : (leads ?? []).map((l: { id: number; name: string; phone: string; campaignId?: number; status: string }) => (
                <tr key={l.id} className="border-b border-border/30 hover:bg-white/2 transition-colors">
                  <td className="px-4 py-3 text-muted-foreground">#{l.id}</td>
                  <td className="px-4 py-3 text-foreground font-medium">{l.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{l.phone}</td>
                  <td className="px-4 py-3 text-muted-foreground">{l.campaignId ? campaignMap[l.campaignId] ?? `#${l.campaignId}` : "-"}</td>
                  <td className="px-4 py-3"><StatusBadge status={l.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}
