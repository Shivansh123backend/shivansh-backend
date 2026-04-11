import { useState, useRef, useCallback } from "react";
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
import { Plus, X, Mic2, Globe, User, Play, Square, Loader2, Volume2 } from "lucide-react";
import { cn } from "@/lib/utils";

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

type Voice = {
  id: number;
  name: string;
  provider: string;
  voiceId: string;
  gender: string;
  accent: string;
  language: string;
  previewUrl?: string | null;
  description?: string | null;
};

// ── Audio player hook ─────────────────────────────────────────────────────────
function useVoicePlayer(toast: ReturnType<typeof useToast>["toast"]) {
  const [playing, setPlaying] = useState<number | null>(null);
  const [loading, setLoading] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setPlaying(null);
  }, []);

  const play = useCallback(async (voice: Voice) => {
    stop();
    if (playing === voice.id) return;
    setLoading(voice.id);

    try {
      let src: string;
      const token = localStorage.getItem("auth_token");
      const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

      if (voice.previewUrl) {
        // Proxy through backend to ensure correct Content-Type (audio/mpeg)
        const response = await fetch(`${baseUrl}/api/voices/${voice.id}/preview`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!response.ok) throw new Error("Preview unavailable");
        const blob = await response.blob();
        src = URL.createObjectURL(blob);
        blobUrlRef.current = src;
      } else {
        const response = await fetch(`${baseUrl}/api/voices/${voice.id}/sample`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ text: "Hello! I'm your AI voice assistant. I'm here to help you with your calls today." }),
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(errData.error ?? "Sample generation failed");
        }
        const blob = await response.blob();
        src = URL.createObjectURL(blob);
        blobUrlRef.current = src;
      }

      const audio = new Audio(src);
      audioRef.current = audio;
      audio.onended = () => { setPlaying(null); audioRef.current = null; };
      audio.onerror = () => {
        setPlaying(null);
        audioRef.current = null;
        toast({ title: "Playback error", description: "Could not play audio", variant: "destructive" });
      };
      await audio.play();
      setPlaying(voice.id);
    } catch (err: unknown) {
      setPlaying(null);
      toast({
        title: "Preview unavailable",
        description: err instanceof Error ? err.message : "Could not generate voice sample",
        variant: "destructive",
      });
    } finally {
      setLoading(null);
    }
  }, [playing, stop, toast]);

  return { playing, loading, play, stop };
}

// Real ElevenLabs voice IDs are 20+ alphanumeric chars with no underscores
function isRealVoiceId(voiceId: string) {
  return /^[a-zA-Z0-9]{15,}$/.test(voiceId);
}

// ── Voice card ─────────────────────────────────────────────────────────────────
function VoiceCard({
  voice,
  playing,
  loading,
  onPlay,
  onStop,
}: {
  voice: Voice;
  playing: boolean;
  loading: boolean;
  onPlay: () => void;
  onStop: () => void;
}) {
  const hasPreview = !!voice.previewUrl;
  const canGenerate = !hasPreview && voice.provider === "elevenlabs" && isRealVoiceId(voice.voiceId);
  const canPlay = hasPreview || canGenerate;

  return (
    <div className={cn(
      "border rounded bg-[hsl(224,71%,3%)] p-4 space-y-3 transition-all",
      playing ? "border-primary/40 shadow-[0_0_12px_rgba(0,255,255,0.08)]" : "border-border"
    )}>
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <div className={cn(
            "w-7 h-7 rounded flex items-center justify-center transition-all",
            playing ? "bg-primary/20" : "bg-primary/10"
          )}>
            {playing
              ? <Volume2 className="w-3.5 h-3.5 text-primary animate-pulse" />
              : <Mic2 className="w-3.5 h-3.5 text-primary" />}
          </div>
          <div>
            <p className="text-sm font-mono font-medium text-foreground leading-tight">{voice.name}</p>
            <p className="text-[10px] font-mono text-muted-foreground uppercase">
              {PROVIDER_LABELS[voice.provider] ?? voice.provider}
            </p>
          </div>
        </div>
        <span className={cn(
          "text-[10px] font-mono px-1.5 py-0.5 rounded border",
          voice.gender === "female"
            ? "border-pink-500/30 text-pink-400 bg-pink-500/5"
            : "border-blue-500/30 text-blue-400 bg-blue-500/5"
        )}>
          {voice.gender}
        </span>
      </div>

      {/* Meta */}
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground">
          <User className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">{voice.voiceId}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground">
          <Globe className="w-3 h-3 flex-shrink-0" />
          <span>{ACCENT_LABELS[voice.accent] ?? voice.accent} accent · {voice.language.toUpperCase()}</span>
        </div>
        {voice.description && (
          <p className="text-[10px] font-mono text-muted-foreground/60 truncate">{voice.description}</p>
        )}
      </div>

      {/* Waveform visualizer while playing */}
      {playing && (
        <div className="flex items-end gap-0.5 h-5 px-1">
          {[...Array(16)].map((_, i) => (
            <div
              key={i}
              className="flex-1 bg-primary/60 rounded-sm"
              style={{
                height: `${30 + Math.sin(i * 0.8) * 50}%`,
                animation: `wave ${0.5 + (i % 3) * 0.15}s ease-in-out infinite alternate`,
                animationDelay: `${i * 0.04}s`,
              }}
            />
          ))}
        </div>
      )}

      {/* Play / Stop button */}
      {canPlay ? (
        <button
          onClick={playing ? onStop : onPlay}
          disabled={loading}
          className={cn(
            "w-full flex items-center justify-center gap-1.5 py-1.5 rounded text-[11px] font-mono border transition-all",
            playing
              ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15"
              : "border-border bg-white/5 text-muted-foreground hover:text-foreground hover:bg-white/10",
            loading && "opacity-70 cursor-not-allowed"
          )}
        >
          {loading ? (
            <><Loader2 className="w-3 h-3 animate-spin" />Generating…</>
          ) : playing ? (
            <><Square className="w-3 h-3" />Stop</>
          ) : (
            <><Play className="w-3 h-3" />{hasPreview ? "Play Sample" : "Generate Sample"}</>
          )}
        </button>
      ) : (
        <div className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded text-[11px] font-mono border border-border/30 text-muted-foreground/40 cursor-not-allowed select-none">
          <Mic2 className="w-3 h-3" />No preview available
        </div>
      )}
    </div>
  );
}

