import { useEffect, useState } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Layout, PageHeader } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Plus, X, UserRound, Phone, Trash2 } from "lucide-react";

type HumanAgent = {
  id: number;
  name: string;
  phone_number: string;
  status: "available" | "busy";
  current_call?: unknown;
};

function CreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [status, setStatus] = useState<"available" | "busy">("available");
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await customFetch("/api/human-agents/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, phone_number: phoneNumber, status }),
      });
      toast({ title: "Human agent added" });
      onCreated();
      onClose();
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? "Failed to add agent";
      toast({ title: msg, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded w-full max-w-md">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <p className="text-xs font-mono uppercase tracking-widest text-foreground">New Human Agent</p>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Full Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} className="font-mono text-sm" required />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Phone Number</Label>
            <Input
              value={phoneNumber}
              onChange={e => setPhoneNumber(e.target.value)}
              className="font-mono text-sm"
              placeholder="+15551234567"
              required
              minLength={7}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Initial Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as "available" | "busy")}>
              <SelectTrigger className="font-mono text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="available">Available</SelectItem>
                <SelectItem value="busy">Busy</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" className="w-full font-mono text-xs uppercase tracking-wider" disabled={submitting}>
            {submitting ? "Adding..." : "Add Agent"}
          </Button>
        </form>
      </div>
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  available: "border-emerald-500/30 text-emerald-400 bg-emerald-500/5",
  busy:      "border-amber-500/30 text-amber-400 bg-amber-500/5",
};

export default function HumanAgentsPage() {
  const [agents, setAgents] = useState<HumanAgent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const { toast } = useToast();

  const refresh = async () => {
    try {
      const data = await customFetch<HumanAgent[]>("/api/human-agents");
      setAgents(data);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? "Failed to load agents";
      toast({ title: msg, variant: "destructive" });
      setAgents([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const handleDelete = async (a: HumanAgent) => {
    if (!window.confirm(`Remove ${a.name} (${a.phone_number}) from the agent pool? This cannot be undone.`)) return;
    setDeletingId(a.id);
    try {
      await customFetch(`/api/human-agents/${a.id}`, { method: "DELETE" });
      toast({ title: `${a.name} removed` });
      await refresh();
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? "Failed to remove agent";
      toast({ title: msg, variant: "destructive" });
    } finally {
      setDeletingId(null);
    }
  };

  const handleStatusChange = async (a: HumanAgent, status: "available" | "busy") => {
    if (status === a.status) return;
    try {
      await customFetch("/api/human-agents/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: a.id, status }),
      });
      toast({ title: `${a.name} → ${status}` });
      await refresh();
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? "Failed to update status";
      toast({ title: msg, variant: "destructive" });
    }
  };

  return (
    <Layout>
      {showCreate && <CreateModal onClose={() => setShowCreate(false)} onCreated={refresh} />}
      <PageHeader
        title="Human Agents"
        subtitle={`${(agents ?? []).length} in pool`}
        action={
          <Button size="sm" className="font-mono text-xs uppercase tracking-wider h-7 px-3" onClick={() => setShowCreate(true)}>
            <Plus className="w-3 h-3 mr-1.5" /> Add Agent
          </Button>
        }
      />
      <div className="p-6">
        <div className="border border-border rounded bg-card overflow-hidden">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Agent</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Phone</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Status</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">On Call</th>
                <th className="px-4 py-2.5 w-12"></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(4)].map((_, i) => (
                  <tr key={i}>
                    {[...Array(5)].map((_, j) => (
                      <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>
                    ))}
                  </tr>
                ))
              ) : (agents ?? []).length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    No human agents yet. Click <span className="text-foreground">Add Agent</span> above.
                  </td>
                </tr>
              ) : (agents ?? []).map((a) => (
                <tr key={a.id} className="border-b border-border/30 hover:bg-white/2 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="w-6 h-6 rounded bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
                        <UserRound className="w-3 h-3 text-primary" />
                      </div>
                      <span className="text-foreground font-medium">{a.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <div className="flex items-center gap-1.5">
                      <Phone className="w-3 h-3" />
                      {a.phone_number}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Select
                      value={a.status}
                      onValueChange={(v) => handleStatusChange(a, v as "available" | "busy")}
                    >
                      <SelectTrigger className="h-7 w-[120px] font-mono text-[10px] uppercase tracking-wider px-2">
                        <Badge
                          variant="outline"
                          className={`text-[9px] font-mono uppercase ${STATUS_STYLES[a.status] ?? "border-border text-muted-foreground"}`}
                        >
                          {a.status}
                        </Badge>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="available">Available</SelectItem>
                        <SelectItem value="busy">Busy</SelectItem>
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {a.current_call ? <Badge variant="outline" className="text-[9px] font-mono border-cyan-500/30 text-cyan-400">In call</Badge> : <span className="text-muted-foreground/50">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleDelete(a)}
                      disabled={deletingId === a.id}
                      title="Remove agent"
                      className="p-1.5 rounded text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
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
