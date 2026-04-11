import { useState, useRef, useCallback } from "react";
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Layout, PageHeader } from "@/components/layout";
import { StatusBadge } from "./dashboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  Play, Square, Plus, X, Rocket, Phone, Mic2, Users, FileText,
  ChevronRight, ChevronLeft, BookOpen, Upload, Volume2, Pause,
  Check, RefreshCw, Brain, Music
} from "lucide-react";

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
  knowledgeBase?: string;
  recordingNotes?: string;
};

type ElevenLabsVoice = {
  voice_id: string;
  name: string;
  preview_url?: string;
  labels?: Record<string, string>;
};

// ── Tiny audio preview hook ────────────────────────────────────────────────────
function useAudioPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  const play = useCallback((url: string, id: string) => {
    if (audioRef.current) {
      audioRef.current.pause();
    }
    if (playing === id) {
      setPlaying(null);
      return;
    }
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.onended = () => setPlaying(null);
    audio.onerror = () => setPlaying(null);
    audio.play().catch(() => setPlaying(null));
    setPlaying(id);
  }, [playing]);

  const stop = useCallback(() => {
    if (audioRef.current) audioRef.current.pause();
    setPlaying(null);
  }, []);

  return { playing, play, stop };
}

// ── Voice picker with play button ─────────────────────────────────────────────
function VoicePicker({
  value,
  onChange,
  dbVoices,
  elVoices,
  elLoading,
}: {
  value: string;
  onChange: (v: string) => void;
  dbVoices: Array<{ id: number; name: string; voiceId: string; gender: string; accent: string; previewUrl?: string; description?: string }>;
  elVoices: ElevenLabsVoice[];
  elLoading: boolean;
}) {
  const { playing, play } = useAudioPlayer();
  const allVoices = elVoices.length > 0 ? elVoices.map(v => ({
    id: v.voice_id,
    voiceId: v.voice_id,
    name: v.name,
    previewUrl: v.preview_url,
    gender: v.labels?.gender ?? "female",
    accent: v.labels?.accent ?? "us",
    description: [v.labels?.description, v.labels?.use_case, v.labels?.age].filter(Boolean).join(", "),
  })) : dbVoices.map(v => ({ ...v, id: String(v.id) }));

  return (
    <div className="space-y-2">
      {elLoading && (
        <div className="text-[10px] font-mono text-muted-foreground flex items-center gap-1.5">
          <RefreshCw className="w-3 h-3 animate-spin" /> Loading ElevenLabs voices...
        </div>
      )}
      <div className="grid grid-cols-1 gap-1.5 max-h-[280px] overflow-y-auto pr-1">
        <button
          type="button"
          onClick={() => onChange("default")}
          className={`text-left px-3 py-2 rounded border text-xs font-mono transition-colors ${
            value === "default"
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border hover:border-border/80 text-muted-foreground"
          }`}
        >
          <span className="font-medium">default</span>
          <span className="ml-2 text-[10px] opacity-60">system voice</span>
        </button>
        {allVoices.map(v => (
          <div
            key={v.voiceId}
            className={`flex items-center gap-2 px-3 py-2 rounded border cursor-pointer transition-colors ${
              value === v.voiceId
                ? "border-primary bg-primary/10"
                : "border-border hover:border-border/80"
            }`}
            onClick={() => onChange(v.voiceId)}
          >
            <div className="flex-1 min-w-0">
              <p className="text-xs font-mono font-medium text-foreground truncate">{v.name}</p>
              {v.description && (
                <p className="text-[10px] font-mono text-muted-foreground truncate">{v.description}</p>
              )}
              <p className="text-[10px] font-mono text-muted-foreground">{v.gender} · {v.accent}</p>
            </div>
            {v.previewUrl && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); play(v.previewUrl!, v.voiceId); }}
                className="shrink-0 w-7 h-7 flex items-center justify-center rounded bg-primary/20 hover:bg-primary/40 text-primary transition-colors"
                title="Preview voice"
              >
                {playing === v.voiceId
                  ? <Pause className="w-3 h-3" />
                  : <Play className="w-3 h-3" />
                }
              </button>
            )}
            {value === v.voiceId && (
              <Check className="shrink-0 w-3.5 h-3.5 text-primary" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── File upload helper ─────────────────────────────────────────────────────────
function FileUploadArea({
  label,
  accept,
  onContent,
  hint,
}: {
  label: string;
  accept: string;
  onContent: (text: string, name: string) => void;
  hint?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    if (file.type.startsWith("audio/")) {
      onContent(`[Audio recording: ${file.name}]\nKey insights from this recording should be extracted and applied to the agent's behavior.`, file.name);
      return;
    }
    const text = await file.text();
    onContent(text, file.name);
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="w-full border border-dashed border-border hover:border-primary/50 rounded px-3 py-2.5 flex items-center gap-2 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
      >
        <Upload className="w-3.5 h-3.5 shrink-0" />
        <span>{label}</span>
      </button>
      {hint && <p className="text-[10px] font-mono text-muted-foreground mt-1">{hint}</p>}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}

// ── 3-step Create Campaign Modal ───────────────────────────────────────────────
function CreateModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const steps = ["Basics", "Agent Training", "Voice & Number"];

  // Step 1 — Basics
  const [name, setName] = useState("");
  const [type, setType] = useState("outbound");
  const [routingType, setRoutingType] = useState("ai");
  const [maxConcurrent, setMaxConcurrent] = useState("5");

  // Step 2 — Agent Training
  const [knowledgeBase, setKnowledgeBase] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [recordingNotes, setRecordingNotes] = useState("");

  // Step 3 — Voice & Number
  const [selectedVoice, setSelectedVoice] = useState("default");
  const [selectedNumber, setSelectedNumber] = useState("");

  const { data: dbVoices } = useListVoices() as { data: Array<{ id: number; name: string; voiceId: string; gender: string; accent: string; previewUrl?: string; description?: string }> | undefined };
  const { data: numbers } = useListNumbers() as { data: Array<{ id: number; phoneNumber: string; provider: string; status: string }> | undefined };
  const { data: elVoices = [], isLoading: elLoading } = useQuery<ElevenLabsVoice[]>({
    queryKey: ["elevenlabs-voices"],
    queryFn: () => customFetch("/api/voices/elevenlabs") as Promise<ElevenLabsVoice[]>,
    retry: false,
  });

  const createCampaign = useCreateCampaign();
  const qc = useQueryClient();
  const { toast } = useToast();

  const handleSubmit = () => {
    createCampaign.mutate(
      {
        data: {
          name,
          type: type as "outbound" | "inbound",
          routingType: routingType as "ai" | "human" | "ai_then_human",
          maxConcurrentCalls: parseInt(maxConcurrent),
          agentPrompt: agentPrompt || undefined,
          knowledgeBase: knowledgeBase || undefined,
          recordingNotes: recordingNotes || undefined,
          voice: selectedVoice !== "default" ? selectedVoice : undefined,
          fromNumber: selectedNumber || undefined,
        } as Parameters<typeof createCampaign.mutate>[0]["data"],
      },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
          toast({ title: "Campaign created successfully" });
          onClose();
        },
        onError: () => toast({ title: "Failed to create campaign", variant: "destructive" }),
      }
    );
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[hsl(224,71%,3%)] border border-border rounded w-full max-w-xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <p className="text-xs font-mono uppercase tracking-widest text-foreground">New Campaign</p>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Step tabs */}
        <div className="flex border-b border-border shrink-0">
          {steps.map((s, i) => (
            <button
              key={i}
              type="button"
              onClick={() => i < step && setStep(i)}
              className={`flex-1 px-3 py-2 text-[10px] font-mono uppercase tracking-wider flex items-center justify-center gap-1.5 transition-colors ${
                i === step
                  ? "text-primary border-b-2 border-primary"
                  : i < step
                  ? "text-green-400 cursor-pointer hover:text-green-300"
                  : "text-muted-foreground cursor-default"
              }`}
            >
              {i < step ? <Check className="w-2.5 h-2.5" /> : <span className="w-3.5 h-3.5 rounded-full border border-current inline-flex items-center justify-center text-[8px]">{i+1}</span>}
              {s}
            </button>
          ))}
        </div>

        {/* Step content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">

          {/* ── Step 0: Basics ── */}
          {step === 0 && (
            <>
              <div className="space-y-1.5">
                <Label className="text-[10px] font-mono uppercase text-muted-foreground">Campaign Name</Label>
                <Input value={name} onChange={e => setName(e.target.value)} className="font-mono text-sm" placeholder="e.g. Q2 Sales Outreach" required />
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
                      <SelectItem value="ai">AI Only</SelectItem>
                      <SelectItem value="human">Human Only</SelectItem>
                      <SelectItem value="ai_then_human">AI then Human</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] font-mono uppercase text-muted-foreground">Max Concurrent Calls</Label>
                <Input type="number" value={maxConcurrent} onChange={e => setMaxConcurrent(e.target.value)} className="font-mono text-sm" min="1" max="50" />
              </div>
            </>
          )}

          {/* ── Step 1: Agent Training ── */}
          {step === 1 && (
            <>
              {/* Knowledge Base / SOPs */}
              <div className="space-y-2">
                <Label className="text-[10px] font-mono uppercase text-muted-foreground flex items-center gap-1.5">
                  <BookOpen className="w-3 h-3" /> Knowledge Base / SOPs
                </Label>
                <FileUploadArea
                  label="Upload SOP document (.txt, .pdf, .docx)..."
                  accept=".txt,.pdf,.docx,.doc,.md"
                  hint="Text is extracted and added to the agent's knowledge"
                  onContent={(text, name) => {
                    setKnowledgeBase(prev => prev ? `${prev}\n\n--- ${name} ---\n${text}` : `--- ${name} ---\n${text}`);
                    toast({ title: `Loaded: ${name}` });
                  }}
                />
                <Textarea
                  value={knowledgeBase}
                  onChange={e => setKnowledgeBase(e.target.value)}
                  className="font-mono text-xs min-h-[100px] resize-none"
                  placeholder="Paste your SOPs, product knowledge, FAQs, objection-handling guides here...&#10;&#10;This context will be provided to the AI agent before every call."
                />
              </div>

              {/* Script / Prompt Override */}
              <div className="space-y-2">
                <Label className="text-[10px] font-mono uppercase text-muted-foreground flex items-center gap-1.5">
                  <Brain className="w-3 h-3" /> Call Script / Agent Prompt
                </Label>
                <FileUploadArea
                  label="Upload script file (.txt, .md)..."
                  accept=".txt,.md,.docx"
                  hint="Replaces the default agent prompt"
                  onContent={(text) => { setAgentPrompt(text); toast({ title: "Script loaded" }); }}
                />
                <Textarea
                  value={agentPrompt}
                  onChange={e => setAgentPrompt(e.target.value)}
                  className="font-mono text-xs min-h-[120px] resize-none"
                  placeholder="Write or paste the agent's call script here...&#10;&#10;Example:&#10;GREETING: 'Hello, is this [Name]? Great, I'm calling from...'&#10;PURPOSE: Explain why you're calling&#10;CLOSE: Thank them for their time&#10;&#10;Leave blank to use the default professional prompt."
                />
              </div>

              {/* Recordings */}
              <div className="space-y-2">
                <Label className="text-[10px] font-mono uppercase text-muted-foreground flex items-center gap-1.5">
                  <Music className="w-3 h-3" /> Training Recordings / Examples
                </Label>
                <FileUploadArea
                  label="Upload call recording or transcript (.mp3, .wav, .txt)..."
                  accept=".mp3,.wav,.m4a,.ogg,.txt,.md"
                  hint="Describe what the agent should learn from these recordings"
                  onContent={(text, name) => {
                    setRecordingNotes(prev => prev ? `${prev}\n\n--- ${name} ---\n${text}` : `--- ${name} ---\n${text}`);
                    toast({ title: `Recording notes loaded: ${name}` });
                  }}
                />
                <Textarea
                  value={recordingNotes}
                  onChange={e => setRecordingNotes(e.target.value)}
                  className="font-mono text-xs min-h-[80px] resize-none"
                  placeholder="Describe ideal call patterns, tone, pace from your best recordings...&#10;&#10;Example: 'Best performers pause 2s after greeting, mirror the customer's tone, handle objections by asking a clarifying question first.'"
                />
              </div>
            </>
          )}

          {/* ── Step 2: Voice & Number ── */}
          {step === 2 && (
            <>
              <div className="space-y-2">
                <Label className="text-[10px] font-mono uppercase text-muted-foreground flex items-center gap-1.5">
                  <Mic2 className="w-3 h-3" /> AI Voice
                  <span className="text-[9px] text-muted-foreground normal-case tracking-normal">(click ▶ to preview)</span>
                </Label>
                <VoicePicker
                  value={selectedVoice}
                  onChange={setSelectedVoice}
                  dbVoices={dbVoices ?? []}
                  elVoices={elVoices}
                  elLoading={elLoading}
                />
              </div>

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
                      <div className="px-3 py-2 text-xs text-muted-foreground font-mono">No numbers configured</div>
                    ) : (numbers ?? []).map(n => (
                      <SelectItem key={n.id} value={n.phoneNumber}>
                        {n.phoneNumber}
                        <span className="ml-2 text-muted-foreground text-[10px]">{n.provider} · {n.status}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
        </div>

        {/* Footer nav */}
        <div className="flex gap-2 px-4 py-3 border-t border-border shrink-0">
          {step > 0 ? (
            <Button variant="outline" className="font-mono text-xs uppercase tracking-wider" onClick={() => setStep(s => s - 1)}>
              <ChevronLeft className="w-3 h-3 mr-1" /> Back
            </Button>
          ) : (
            <Button variant="outline" className="font-mono text-xs uppercase tracking-wider" onClick={onClose}>
              Cancel
            </Button>
          )}
          <div className="flex-1" />
          {step < steps.length - 1 ? (
            <Button
              className="font-mono text-xs uppercase tracking-wider"
              onClick={() => setStep(s => s + 1)}
              disabled={step === 0 && !name.trim()}
            >
              Next <ChevronRight className="w-3 h-3 ml-1" />
            </Button>
          ) : (
            <Button
              className="font-mono text-xs uppercase tracking-wider"
              onClick={handleSubmit}
              disabled={createCampaign.isPending || !name.trim()}
            >
              {createCampaign.isPending ? "Creating..." : (
                <><Check className="w-3 h-3 mr-1" /> Create Campaign</>
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Launch Modal ───────────────────────────────────────────────────────────────
function LaunchModal({
  campaign,
  onClose,
  onLaunched,
}: {
  campaign: Campaign;
  onClose: () => void;
  onLaunched: () => void;
}) {
  const { data: dbVoices } = useListVoices() as { data: Array<{ id: number; name: string; voiceId: string; gender: string; accent: string; previewUrl?: string; description?: string }> | undefined };
  const { data: numbers } = useListNumbers() as { data: Array<{ id: number; phoneNumber: string; provider: string; status: string }> | undefined };
  const { data: leads } = useListLeads({ campaignId: campaign.id });
  const { data: elVoices = [], isLoading: elLoading } = useQuery<ElevenLabsVoice[]>({
    queryKey: ["elevenlabs-voices"],
    queryFn: () => customFetch("/api/voices/elevenlabs") as Promise<ElevenLabsVoice[]>,
    retry: false,
  });
  const startCampaign = useStartCampaign();
  const { toast } = useToast();

  const [selectedNumber, setSelectedNumber] = useState(campaign.fromNumber ?? "");
  const [selectedVoice, setSelectedVoice] = useState(campaign.voice ?? "default");
  const [prompt, setPrompt] = useState(campaign.agentPrompt ?? "");
  const [isLaunching, setIsLaunching] = useState(false);
  const [resetLeads, setResetLeads] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);

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
          voice: selectedVoice !== "default" ? selectedVoice : undefined,
          fromNumber: selectedNumber || undefined,
          agentPrompt: prompt || undefined,
        }),
      });
      if (resetLeads && calledLeads.length > 0) {
        await customFetch(`/api/campaigns/${campaign.id}/reset-leads`, { method: "POST" });
      }
      await new Promise<void>((resolve, reject) => {
        startCampaign.mutate({ id: campaign.id }, { onSuccess: () => resolve(), onError: reject });
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
      <div className="bg-[hsl(224,71%,3%)] border border-border rounded w-full max-w-lg flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Rocket className="w-3.5 h-3.5 text-primary" />
            <p className="text-xs font-mono uppercase tracking-widest text-foreground">Launch Campaign</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Campaign info */}
          <div className="bg-primary/5 border border-primary/20 rounded p-3 flex items-center justify-between">
            <p className="text-sm font-mono font-medium text-foreground">{campaign.name}</p>
            <div className="flex items-center gap-3 text-[10px] font-mono text-muted-foreground">
              <span className="flex items-center gap-1">
                <Users className="w-3 h-3" /> {totalLeads} total
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
                All {calledLeads.length} leads have already been called.
              </p>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={resetLeads} onChange={e => setResetLeads(e.target.checked)} className="accent-primary" />
                <span className="text-xs font-mono text-foreground">Re-call all leads (reset to pending)</span>
              </label>
            </div>
          )}
          {pendingLeads.length === 0 && totalLeads === 0 && (
            <div className="border border-yellow-500/20 bg-yellow-500/5 rounded p-3 text-xs font-mono text-yellow-400">
              No leads yet. Add leads from the Leads page first.
            </div>
          )}

          {/* Number selector */}
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
                  <div className="px-3 py-2 text-xs text-muted-foreground font-mono">No numbers configured</div>
                ) : (numbers ?? []).map((n: { id: number; phoneNumber: string; provider: string; status: string }) => (
                  <SelectItem key={n.id} value={n.phoneNumber}>
                    {n.phoneNumber}
                    <span className="ml-2 text-muted-foreground text-[10px]">{n.provider} · {n.status}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Voice with preview */}
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground flex items-center gap-1.5">
              <Mic2 className="w-3 h-3" /> Voice
              <span className="text-[9px] text-muted-foreground normal-case tracking-normal">(▶ to preview)</span>
            </Label>
            <VoicePicker
              value={selectedVoice}
              onChange={setSelectedVoice}
              dbVoices={dbVoices ?? []}
              elVoices={elVoices}
              elLoading={elLoading}
            />
          </div>

          {/* Collapsible prompt */}
          <div className="space-y-1.5">
            <button
              type="button"
              className="flex items-center gap-1.5 text-[10px] font-mono uppercase text-muted-foreground hover:text-foreground"
              onClick={() => setShowPrompt(p => !p)}
            >
              <FileText className="w-3 h-3" />
              Agent Script / Prompt Override
              <ChevronRight className={`w-3 h-3 transition-transform ${showPrompt ? "rotate-90" : ""}`} />
            </button>
            {showPrompt && (
              <Textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                className="font-mono text-xs min-h-[120px] resize-none"
                placeholder="Override the agent script for this launch only..."
              />
            )}
          </div>
        </div>

        <div className="flex gap-2 px-4 py-3 border-t border-border shrink-0">
          <Button variant="outline" className="flex-1 font-mono text-xs uppercase tracking-wider" onClick={onClose} disabled={isLaunching}>
            Cancel
          </Button>
          <Button
            className="flex-1 font-mono text-xs uppercase tracking-wider bg-green-600 hover:bg-green-700 text-white"
            onClick={handleLaunch}
            disabled={isLaunching || !canLaunch}
          >
            {isLaunching ? (
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-white animate-pulse" /> Launching...
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <Rocket className="w-3 h-3" /> Launch {effectivePending > 0 ? `(${effectivePending} leads)` : ""}
              </span>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Campaigns Page ─────────────────────────────────────────────────────────────
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
                      <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>
                    ))}
                  </tr>
                ))
              ) : (campaigns ?? []).length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground text-xs font-mono">
                    No campaigns yet. Click "New Campaign" to get started.
                  </td>
                </tr>
              ) : (campaigns ?? []).map((c: Campaign) => (
                <tr key={c.id} className="border-b border-border/30 hover:bg-white/[0.02] transition-colors">
                  <td className="px-4 py-3 text-foreground font-medium">{c.name}</td>
                  <td className="px-4 py-3 uppercase text-muted-foreground">{c.type}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.routingType?.replace("_", " ") ?? "-"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.maxConcurrentCalls ?? "-"}</td>
                  <td className="px-4 py-3"><StatusBadge status={c.status} /></td>
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
