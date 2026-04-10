import { useState } from "react";
import {
  useListNumbers,
  useAddNumber,
  useListCampaigns,
  getListNumbersQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Layout, PageHeader } from "@/components/layout";
import { StatusBadge } from "./dashboard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Plus, X } from "lucide-react";

const PROVIDER_STYLES: Record<string, string> = {
  voip: "border-blue-500/30 text-blue-400 bg-blue-500/5",
  telnyx: "border-purple-500/30 text-purple-400 bg-purple-500/5",
  twilio: "border-red-500/30 text-red-400 bg-red-500/5",
};

function CreateModal({ onClose, campaigns }: { onClose: () => void; campaigns: { id: number; name: string }[] }) {
  const [phoneNumber, setPhoneNumber] = useState("");
  const [provider, setProvider] = useState("voip");
  const [campaignId, setCampaignId] = useState("");
  const [priority, setPriority] = useState("1");
  const addNumber = useAddNumber();
  const qc = useQueryClient();
  const { toast } = useToast();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    addNumber.mutate(
      { data: { phoneNumber, provider: provider as "voip" | "telnyx" | "twilio", campaignId: campaignId && campaignId !== "__none__" ? parseInt(campaignId) : undefined, priority: parseInt(priority) } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListNumbersQueryKey() });
          toast({ title: "Phone number added" });
          onClose();
        },
        onError: () => toast({ title: "Failed to add number", variant: "destructive" }),
      }
    );
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[hsl(224,71%,3%)] border border-border rounded w-full max-w-md">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <p className="text-xs font-mono uppercase tracking-widest text-foreground">Add Phone Number</p>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Phone Number (E.164)</Label>
            <Input value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} className="font-mono text-sm" placeholder="+14155550100" required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">Provider</Label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger className="font-mono text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="voip">VoIP</SelectItem>
                  <SelectItem value="telnyx">Telnyx</SelectItem>
                  <SelectItem value="twilio">Twilio</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">Priority</Label>
              <Input type="number" value={priority} onChange={e => setPriority(e.target.value)} className="font-mono text-sm" min="1" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Campaign (optional)</Label>
            <Select value={campaignId} onValueChange={setCampaignId}>
              <SelectTrigger className="font-mono text-sm"><SelectValue placeholder="Unassigned" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Unassigned</SelectItem>
                {campaigns.map(c => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" className="w-full font-mono text-xs uppercase tracking-wider" disabled={addNumber.isPending}>
            {addNumber.isPending ? "Adding..." : "Add Number"}
          </Button>
        </form>
      </div>
    </div>
  );
}

export default function NumbersPage() {
  const { data: numbers, isLoading } = useListNumbers();
  const { data: campaigns } = useListCampaigns();
  const [showCreate, setShowCreate] = useState(false);

  const campaignMap = Object.fromEntries((campaigns ?? []).map((c: { id: number; name: string }) => [c.id, c.name]));

  return (
    <Layout>
      {showCreate && <CreateModal onClose={() => setShowCreate(false)} campaigns={campaigns ?? []} />}
      <PageHeader
        title="Phone Numbers"
        subtitle={`${(numbers ?? []).length} configured`}
        action={
          <Button size="sm" className="font-mono text-xs uppercase tracking-wider h-7 px-3" onClick={() => setShowCreate(true)}>
            <Plus className="w-3 h-3 mr-1.5" /> Add Number
          </Button>
        }
      />
      <div className="p-6">
        <div className="border border-border rounded bg-[hsl(224,71%,3%)] overflow-hidden">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Number</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Provider</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Campaign</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Priority</th>
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
              ) : (numbers ?? []).map((n: { id: number; phoneNumber: string; provider: string; campaignId?: number; priority?: number; status: string }) => (
                <tr key={n.id} className="border-b border-border/30 hover:bg-white/2 transition-colors">
                  <td className="px-4 py-3 text-foreground font-mono font-medium">{n.phoneNumber}</td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className={`text-[9px] font-mono uppercase ${PROVIDER_STYLES[n.provider] ?? "border-border text-muted-foreground"}`}>
                      {n.provider}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{n.campaignId ? campaignMap[n.campaignId] ?? `#${n.campaignId}` : "Unassigned"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{n.priority ?? 1}</td>
                  <td className="px-4 py-3"><StatusBadge status={n.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}
