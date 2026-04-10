import { useState } from "react";
import {
  useListAgents,
  useCreateAgent,
  useListVoices,
  getListAgentsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Layout, PageHeader } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Plus, X, Bot, Mic } from "lucide-react";

function CreateModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [language, setLanguage] = useState("en");
  const [defaultVoiceId, setDefaultVoiceId] = useState("");
  const createAgent = useCreateAgent();
  const { data: voices } = useListVoices();
  const qc = useQueryClient();
  const { toast } = useToast();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createAgent.mutate(
      { data: { name, prompt, language, defaultVoiceId: defaultVoiceId ? parseInt(defaultVoiceId) : undefined } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListAgentsQueryKey() });
          toast({ title: "AI Agent created" });
          onClose();
        },
        onError: () => toast({ title: "Failed to create agent", variant: "destructive" }),
      }
    );
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[hsl(224,71%,3%)] border border-border rounded w-full max-w-lg">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <p className="text-xs font-mono uppercase tracking-widest text-foreground">New AI Agent</p>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Agent Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} className="font-mono text-sm" required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">Language</Label>
              <Input value={language} onChange={e => setLanguage(e.target.value)} className="font-mono text-sm" placeholder="en" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">Default Voice</Label>
              <Select value={defaultVoiceId} onValueChange={setDefaultVoiceId}>
                <SelectTrigger className="font-mono text-sm"><SelectValue placeholder="Select voice" /></SelectTrigger>
                <SelectContent>
                  {(voices ?? []).map((v: { id: number; name: string; provider: string }) => (
                    <SelectItem key={v.id} value={String(v.id)}>{v.name} ({v.provider})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">System Prompt</Label>
            <Textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              className="font-mono text-sm min-h-[120px] resize-none"
              placeholder="You are a professional sales representative..."
              required
            />
          </div>
          <Button type="submit" className="w-full font-mono text-xs uppercase tracking-wider" disabled={createAgent.isPending}>
            {createAgent.isPending ? "Creating..." : "Deploy Agent"}
          </Button>
        </form>
      </div>
    </div>
  );
}

export default function AgentsPage() {
  const { data: agents, isLoading } = useListAgents();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <Layout>
      {showCreate && <CreateModal onClose={() => setShowCreate(false)} />}
      <PageHeader
        title="AI Agents"
        subtitle={`${(agents ?? []).length} deployed`}
        action={
          <Button size="sm" className="font-mono text-xs uppercase tracking-wider h-7 px-3" onClick={() => setShowCreate(true)}>
            <Plus className="w-3 h-3 mr-1.5" /> New Agent
          </Button>
        }
      />
      <div className="p-6">
        {isLoading ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-40 w-full rounded" />)}
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {(agents ?? []).map((a: {
              id: number;
              name: string;
              prompt: string;
              language: string;
              defaultVoiceId?: number;
            }) => (
              <div key={a.id} className="border border-border rounded bg-[hsl(224,71%,3%)] p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded bg-primary/15 border border-primary/25 flex items-center justify-center flex-shrink-0">
                      <Bot className="w-3.5 h-3.5 text-primary" />
                    </div>
                    <div>
                      <p className="text-xs font-mono font-semibold text-foreground">{a.name}</p>
                      <p className="text-[10px] font-mono text-muted-foreground uppercase">{a.language}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {a.defaultVoiceId && (
                      <Badge variant="outline" className="text-[9px] font-mono border-primary/30 text-primary/70">
                        <Mic className="w-2 h-2 mr-1" /> Voice #{a.defaultVoiceId}
                      </Badge>
                    )}
                  </div>
                </div>
                <p className="text-[11px] font-mono text-muted-foreground leading-relaxed line-clamp-3">{a.prompt}</p>
                <div className="pt-1 border-t border-border/50">
                  <p className="text-[10px] font-mono text-muted-foreground/60">Agent ID #{a.id}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
