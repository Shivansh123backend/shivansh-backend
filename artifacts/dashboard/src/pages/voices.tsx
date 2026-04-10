import { useState } from "react";
import {
  useListVoices,
  useCreateVoice,
  getListVoicesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Layout, PageHeader } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Plus, X, Mic2, Globe, User } from "lucide-react";

const PROVIDER_LABELS: Record<string, string> = {
  elevenlabs: "ElevenLabs",
  playht: "PlayHT",
  azure: "Azure",
};

const ACCENT_LABELS: Record<string, string> = {
  us: "US",
  uk: "UK",
  indian: "Indian",
  australian: "Australian",
  canadian: "Canadian",
  other: "Other",
};

function AddVoiceModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("elevenlabs");
  const [voiceId, setVoiceId] = useState("");
  const [gender, setGender] = useState("female");
  const [accent, setAccent] = useState("us");
  const [language, setLanguage] = useState("en");
  const createVoice = useCreateVoice();
  const qc = useQueryClient();
  const { toast } = useToast();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createVoice.mutate(
      {
        data: {
          name,
          provider: provider as "elevenlabs" | "playht" | "azure",
          voiceId,
          gender: gender as "male" | "female",
          accent: accent as "us" | "uk" | "indian" | "australian" | "canadian" | "other",
          language,
        },
      },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListVoicesQueryKey() });
          toast({ title: "Voice added successfully" });
          onClose();
        },
        onError: () => toast({ title: "Failed to add voice", variant: "destructive" }),
      }
    );
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[hsl(224,71%,3%)] border border-border rounded w-full max-w-md">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <p className="text-xs font-mono uppercase tracking-widest text-foreground">Add Voice</p>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Display Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="font-mono text-sm"
              placeholder="e.g. Sarah US Female"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">Provider</Label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger className="font-mono text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="elevenlabs">ElevenLabs</SelectItem>
                  <SelectItem value="playht">PlayHT</SelectItem>
                  <SelectItem value="azure">Azure</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">Gender</Label>
              <Select value={gender} onValueChange={setGender}>
                <SelectTrigger className="font-mono text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="female">Female</SelectItem>
                  <SelectItem value="male">Male</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Voice ID</Label>
            <Input
              value={voiceId}
              onChange={(e) => setVoiceId(e.target.value)}
              className="font-mono text-sm"
              placeholder="e.g. EXAVITQu4vr4xnSDxMaL (ElevenLabs voice ID)"
              required
            />
            <p className="text-[10px] text-muted-foreground font-mono">
              The provider-specific voice identifier used in API calls
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">Accent</Label>
              <Select value={accent} onValueChange={setAccent}>
                <SelectTrigger className="font-mono text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="us">US</SelectItem>
                  <SelectItem value="uk">UK</SelectItem>
                  <SelectItem value="indian">Indian</SelectItem>
                  <SelectItem value="australian">Australian</SelectItem>
                  <SelectItem value="canadian">Canadian</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">Language Code</Label>
              <Input
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="font-mono text-sm"
                placeholder="en"
              />
            </div>
          </div>

          <Button
            type="submit"
            className="w-full font-mono text-xs uppercase tracking-wider"
            disabled={createVoice.isPending}
          >
            {createVoice.isPending ? "Adding..." : "Add Voice"}
          </Button>
        </form>
      </div>
    </div>
  );
}

export default function VoicesPage() {
  const { data: voices, isLoading } = useListVoices();
  const [showAdd, setShowAdd] = useState(false);

  return (
    <Layout>
      {showAdd && <AddVoiceModal onClose={() => setShowAdd(false)} />}
      <PageHeader
        title="Voices"
        subtitle={`${(voices ?? []).length} voice${(voices ?? []).length !== 1 ? "s" : ""} configured`}
        action={
          <Button
            size="sm"
            className="font-mono text-xs uppercase tracking-wider h-7 px-3"
            onClick={() => setShowAdd(true)}
          >
            <Plus className="w-3 h-3 mr-1.5" /> Add Voice
          </Button>
        }
      />
      <div className="p-6">
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => (
              <Skeleton key={i} className="h-28 rounded" />
            ))}
          </div>
        ) : (voices ?? []).length === 0 ? (
          <div className="border border-dashed border-border rounded p-12 text-center">
            <Mic2 className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm font-mono text-muted-foreground">No voices configured yet</p>
            <p className="text-xs font-mono text-muted-foreground/60 mt-1">
              Add a voice to use with your AI campaigns
            </p>
            <Button
              size="sm"
              className="mt-4 font-mono text-xs uppercase tracking-wider h-7 px-3"
              onClick={() => setShowAdd(true)}
            >
              <Plus className="w-3 h-3 mr-1.5" /> Add First Voice
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {(voices ?? []).map((v: {
              id: number;
              name: string;
              provider: string;
              voiceId: string;
              gender: string;
              accent: string;
              language: string;
            }) => (
              <div
                key={v.id}
                className="border border-border rounded bg-[hsl(224,71%,3%)] p-4 space-y-3"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded bg-primary/10 flex items-center justify-center">
                      <Mic2 className="w-3.5 h-3.5 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-mono font-medium text-foreground">{v.name}</p>
                      <p className="text-[10px] font-mono text-muted-foreground uppercase">
                        {PROVIDER_LABELS[v.provider] ?? v.provider}
                      </p>
                    </div>
                  </div>
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                    v.gender === "female"
                      ? "border-pink-500/30 text-pink-400 bg-pink-500/5"
                      : "border-blue-500/30 text-blue-400 bg-blue-500/5"
                  }`}>
                    {v.gender}
                  </span>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground">
                    <User className="w-3 h-3" />
                    <span className="truncate">{v.voiceId}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground">
                    <Globe className="w-3 h-3" />
                    <span>{ACCENT_LABELS[v.accent] ?? v.accent} accent · {v.language.toUpperCase()}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
