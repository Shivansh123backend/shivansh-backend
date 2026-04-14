import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Layout, PageHeader } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Plus, X, Trash2, ClipboardList, ShieldX } from "lucide-react";

type DncEntry = { id: number; phone_number: string; reason?: string | null; created_at: string };

function AddModal({ onClose }: { onClose: () => void }) {
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState("");
  const qc = useQueryClient();
  const { toast } = useToast();

  const add = useMutation({
    mutationFn: () =>
      customFetch("/api/dnc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_number: phone, reason: reason || undefined }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dnc"] });
      toast({ title: "Number added to DNC list" });
      onClose();
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[hsl(224,71%,3%)] border border-border rounded w-full max-w-md">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <p className="text-xs font-mono uppercase tracking-widest text-foreground">Add to DNC List</p>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Phone Number</Label>
            <Input
              value={phone}
              onChange={e => setPhone(e.target.value)}
              className="font-mono text-sm"
              placeholder="+14155550100"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Reason <span className="text-muted-foreground/50 normal-case">(optional)</span></Label>
            <Input
              value={reason}
              onChange={e => setReason(e.target.value)}
              className="font-mono text-sm"
              placeholder="Customer requested removal"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <Button variant="outline" className="flex-1 font-mono text-xs uppercase tracking-wider" onClick={onClose}>Cancel</Button>
            <Button
              className="flex-1 font-mono text-xs uppercase tracking-wider"
              disabled={!phone.trim() || add.isPending}
              onClick={() => add.mutate()}
            >
              {add.isPending ? "Adding..." : "Add to DNC"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PasteImportModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const qc = useQueryClient();
  const { toast } = useToast();

  const numbers = text
    .split(/[\n,;]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 7);

  const importMut = useMutation({
    mutationFn: () =>
      customFetch("/api/dnc/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ numbers }),
      }),
    onSuccess: (data: { added: number; skipped: number }) => {
      qc.invalidateQueries({ queryKey: ["dnc"] });
      toast({ title: `${data.added} numbers added, ${data.skipped} skipped (duplicates)` });
      onClose();
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[hsl(224,71%,3%)] border border-border rounded w-full max-w-lg">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <p className="text-xs font-mono uppercase tracking-widest text-foreground">Bulk Import DNC</p>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">
              Phone Numbers
              {numbers.length > 0 && <span className="ml-2 text-primary normal-case">{numbers.length} detected</span>}
            </Label>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              rows={8}
              placeholder={"+14155550100\n+14155550101\n\nOne per line or comma separated."}
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <Button variant="outline" className="flex-1 font-mono text-xs uppercase tracking-wider" onClick={onClose}>Cancel</Button>
            <Button
              className="flex-1 font-mono text-xs uppercase tracking-wider"
              disabled={numbers.length === 0 || importMut.isPending}
              onClick={() => importMut.mutate()}
            >
              {importMut.isPending ? "Importing..." : `Import ${numbers.length > 0 ? numbers.length : ""}`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DncPage() {
  const { data, isLoading } = useQuery<DncEntry[]>({
    queryKey: ["dnc"],
    queryFn: () => customFetch("/api/dnc"),
  });
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const remove = useMutation({
    mutationFn: (id: number) => customFetch(`/api/dnc/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dnc"] });
      toast({ title: "Removed from DNC list" });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  return (
    <Layout>
      {showAdd && <AddModal onClose={() => setShowAdd(false)} />}
      {showImport && <PasteImportModal onClose={() => setShowImport(false)} />}

      <PageHeader
        title="Do Not Call List"
        subtitle={`${(data ?? []).length} numbers blocked`}
        action={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="font-mono text-xs uppercase tracking-wider h-7 px-3"
              onClick={() => setShowImport(true)}
            >
              <ClipboardList className="w-3 h-3 mr-1.5" /> Bulk Import
            </Button>
            <Button
              size="sm"
              className="font-mono text-xs uppercase tracking-wider h-7 px-3"
              onClick={() => setShowAdd(true)}
            >
              <Plus className="w-3 h-3 mr-1.5" /> Add Number
            </Button>
          </div>
        }
      />

      <div className="p-6">
        <div className="border border-border rounded bg-[hsl(224,71%,3%)] overflow-hidden">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Phone Number</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Reason</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Added</th>
                <th className="w-12 px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                [...Array(5)].map((_, i) => (
                  <tr key={i}>
                    {[...Array(4)].map((_, j) => (
                      <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>
                    ))}
                  </tr>
                ))
              ) : (data ?? []).length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center">
                    <ShieldX className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                    <p className="text-muted-foreground">DNC list is empty. Numbers added here will never be dialed.</p>
                  </td>
                </tr>
              ) : (data ?? []).map((entry) => (
                <tr key={entry.id} className="border-b border-border/30 hover:bg-white/2 transition-colors">
                  <td className="px-4 py-3 text-primary font-medium">{entry.phone_number}</td>
                  <td className="px-4 py-3 text-muted-foreground">{entry.reason ?? "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{new Date(entry.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => remove.mutate(entry.id)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                      title="Remove from DNC"
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
