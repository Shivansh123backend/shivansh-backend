import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useListCampaigns, customFetch } from "@workspace/api-client-react";
import { Layout, PageHeader } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Plus, X, Trash2, Edit2, Power, PowerOff } from "lucide-react";

type LeadList = {
  id: number;
  name: string;
  description: string | null;
  campaignId: number | null;
  campaignName: string | null;
  active: boolean;
  leadsCount: number;
  lastCalledAt: string | null;
  createdAt: string;
};

type Campaign = { id: number; name: string };

const LISTS_KEY = ["/api/lists"];

function CreateOrEditModal({ onClose, list, campaigns }: { onClose: () => void; list?: LeadList; campaigns: Campaign[] }) {
  const [name, setName] = useState(list?.name ?? "");
  const [description, setDescription] = useState(list?.description ?? "");
  const [campaignId, setCampaignId] = useState<string>(list?.campaignId ? String(list.campaignId) : "__none__");
  const [active, setActive] = useState(list?.active ?? true);
  const qc = useQueryClient();
  const { toast } = useToast();

  const mut = useMutation({
    mutationFn: async () => {
      const body = {
        name,
        description: description || undefined,
        campaignId: campaignId === "__none__" ? null : parseInt(campaignId),
        active,
      };
      if (list) {
        return customFetch(`/api/lists/${list.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      }
      return customFetch("/api/lists", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LISTS_KEY });
      toast({ title: list ? "List updated" : "List created" });
      onClose();
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded w-full max-w-md">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <p className="text-xs font-mono uppercase tracking-widest">{list ? "Edit List" : "New List"}</p>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        <form onSubmit={e => { e.preventDefault(); mut.mutate(); }} className="p-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">List name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} required className="font-mono text-sm" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Description</Label>
            <Input value={description} onChange={e => setDescription(e.target.value)} className="font-mono text-sm" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Assigned Campaign</Label>
            <Select value={campaignId} onValueChange={setCampaignId}>
              <SelectTrigger className="font-mono text-sm"><SelectValue placeholder="Unassigned" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— Unassigned —</SelectItem>
                {campaigns.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <input id="active" type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} className="w-3.5 h-3.5 accent-primary" />
            <Label htmlFor="active" className="text-xs font-mono cursor-pointer">Active (dialer will pick up these leads when campaign runs)</Label>
          </div>
          <div className="flex gap-2 pt-1">
            <Button type="button" variant="outline" className="flex-1 font-mono text-xs uppercase" onClick={onClose}>Cancel</Button>
            <Button type="submit" className="flex-1 font-mono text-xs uppercase" disabled={!name || mut.isPending}>
              {mut.isPending ? "Saving…" : list ? "Save" : "Create"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function ListsPage() {
  const { data: lists, isLoading } = useQuery<LeadList[]>({ queryKey: LISTS_KEY, queryFn: () => customFetch<LeadList[]>("/api/lists") });
  const { data: campaigns } = useListCampaigns();
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<LeadList | undefined>();
  const qc = useQueryClient();
  const { toast } = useToast();

  const del = useMutation({
    mutationFn: async (id: number) => customFetch(`/api/lists/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LISTS_KEY });
      toast({ title: "List deleted" });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const toggleActive = useMutation({
    mutationFn: async (l: LeadList) => customFetch(`/api/lists/${l.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !l.active }),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: LISTS_KEY }),
  });

  return (
    <Layout>
      {showCreate && <CreateOrEditModal onClose={() => setShowCreate(false)} campaigns={campaigns ?? []} />}
      {editing && <CreateOrEditModal list={editing} onClose={() => setEditing(undefined)} campaigns={campaigns ?? []} />}

      <PageHeader
        title="Lists"
        subtitle={`${(lists ?? []).length} list${(lists ?? []).length !== 1 ? "s" : ""}`}
        action={
          <Button size="sm" className="font-mono text-xs uppercase tracking-wider h-7 px-3" onClick={() => setShowCreate(true)}>
            <Plus className="w-3 h-3 mr-1.5" /> New List
          </Button>
        }
      />

      <div className="p-6">
        <div className="border border-border rounded bg-card overflow-hidden">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">ID</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">List Name</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Description</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Leads Count</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Active</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Last Call</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Campaign</th>
                <th className="text-right px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Modify</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                [...Array(4)].map((_, i) => (
                  <tr key={i}>{[...Array(8)].map((_, j) => <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>)}</tr>
                ))
              ) : (lists ?? []).length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">No lists yet. Click <span className="text-primary">New List</span> to create one.</td></tr>
              ) : (lists ?? []).map(l => (
                <tr key={l.id} className="border-b border-border/30 hover:bg-white/2 transition-colors">
                  <td className="px-4 py-3 text-muted-foreground">#{l.id}</td>
                  <td className="px-4 py-3 text-foreground font-medium">{l.name}</td>
                  <td className="px-4 py-3 text-muted-foreground truncate max-w-xs">{l.description ?? "-"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{l.leadsCount ?? 0}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-[10px] uppercase tracking-wider ${l.active ? "bg-green-500/15 text-green-400" : "bg-muted text-muted-foreground"}`}>
                      {l.active ? "Y" : "N"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{l.lastCalledAt ? new Date(l.lastCalledAt).toLocaleString() : "-"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{l.campaignName ?? "-"}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        title={l.active ? "Pause list" : "Activate list"}
                        onClick={() => toggleActive.mutate(l)}
                        className="p-1 rounded hover:bg-white/5 text-muted-foreground hover:text-foreground"
                      >
                        {l.active ? <PowerOff className="w-3.5 h-3.5" /> : <Power className="w-3.5 h-3.5" />}
                      </button>
                      <button
                        title="Edit"
                        onClick={() => setEditing(l)}
                        className="p-1 rounded hover:bg-white/5 text-muted-foreground hover:text-foreground"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        title="Delete"
                        onClick={() => { if (confirm(`Delete list "${l.name}"? Leads will be unassigned but kept.`)) del.mutate(l.id); }}
                        className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
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
