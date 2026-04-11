import { useState } from "react";
import {
  useListCampaigns,
  useStartCampaign,
  useStopCampaign,
  useCreateCampaign,
  useListVoices,
  useListNumbers,
  useListLeads,
  getListCampaignsQueryKey,
  customFetch,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Layout, PageHeader } from "@/components/layout";
import { StatusBadge } from "./dashboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Play, Square, Plus, X, Rocket, Phone, Mic2, Users, FileText } from "lucide-react";

type Campaign = {
  id: number;
  name: string;
  status: string;
  type: string;
  routingType?: string;
  maxConcurrentCalls?: number;
  voice?: string;
  fromNumber?: string;
  agentPrompt?: string;
};

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
      {
        data: {
          name,
          type: type as "outbound" | "inbound",
          routingType: routingType as "ai" | "human" | "ai_then_human",
          maxConcurrentCalls: parseInt(maxConcurrent),
        },
      },
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
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="font-mono text-sm" required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">Type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger className="font-mono text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="outbound">Outbound</SelectItem>
                  <SelectItem value="inbound">Inbound</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">Routing</Label>
              <Select value={routingType} onValueChange={setRoutingType}>
                <SelectTrigger className="font-mono text-sm">
                  <SelectValue />
                </SelectTrigger>
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
            <Input
              type="number"
              value={maxConcurrent}
              onChange={(e) => setMaxConcurrent(e.target.value)}
              className="font-mono text-sm"
              min="1"
              max="50"
            />
          </div>
          <Button
            type="submit"
            className="w-full font-mono text-xs uppercase tracking-wider"
            disabled={createCampaign.isPending}
          >
            {createCampaign.isPending ? "Creating..." : "Create Campaign"}
          </Button>
        </form>
      </div>
    </div>
  );
}

