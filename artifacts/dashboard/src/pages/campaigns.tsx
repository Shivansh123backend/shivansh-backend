import { useState } from "react";
import { Link } from "wouter";
import {
  useListCampaigns,
  useStartCampaign,
  useStopCampaign,
  useCreateCampaign,
  getListCampaignsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Layout, PageHeader } from "@/components/layout";
import { StatusBadge } from "./dashboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Play, Square, Plus, X } from "lucide-react";

function CreateModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("outbound");
  const [routingType, setRoutingType] = useState("ai");
  const [maxConcurrent, setMaxConcurrent] = useState("5");
  const createCampaign = useCreateCampaign();
  const qc = useQueryClient();
  const { toast } = useToast();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createCampaign.mutate(
      { data: { name, type: type as "outbound" | "inbound", routingType: routingType as "ai" | "human" | "ai_then_human", maxConcurrentCalls: parseInt(maxConcurrent) } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
          toast({ title: "Campaign created" });
          onClose();
        },
        onError: () => toast({ title: "Failed to create campaign", variant: "destructive" }),
      }
    );
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[hsl(224,71%,3%)] border border-border rounded w-full max-w-md">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <p className="text-xs font-mono uppercase tracking-widest text-foreground">New Campaign</p>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} className="font-mono text-sm" required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">Type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger className="font-mono text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="outbound">Outbound</SelectItem>
                  <SelectItem value="inbound">Inbound</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">Routing</Label>
              <Select value={routingType} onValueChange={setRoutingType}>
                <SelectTrigger className="font-mono text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ai">AI</SelectItem>
                  <SelectItem value="human">Human</SelectItem>
                  <SelectItem value="ai_then_human">AI then Human</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Max Concurrent Calls</Label>
            <Input type="number" value={maxConcurrent} onChange={e => setMaxConcurrent(e.target.value)} className="font-mono text-sm" min="1" max="50" />
          </div>
          <Button type="submit" className="w-full font-mono text-xs uppercase tracking-wider" disabled={createCampaign.isPending}>
            {createCampaign.isPending ? "Creating..." : "Create Campaign"}
          </Button>
        </form>
      </div>
    </div>
  );
}

export default function CampaignsPage() {
  const { data: campaigns, isLoading } = useListCampaigns();
  const startCampaign = useStartCampaign();
  const stopCampaign = useStopCampaign();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);

  const handleStart = (id: number) => {
    startCampaign.mutate({ id }, {
      onSuccess: () => { qc.invalidateQueries({ queryKey: getListCampaignsQueryKey() }); toast({ title: "Campaign started" }); },
      onError: () => toast({ title: "Failed to start campaign", variant: "destructive" }),
    });
  };

  const handleStop = (id: number) => {
    stopCampaign.mutate({ id }, {
      onSuccess: () => { qc.invalidateQueries({ queryKey: getListCampaignsQueryKey() }); toast({ title: "Campaign stopped" }); },
      onError: () => toast({ title: "Failed to stop campaign", variant: "destructive" }),
    });
  };

  return (
    <Layout>
      {showCreate && <CreateModal onClose={() => setShowCreate(false)} />}
      <PageHeader
        title="Campaigns"
        subtitle={`${(campaigns ?? []).length} total`}
        action={
          <Button size="sm" className="font-mono text-xs uppercase tracking-wider h-7 px-3" onClick={() => setShowCreate(true)}>
            <Plus className="w-3 h-3 mr-1.5" /> New Campaign
          </Button>
        }
      />
      <div className="p-6">
        <div className="border border-border rounded bg-[hsl(224,71%,3%)] overflow-hidden">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Name</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Type</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Routing</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Concurrent</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Status</th>
                <th className="text-right px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                [...Array(4)].map((_, i) => (
                  <tr key={i}>
                    {[...Array(6)].map((_, j) => (
                      <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>
                    ))}
                  </tr>
                ))
              ) : (campaigns ?? []).map((c: {
                id: number;
                name: string;
                status: string;
                type: string;
                routingType?: string;
                maxConcurrentCalls?: number;
              }) => (
                <tr key={c.id} className="border-b border-border/30 hover:bg-white/2 transition-colors">
                  <td className="px-4 py-3 text-foreground font-medium">{c.name}</td>
                  <td className="px-4 py-3 uppercase text-muted-foreground">{c.type}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.routingType?.replace("_", " ") ?? "-"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.maxConcurrentCalls ?? "-"}</td>
                  <td className="px-4 py-3"><StatusBadge status={c.status} /></td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      {c.status !== "active" ? (
                        <button
                          onClick={() => handleStart(c.id)}
                          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-green-500/30 text-green-400 hover:bg-green-500/10 transition-colors"
                        >
                          <Play className="w-2.5 h-2.5" /> Start
                        </button>
                      ) : (
                        <button
                          onClick={() => handleStop(c.id)}
                          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors"
                        >
                          <Square className="w-2.5 h-2.5" /> Stop
                        </button>
                      )}
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