// ── Add voice modal ───────────────────────────────────────────────────────────
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
            <Input value={name} onChange={e => setName(e.target.value)} className="font-mono text-sm" placeholder="e.g. Sarah US Female" required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">Provider</Label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger className="font-mono text-sm"><SelectValue /></SelectTrigger>
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
                <SelectTrigger className="font-mono text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="female">Female</SelectItem>
                  <SelectItem value="male">Male</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Voice ID</Label>
            <Input value={voiceId} onChange={e => setVoiceId(e.target.value)} className="font-mono text-sm" placeholder="e.g. EXAVITQu4vr4xnSDxMaL" required />
            <p className="text-[10px] text-muted-foreground font-mono">The provider-specific voice identifier used in API calls</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">Accent</Label>
              <Select value={accent} onValueChange={setAccent}>
                <SelectTrigger className="font-mono text-sm"><SelectValue /></SelectTrigger>
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
              <Input value={language} onChange={e => setLanguage(e.target.value)} className="font-mono text-sm" placeholder="en" />
            </div>
          </div>
          <Button type="submit" className="w-full font-mono text-xs uppercase tracking-wider" disabled={createVoice.isPending}>
            {createVoice.isPending ? "Adding..." : "Add Voice"}
          </Button>
        </form>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function VoicesPage() {
  const { data: voices, isLoading } = useListVoices();
  const [showAdd, setShowAdd] = useState(false);
  const { toast } = useToast();
  const { playing, loading, play, stop } = useVoicePlayer(toast);

  return (
    <Layout>
      {showAdd && <AddVoiceModal onClose={() => setShowAdd(false)} />}

      {/* CSS for waveform animation */}
      <style>{`
        @keyframes wave {
          from { transform: scaleY(0.4); }
          to   { transform: scaleY(1); }
        }
      `}</style>

      <PageHeader
        title="Voices"
        subtitle={`${(voices ?? []).length} voice${(voices ?? []).length !== 1 ? "s" : ""} configured`}
        action={
          <Button size="sm" className="font-mono text-xs uppercase tracking-wider h-7 px-3" onClick={() => setShowAdd(true)}>
            <Plus className="w-3 h-3 mr-1.5" /> Add Voice
          </Button>
        }
      />

      <div className="p-6">
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-36 rounded" />)}
          </div>
        ) : (voices ?? []).length === 0 ? (
          <div className="border border-dashed border-border rounded p-12 text-center">
            <Mic2 className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm font-mono text-muted-foreground">No voices configured yet</p>
            <p className="text-xs font-mono text-muted-foreground/60 mt-1">Add a voice to use with your AI campaigns</p>
            <Button size="sm" className="mt-4 font-mono text-xs uppercase tracking-wider h-7 px-3" onClick={() => setShowAdd(true)}>
              <Plus className="w-3 h-3 mr-1.5" /> Add First Voice
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {(voices as Voice[] ?? []).map(v => (
              <VoiceCard
                key={v.id}
                voice={v}
                playing={playing === v.id}
                loading={loading === v.id}
                onPlay={() => play(v)}
                onStop={stop}
              />
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