function LaunchModal({
  campaign,
  onClose,
  onLaunched,
}: {
  campaign: Campaign;
  onClose: () => void;
  onLaunched: () => void;
}) {
  const { data: voices } = useListVoices();
  const { data: numbers } = useListNumbers();
  const { data: leads } = useListLeads({ campaignId: campaign.id });
  const startCampaign = useStartCampaign();
  const { toast } = useToast();

  const [selectedNumber, setSelectedNumber] = useState(campaign.fromNumber ?? "");
  const [selectedVoice, setSelectedVoice] = useState(campaign.voice ?? "");
  const [prompt, setPrompt] = useState(
    campaign.agentPrompt ?? `You are a professional AI voice agent making an outbound call. Follow these steps:

1. GREETING: Introduce yourself warmly — "Hello, I'm an AI assistant calling on behalf of our team. Am I speaking with [Lead Name]?"

2. CONFIRM DETAILS: Verify the contact's information one by one:
   - Full name: "Could you please confirm your full name?"
   - Phone number: "Is this still the best number to reach you?"
   - Email address: "Could you confirm or provide your email address?"
   - Address: "Could you confirm your current mailing or home address?"

3. PURPOSE: After confirming their details, proceed with the reason for your call and assist them.

4. TONE: Always be warm, professional, and concise. Never rush the contact.

5. OPT-OUT: If the contact asks to be removed from the list, acknowledge immediately, apologise for the interruption, and end the call respectfully.

6. UNAVAILABLE: If the contact is unavailable or requests a callback, note their preferred time and close politely.`
  );
  const [isLaunching, setIsLaunching] = useState(false);
  const [resetLeads, setResetLeads] = useState(false);

  const pendingLeads = (leads ?? []).filter((l: { status: string }) => l.status === "pending");
  const calledLeads = (leads ?? []).filter((l: { status: string }) => ["called", "callback", "completed"].includes(l.status));
  const totalLeads = (leads ?? []).length;

  const effectivePending = resetLeads ? pendingLeads.length + calledLeads.length : pendingLeads.length;
  const canLaunch = effectivePending > 0;

  const handleLaunch = async () => {
    setIsLaunching(true);
    try {
      await customFetch(`/api/campaigns/${campaign.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voice: selectedVoice || undefined,
          fromNumber: selectedNumber || undefined,
          agentPrompt: prompt || undefined,
        }),
      });

      if (resetLeads && calledLeads.length > 0) {
        await customFetch(`/api/campaigns/${campaign.id}/reset-leads`, { method: "POST" });
      }

      await new Promise<void>((resolve, reject) => {
        startCampaign.mutate(
          { id: campaign.id },
          {
            onSuccess: () => resolve(),
            onError: reject,
          }
        );
      });

      toast({ title: `Campaign "${campaign.name}" launched`, description: `Calling ${effectivePending} leads` });
      onLaunched();
      onClose();
    } catch {
      toast({ title: "Failed to launch campaign", variant: "destructive" });
    } finally {
      setIsLaunching(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[hsl(224,71%,3%)] border border-border rounded w-full max-w-lg">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Rocket className="w-3.5 h-3.5 text-primary" />
            <p className="text-xs font-mono uppercase tracking-widest text-foreground">Launch Campaign</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="bg-primary/5 border border-primary/20 rounded p-3 flex items-center justify-between">
            <p className="text-sm font-mono font-medium text-foreground">{campaign.name}</p>
            <div className="flex items-center gap-3 text-[10px] font-mono text-muted-foreground">
              <span className="flex items-center gap-1">
                <Users className="w-3 h-3" />
                {totalLeads} leads total
              </span>
              <span className={`flex items-center gap-1 ${pendingLeads.length > 0 ? "text-green-400" : "text-yellow-400"}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${pendingLeads.length > 0 ? "bg-green-400" : "bg-yellow-400"}`} />
                {pendingLeads.length} pending
              </span>
            </div>
          </div>

          {pendingLeads.length === 0 && totalLeads > 0 && (
            <div className="border border-yellow-500/20 bg-yellow-500/5 rounded p-3 space-y-2">
              <p className="text-xs font-mono text-yellow-400">
                All {calledLeads.length} leads have already been called. Enable "Re-call all leads" to call them again.
              </p>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={resetLeads}
                  onChange={e => setResetLeads(e.target.checked)}
                  className="accent-primary"
                />
                <span className="text-xs font-mono text-foreground">Re-call all leads (reset to pending)</span>
              </label>
            </div>
          )}
          {pendingLeads.length === 0 && totalLeads === 0 && (
            <div className="border border-yellow-500/20 bg-yellow-500/5 rounded p-3 text-xs font-mono text-yellow-400">
              No leads in this campaign yet. Add leads from the Leads page first.
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground flex items-center gap-1.5">
              <Phone className="w-3 h-3" /> Caller Number (From)
            </Label>
            <Select value={selectedNumber} onValueChange={setSelectedNumber}>
              <SelectTrigger className="font-mono text-sm">
                <SelectValue placeholder="Select a phone number..." />
              </SelectTrigger>
              <SelectContent>
                {(numbers ?? []).length === 0 ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground font-mono">No numbers configured — add DIDs first</div>
                ) : (
                  (numbers ?? []).map((n: { id: number; phoneNumber: string; provider: string; status: string }) => (
                    <SelectItem key={n.id} value={n.phoneNumber}>
                      {n.phoneNumber}
                      <span className="ml-2 text-muted-foreground text-[10px]">{n.provider} · {n.status}</span>
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            {(numbers ?? []).length === 0 && (
              <p className="text-[10px] font-mono text-muted-foreground">
                Go to <span className="text-primary">DIDs</span> in the sidebar to add phone numbers
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground flex items-center gap-1.5">
              <Mic2 className="w-3 h-3" /> Voice
            </Label>
            <Select value={selectedVoice} onValueChange={setSelectedVoice}>
              <SelectTrigger className="font-mono text-sm">
                <SelectValue placeholder="Select a voice..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">default (system voice)</SelectItem>
                {(voices ?? []).map((v: { id: number; name: string; voiceId: string; gender: string; accent: string }) => (
                  <SelectItem key={v.id} value={v.voiceId}>
                    {v.name}
                    <span className="ml-2 text-muted-foreground text-[10px]">{v.gender} · {v.accent}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(voices ?? []).length === 0 && (
              <p className="text-[10px] font-mono text-muted-foreground">
                Go to <span className="text-primary">Voices</span> in the sidebar to add AI voices
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground flex items-center gap-1.5">
              <FileText className="w-3 h-3" /> Agent Prompt / Script
            </Label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="font-mono text-xs min-h-[100px] resize-none"
              placeholder="Describe what the agent should do — e.g. greet the contact, confirm their name / phone / email / address, then explain the purpose of the call..."
            />
            <p className="text-[10px] text-muted-foreground font-mono">
              This is what the AI will say when the call connects
            </p>
          </div>

          <div className="flex gap-2 pt-1">
            <Button
              variant="outline"
              className="flex-1 font-mono text-xs uppercase tracking-wider"
              onClick={onClose}
              disabled={isLaunching}
            >
              Cancel
            </Button>
            <Button
              className="flex-1 font-mono text-xs uppercase tracking-wider bg-green-600 hover:bg-green-700 text-white"
              onClick={handleLaunch}
              disabled={isLaunching || !canLaunch}
            >
              {isLaunching ? (
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                  Launching...
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <Rocket className="w-3 h-3" />
                  Launch Campaign
                </span>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function CampaignsPage() {
  const { data: campaigns, isLoading } = useListCampaigns();
  const stopCampaign = useStopCampaign();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [launchingCampaign, setLaunchingCampaign] = useState<Campaign | null>(null);

  const handleStop = (id: number) => {
    stopCampaign.mutate(
      { id },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
          toast({ title: "Campaign stopped" });
        },
        onError: () => toast({ title: "Failed to stop campaign", variant: "destructive" }),
      }
    );
  };

  const handleLaunched = () => {
    qc.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
  };

  return (
    <Layout>
      {showCreate && <CreateModal onClose={() => setShowCreate(false)} />}
      {launchingCampaign && (
        <LaunchModal
          campaign={launchingCampaign}
          onClose={() => setLaunchingCampaign(null)}
          onLaunched={handleLaunched}
        />
      )}
      <PageHeader
        title="Campaigns"
        subtitle={`${(campaigns ?? []).length} total`}
        action={
          <Button
            size="sm"
            className="font-mono text-xs uppercase tracking-wider h-7 px-3"
            onClick={() => setShowCreate(true)}
          >
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
                      <td key={j} className="px-4 py-3">
                        <Skeleton className="h-4 w-full" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : (campaigns ?? []).map((c: Campaign) => (
                <tr key={c.id} className="border-b border-border/30 hover:bg-white/2 transition-colors">
                  <td className="px-4 py-3 text-foreground font-medium">{c.name}</td>
                  <td className="px-4 py-3 uppercase text-muted-foreground">{c.type}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.routingType?.replace("_", " ") ?? "-"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.maxConcurrentCalls ?? "-"}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      {c.status !== "active" ? (
                        <button
                          onClick={() => setLaunchingCampaign(c)}
                          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-green-500/30 text-green-400 hover:bg-green-500/10 transition-colors"
                        >
                          <Rocket className="w-2.5 h-2.5" /> Launch
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
