import { useState, useRef, useCallback, useEffect } from "react";
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
  Check, RefreshCw, Brain, Music, Zap, Activity, AlertCircle, CheckCircle2, Clock,
  Settings2, ChevronDown, Lock,
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
  backgroundSound?: string;
  holdMusic?: string;
  humanLike?: string;
  transferNumber?: string;
  agentId?: number | null;
};

type AiAgent = {
  id: number;
  name: string;
  description?: string;
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
  dbVoices: Array<{ id: number; name: string; voiceId: string; provider: string; gender: string; accent: string; previewUrl?: string; description?: string }>;
  elVoices: ElevenLabsVoice[];
  elLoading: boolean;
}) {
  const { playing, play } = useAudioPlayer();
  const allVoices = dbVoices.length > 0
    ? dbVoices.map(v => ({ ...v, id: String(v.id) }))
    : elVoices.map(v => ({
        id: v.voice_id,
        voiceId: v.voice_id,
        name: v.name,
        previewUrl: v.preview_url,
        gender: v.labels?.gender ?? "female",
        accent: v.labels?.accent ?? "us",
        description: [v.labels?.description, v.labels?.use_case, v.labels?.age].filter(Boolean).join(", "),
      }));

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
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const handleFile = async (file: File) => {
    setBusy(true);
    try {
      if (file.type.startsWith("audio/") || file.type.startsWith("video/")) {
        // Stream the audio to the backend, which forwards to Deepgram and
        // returns a clean transcript that becomes the script body.
        toast({ title: `Transcribing ${file.name}…`, description: "This can take up to a minute." });
        const fd = new FormData();
        fd.append("file", file);
        const res = await customFetch(`/api/uploads/transcribe`, {
          method: "POST",
          body: fd,
        });
        const data = (await res.json()) as { transcript?: string; error?: string };
        if (!data.transcript) throw new Error(data.error || "Empty transcript");
        onContent(data.transcript, file.name);
        toast({ title: `Transcribed ${file.name}`, description: `${data.transcript.length} characters extracted.` });
        return;
      }

      const name = file.name.toLowerCase();
      let extracted = "";

      // ── DOCX (Microsoft Word) ────────────────────────────────────────────
      if (name.endsWith(".docx")) {
        const mammoth = await import("mammoth/mammoth.browser");
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        extracted = result.value.trim();

      // ── PDF ──────────────────────────────────────────────────────────────
      } else if (name.endsWith(".pdf")) {
        // pdfjs v5 needs the worker URL set before getDocument() runs.
        // Vite resolves `?url` imports to a hashed asset URL at build time.
        const pdfjs = await import("pdfjs-dist");
        try {
          const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
          pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        } catch {
          // Worker import failed — fall back to the .mjs (un-minified) build.
          const workerUrl = (await import("pdfjs-dist/build/pdf.worker.mjs?url")).default;
          pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        }

        // CMap + standard-font URLs are REQUIRED for many PDFs (Word/PPT/Asian
        // fonts use CID-encoded glyphs that need CMap lookup tables to decode
        // into real Unicode). Without these, page.getTextContent() returns
        // gibberish glyph codes instead of readable text.
        // pdfjs-dist ships them; we serve them from the CDN that's pinned to
        // the same version as the npm package to avoid worker/data mismatches.
        const PDFJS_VERSION = "5.6.205";
        const CDN_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;

        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjs.getDocument({
          data: arrayBuffer,
          cMapUrl: `${CDN_BASE}/cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${CDN_BASE}/standard_fonts/`,
          // Extract embedded text AND fall back to glyph-based reconstruction
          // when text layer is missing/broken (older scanned exports).
          useSystemFonts: true,
        }).promise;
        const pages: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          // includeMarkedContent: true preserves logical reading order on
          // structured PDFs. disableNormalization: false keeps ligatures
          // collapsed into normal letters (fi → fi etc).
          const content = await page.getTextContent({
            includeMarkedContent: true,
            disableNormalization: false,
          });
          // Reconstruct lines using the y-coordinate of each text item so
          // we don't smush every page into one run-on paragraph. Items on
          // the same baseline are joined with a space; new lines insert \n.
          let pageText = "";
          let lastY: number | null = null;
          for (const item of content.items) {
            if (!("str" in item)) continue;
            const str = item.str;
            const y = Array.isArray(item.transform) ? item.transform[5] : null;
            if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
              pageText += "\n";
            } else if (pageText && !pageText.endsWith(" ") && !pageText.endsWith("\n")) {
              pageText += " ";
            }
            pageText += str;
            if (y !== null) lastY = y;
            if ("hasEOL" in item && item.hasEOL) {
              pageText += "\n";
              lastY = null;
            }
          }
          pages.push(pageText);
        }
        extracted = pages.join("\n\n").trim();

      // ── DOC (legacy Word) — not supported in browser ────────────────────
      } else if (name.endsWith(".doc")) {
        toast({
          title: "Legacy .doc not supported",
          description: "Save as .docx or .pdf and re-upload.",
          variant: "destructive",
        });
        return;

      // ── Plain text fallback (.txt, .md, anything else) ──────────────────
      } else {
        extracted = (await file.text()).trim();
      }

      if (!extracted) {
        toast({
          title: `Could not read ${file.name}`,
          description: "The file contained no extractable text (may be a scanned image PDF).",
          variant: "destructive",
        });
        return;
      }

      onContent(extracted, file.name);
      toast({
        title: `${file.name} added`,
        description: `Extracted ${extracted.length.toLocaleString()} characters into the knowledge base.`,
      });
    } catch (err) {
      console.error("File extraction failed:", err);
      toast({
        title: `Failed to read ${file.name}`,
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
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

// ── Shared Dialing Engine Fields Component ─────────────────────────────────────
interface DialingEngineProps {
  dialingMode: string; setDialingMode: (v: string) => void;
  dialingRatio: string; setDialingRatio: (v: string) => void;
  dialingSpeed: string; setDialingSpeed: (v: string) => void;
  dropRateLimit: string; setDropRateLimit: (v: string) => void;
  retryAttempts: string; setRetryAttempts: (v: string) => void;
  retryIntervalMinutes: string; setRetryIntervalMinutes: (v: string) => void;
  workingHoursStart: string; setWorkingHoursStart: (v: string) => void;
  workingHoursEnd: string; setWorkingHoursEnd: (v: string) => void;
  workingHoursTimezone: string; setWorkingHoursTimezone: (v: string) => void;
  amdEnabled: boolean; setAmdEnabled: (v: boolean) => void;
  vmDropMessage: string; setVmDropMessage: (v: string) => void;
  tcpaEnabled: boolean; setTcpaEnabled: (v: boolean) => void;
}

const TIMEZONES = [
  { value: "UTC", label: "UTC" },
  { value: "America/New_York", label: "Eastern (ET)" },
  { value: "America/Chicago", label: "Central (CT)" },
  { value: "America/Denver", label: "Mountain (MT)" },
  { value: "America/Los_Angeles", label: "Pacific (PT)" },
  { value: "America/Toronto", label: "Toronto (ET)" },
  { value: "America/Sao_Paulo", label: "São Paulo (BRT)" },
  { value: "Europe/London", label: "London (GMT/BST)" },
  { value: "Europe/Paris", label: "Paris (CET)" },
  { value: "Europe/Moscow", label: "Moscow (MSK)" },
  { value: "Asia/Dubai", label: "Dubai (GST)" },
  { value: "Asia/Kolkata", label: "India (IST)" },
  { value: "Asia/Singapore", label: "Singapore (SGT)" },
  { value: "Asia/Tokyo", label: "Tokyo (JST)" },
  { value: "Australia/Sydney", label: "Sydney (AEDT)" },
];

function DialingEngineFields({
  dialingMode, setDialingMode,
  dialingRatio, setDialingRatio,
  dialingSpeed, setDialingSpeed,
  dropRateLimit, setDropRateLimit,
  retryAttempts, setRetryAttempts,
  retryIntervalMinutes, setRetryIntervalMinutes,
  workingHoursStart, setWorkingHoursStart,
  workingHoursEnd, setWorkingHoursEnd,
  workingHoursTimezone, setWorkingHoursTimezone,
  amdEnabled, setAmdEnabled,
  vmDropMessage, setVmDropMessage,
  tcpaEnabled, setTcpaEnabled,
}: DialingEngineProps) {
  const isPredictive = dialingMode === "predictive";

  return (
    <div className="space-y-4">
      {/* Dialing Mode */}
      <div className="space-y-1.5">
        <Label className="text-[10px] font-mono uppercase text-muted-foreground">Dialing Mode</Label>
        <Select value={dialingMode} onValueChange={setDialingMode}>
          <SelectTrigger className="font-mono text-sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="manual">Manual — agent initiates each call</SelectItem>
            <SelectItem value="preview">Preview — agent reviews lead before dialing</SelectItem>
            <SelectItem value="progressive">Progressive — dial one lead per available agent</SelectItem>
            <SelectItem value="predictive">Predictive — dial multiple leads simultaneously</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-[10px] font-mono text-muted-foreground/70">
          {dialingMode === "predictive" && "Dials ratio × agents simultaneously. Maximises talk time but may increase drop rate."}
          {dialingMode === "progressive" && "One call per available agent slot. Balanced efficiency."}
          {dialingMode === "preview" && "Agent sees lead info before call is placed."}
          {dialingMode === "manual" && "Agent manually triggers each outbound call."}
        </p>
      </div>

      {/* Speed + Ratio row */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-[10px] font-mono uppercase text-muted-foreground">Dialing Speed <span className="text-muted-foreground/60 normal-case">(calls/min)</span></Label>
          <Input
            type="number"
            min="1" max="120"
            value={dialingSpeed}
            onChange={e => setDialingSpeed(e.target.value)}
            className="font-mono text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label className={`text-[10px] font-mono uppercase ${isPredictive ? "text-muted-foreground" : "text-muted-foreground/40"}`}>
            Dialing Ratio <span className="text-muted-foreground/60 normal-case">(predictive only)</span>
          </Label>
          <Input
            type="number"
            min="1" max="20"
            value={dialingRatio}
            onChange={e => setDialingRatio(e.target.value)}
            disabled={!isPredictive}
            className={`font-mono text-sm ${!isPredictive ? "opacity-40" : ""}`}
          />
        </div>
      </div>

      {/* Drop rate + Max concurrent */}
      <div className="space-y-1.5">
        <Label className="text-[10px] font-mono uppercase text-muted-foreground">Max Drop Rate <span className="text-muted-foreground/60 normal-case">(%)</span></Label>
        <Input
          type="number"
          min="1" max="50"
          value={dropRateLimit}
          onChange={e => setDropRateLimit(e.target.value)}
          className="font-mono text-sm"
        />
        <p className="text-[10px] font-mono text-muted-foreground/70">If abandoned calls exceed this %, dialing speed is automatically reduced.</p>
      </div>

      {/* Retry settings */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-[10px] font-mono uppercase text-muted-foreground">Retry Attempts</Label>
          <Input
            type="number"
            min="0" max="10"
            value={retryAttempts}
            onChange={e => setRetryAttempts(e.target.value)}
            className="font-mono text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-[10px] font-mono uppercase text-muted-foreground">Retry After <span className="text-muted-foreground/60 normal-case">(minutes)</span></Label>
          <Input
            type="number"
            min="1" max="1440"
            value={retryIntervalMinutes}
            onChange={e => setRetryIntervalMinutes(e.target.value)}
            className="font-mono text-sm"
          />
        </div>
      </div>

      {/* Working hours */}
      <div className="space-y-2">
        <Label className="text-[10px] font-mono uppercase text-muted-foreground">Working Hours <span className="text-muted-foreground/60 normal-case">(leave blank = always)</span></Label>
        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1">
            <p className="text-[9px] font-mono text-muted-foreground/60 uppercase">Start</p>
            <Input
              type="time"
              value={workingHoursStart}
              onChange={e => setWorkingHoursStart(e.target.value)}
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-1">
            <p className="text-[9px] font-mono text-muted-foreground/60 uppercase">End</p>
            <Input
              type="time"
              value={workingHoursEnd}
              onChange={e => setWorkingHoursEnd(e.target.value)}
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-1">
            <p className="text-[9px] font-mono text-muted-foreground/60 uppercase">Timezone</p>
            <Select value={workingHoursTimezone} onValueChange={setWorkingHoursTimezone}>
              <SelectTrigger className="font-mono text-xs h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {TIMEZONES.map(tz => (
                  <SelectItem key={tz.value} value={tz.value} className="text-xs font-mono">{tz.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* AMD toggle */}
      <div className="flex items-center justify-between rounded border border-border px-3 py-2.5">
        <div>
          <p className="text-xs font-mono font-medium text-foreground">Answering Machine Detection (AMD)</p>
          <p className="text-[10px] font-mono text-muted-foreground mt-0.5">Automatically detect voicemail and skip — prevents wasted AI time on answering machines</p>
        </div>
        <button
          type="button"
          onClick={() => setAmdEnabled(!amdEnabled)}
          className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${amdEnabled ? "bg-primary" : "bg-muted"}`}
        >
          <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${amdEnabled ? "translate-x-4" : "translate-x-0"}`} />
        </button>
      </div>

      {/* VM Drop Message — only shown when AMD is on */}
      {amdEnabled && (
        <div className="space-y-1.5 rounded border border-border/60 bg-muted/20 px-3 py-3">
          <Label className="text-[10px] font-mono uppercase text-muted-foreground">Voicemail Drop Message</Label>
          <p className="text-[10px] font-mono text-muted-foreground/70 leading-relaxed">When an answering machine beep is detected, the AI will speak this message and hang up. Leave blank to hang up silently.</p>
          <textarea
            value={vmDropMessage}
            onChange={e => setVmDropMessage(e.target.value)}
            rows={3}
            placeholder="Hi, this is a message for {{FirstName}} from {{CampaignName}}. Please call us back at your earliest convenience. Thank you!"
            className="w-full bg-background border border-border rounded px-3 py-2 text-xs font-mono text-foreground placeholder:text-muted-foreground/50 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      )}

      {/* TCPA toggle */}
      <div className="flex items-center justify-between rounded border border-border px-3 py-2.5">
        <div>
          <p className="text-xs font-mono font-medium text-foreground">TCPA Calling Hours (8 AM – 9 PM local)</p>
          <p className="text-[10px] font-mono text-muted-foreground mt-0.5">Skip leads outside 8 AM–9 PM in their local timezone. Disable for testing or non-US campaigns.</p>
        </div>
        <button
          type="button"
          onClick={() => setTcpaEnabled(!tcpaEnabled)}
          className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${tcpaEnabled ? "bg-primary" : "bg-muted"}`}
        >
          <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${tcpaEnabled ? "translate-x-4" : "translate-x-0"}`} />
        </button>
      </div>
    </div>
  );
}

// ── NumberMultiSelect — pick up to 5 phone numbers, shows busy status ─────────
interface NumberOption {
  id: number;
  phoneNumber: string;
  provider: string;
  status: string;
  campaignId?: number | null;
  campaignName?: string | null;
}

function NumberMultiSelect({
  numbers,
  selected,           // array of number IDs
  onChange,
  currentCampaignId,  // undefined when creating a new campaign
  max = 5,
}: {
  numbers: NumberOption[];
  selected: number[];
  onChange: (ids: number[]) => void;
  currentCampaignId?: number;
  max?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const toggle = (id: number) => {
    if (selected.includes(id)) {
      onChange(selected.filter(s => s !== id));
    } else {
      if (selected.length >= max) return;
      onChange([...selected, id]);
    }
  };

  const selectedNums = numbers.filter(n => selected.includes(n.id));

  return (
    <div ref={ref} className="relative">
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between gap-2 h-9 rounded-md border border-input bg-transparent px-3 text-sm font-mono ring-offset-background hover:border-ring/50 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 transition-colors"
      >
        <span className="truncate text-left">
          {selectedNums.length === 0
            ? <span className="text-muted-foreground">Select numbers (up to {max})…</span>
            : <span className="text-foreground">{selectedNums.length} number{selectedNums.length !== 1 ? "s" : ""} selected</span>
          }
        </span>
        <ChevronDown className={`w-3 h-3 text-muted-foreground flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {/* Selected chips */}
      {selectedNums.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {selectedNums.map(n => (
            <span
              key={n.id}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono bg-primary/10 border border-primary/30 text-primary"
            >
              {n.phoneNumber}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); toggle(n.id); }}
                className="hover:text-primary/60"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 top-full mt-1 w-full rounded-md border border-border bg-popover shadow-xl overflow-hidden">
          <div className="px-3 py-1.5 border-b border-border/50 flex items-center justify-between">
            <span className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground">
              {selected.length}/{max} selected
            </span>
            {selected.length > 0 && (
              <button
                type="button"
                onClick={() => onChange([])}
                className="text-[9px] font-mono text-muted-foreground hover:text-red-400 transition-colors"
              >
                Clear all
              </button>
            )}
          </div>
          <div className="max-h-48 overflow-y-auto">
            {numbers.length === 0 && (
              <p className="px-3 py-3 text-[10px] font-mono text-muted-foreground">No numbers configured</p>
            )}
            {numbers.map(n => {
              const isMine = n.campaignId === currentCampaignId && currentCampaignId != null;
              const isBusy = n.campaignId != null && !isMine;
              const isChecked = selected.includes(n.id);
              const isDisabled = isBusy || (!isChecked && selected.length >= max) || n.status === "inactive";

              return (
                <button
                  key={n.id}
                  type="button"
                  disabled={isDisabled && !isChecked}
                  onClick={() => !isBusy && toggle(n.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                    isBusy
                      ? "cursor-not-allowed opacity-50"
                      : isDisabled
                      ? "cursor-not-allowed opacity-40 hover:bg-transparent"
                      : "hover:bg-white/5 cursor-pointer"
                  }`}
                >
                  {/* Checkbox */}
                  <span className={`w-3.5 h-3.5 flex-shrink-0 rounded border flex items-center justify-center transition-colors ${
                    isChecked
                      ? "bg-primary border-primary"
                      : isBusy
                      ? "border-muted-foreground/30 bg-transparent"
                      : "border-muted-foreground/50 bg-transparent"
                  }`}>
                    {isChecked && <Check className="w-2 h-2 text-black" />}
                    {isBusy && <Lock className="w-1.5 h-1.5 text-muted-foreground/60" />}
                  </span>

                  {/* Number info */}
                  <span className="flex-1 min-w-0">
                    <span className={`text-xs font-mono block ${isBusy ? "text-muted-foreground" : "text-foreground"}`}>
                      {n.phoneNumber}
                    </span>
                    <span className="text-[9px] font-mono text-muted-foreground">
                      {n.provider} · {n.status}
                      {isBusy && n.campaignName && (
                        <span className="ml-1 text-yellow-500/70"> · Busy: {n.campaignName}</span>
                      )}
                    </span>
                  </span>

                  {isBusy && (
                    <span className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-500/80 border border-yellow-500/20 flex-shrink-0">
                      BUSY
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 3-step Create Campaign Modal ───────────────────────────────────────────────
function CreateModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const steps = ["Basics", "Agent Training", "Voice & Number", "Dialing Engine"];

  // Step 1 — Basics
  const [name, setName] = useState("");
  const [type, setType] = useState("outbound");
  const [routingType, setRoutingType] = useState("ai");
  const [maxConcurrent, setMaxConcurrent] = useState("5");

  // Step 2 — Agent Training
  const [knowledgeBase, setKnowledgeBase] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [recordingNotes, setRecordingNotes] = useState("");
  const [humanLike, setHumanLike] = useState("true");

  // Step 3 — Voice & Number
  const [selectedVoice, setSelectedVoice] = useState("default");
  const [selectedNumber, setSelectedNumber] = useState("");
  const [selectedNumberIds, setSelectedNumberIds] = useState<number[]>([]);
  const [backgroundSound, setBackgroundSound] = useState("none");
  const [holdMusic, setHoldMusic] = useState("none");
  const [transferNumber, setTransferNumber] = useState("");
  const [transferMode, setTransferMode] = useState<"blind" | "warm">("blind");

  // Step 4 — Dialing Engine
  const [dialingMode, setDialingMode] = useState("progressive");
  const [dialingRatio, setDialingRatio] = useState("1");
  const [dialingSpeed, setDialingSpeed] = useState("10");
  const [dropRateLimit, setDropRateLimit] = useState("3");
  const [retryAttempts, setRetryAttempts] = useState("2");
  const [retryIntervalMinutes, setRetryIntervalMinutes] = useState("60");
  const [workingHoursStart, setWorkingHoursStart] = useState("");
  const [workingHoursEnd, setWorkingHoursEnd] = useState("");
  const [workingHoursTimezone, setWorkingHoursTimezone] = useState("UTC");
  const [amdEnabled, setAmdEnabled] = useState(false);
  const [vmDropMessage, setVmDropMessage] = useState("");
  const [tcpaEnabled, setTcpaEnabled] = useState(false);
  const [useVapi, setUseVapi] = useState(false);

  const { data: dbVoices } = useListVoices() as { data: Array<{ id: number; name: string; voiceId: string; provider: string; gender: string; accent: string; previewUrl?: string; description?: string }> | undefined };
  const { data: numbers } = useListNumbers() as { data: Array<NumberOption> | undefined };
  const { data: elVoices = [], isLoading: elLoading } = useQuery<ElevenLabsVoice[]>({
    queryKey: ["elevenlabs-voices"],
    queryFn: () => customFetch("/api/voices/elevenlabs") as Promise<ElevenLabsVoice[]>,
    retry: false,
  });

  const createCampaign = useCreateCampaign();
  const qc = useQueryClient();
  const { toast } = useToast();

  const handleSubmit = () => {
    const resolvedVoiceProvider = selectedVoice !== "default"
      ? (dbVoices?.find(v => v.voiceId === selectedVoice)?.provider ?? (elVoices.some(v => v.voice_id === selectedVoice) ? "elevenlabs" : undefined))
      : undefined;
    createCampaign.mutate(
      {
        data: {
          name,
          type: type as "outbound" | "inbound" | "both",
          routingType: routingType as "ai" | "human" | "ai_then_human",
          maxConcurrentCalls: parseInt(maxConcurrent),
          agentPrompt: agentPrompt || undefined,
          knowledgeBase: knowledgeBase || undefined,
          recordingNotes: recordingNotes || undefined,
          voice: selectedVoice !== "default" ? selectedVoice : undefined,
          voiceProvider: resolvedVoiceProvider as "elevenlabs" | "deepgram" | "cartesia" | undefined,
          fromNumber: selectedNumber || undefined,
          backgroundSound: backgroundSound as "none" | "office",
          holdMusic: holdMusic as "none" | "jazz" | "corporate" | "smooth" | "classical",
          transferNumber: transferNumber || undefined,
          transferMode,
          humanLike,
          dialingMode: dialingMode as "manual" | "progressive" | "predictive" | "preview",
          dialingRatio: parseInt(dialingRatio) || 1,
          dialingSpeed: parseInt(dialingSpeed) || 10,
          dropRateLimit: parseInt(dropRateLimit) || 3,
          retryAttempts: parseInt(retryAttempts) || 2,
          retryIntervalMinutes: parseInt(retryIntervalMinutes) || 60,
          workingHoursStart: workingHoursStart || undefined,
          workingHoursEnd: workingHoursEnd || undefined,
          workingHoursTimezone,
          amdEnabled,
          vmDropMessage: vmDropMessage || undefined,
          tcpaEnabled,
          useVapi,
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
      <div className="bg-card border border-border rounded w-full max-w-xl flex flex-col max-h-[90vh]">
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
                      <SelectItem value="outbound">Outbound (AI dials out)</SelectItem>
                      <SelectItem value="inbound">Inbound (AI answers)</SelectItem>
                      <SelectItem value="both">Both (Inbound + Outbound)</SelectItem>
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

              {/* Human-like toggle */}
              <div className="flex items-center justify-between rounded border border-border px-3 py-2.5">
                <div>
                  <p className="text-xs font-mono font-medium text-foreground">Human-Like Conversation Mode</p>
                  <p className="text-[10px] font-mono text-muted-foreground mt-0.5">Uses natural fillers, pauses, empathy phrases — never sounds scripted</p>
                </div>
                <button
                  type="button"
                  onClick={() => setHumanLike(h => h === "true" ? "false" : "true")}
                  className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${humanLike === "true" ? "bg-primary" : "bg-muted"}`}
                >
                  <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${humanLike === "true" ? "translate-x-4" : "translate-x-0"}`} />
                </button>
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

              {/* Vapi engine toggle ─ routes call through Vapi's managed pipeline */}
              <div className="flex items-center justify-between rounded border border-border px-3 py-2.5">
                <div>
                  <p className="text-xs font-mono font-medium text-foreground">Use Vapi engine (beta)</p>
                  <p className="text-[10px] font-mono text-muted-foreground mt-0.5">Route calls through Vapi for air.ai-grade latency. Selected voice is sent as a per-call override.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setUseVapi(!useVapi)}
                  className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${useVapi ? "bg-primary" : "bg-muted"}`}
                >
                  <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${useVapi ? "translate-x-4" : "translate-x-0"}`} />
                </button>
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

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-mono uppercase text-muted-foreground flex items-center gap-1.5">
                    <Volume2 className="w-3 h-3" /> Background Ambience
                  </Label>
                  <Select value={backgroundSound} onValueChange={setBackgroundSound}>
                    <SelectTrigger className="font-mono text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None (silent)</SelectItem>
                      <SelectItem value="office">Office Environment</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] font-mono text-muted-foreground">Subtle ambient sounds make the agent feel like a real person in an office</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-mono uppercase text-muted-foreground flex items-center gap-1.5">
                    <Music className="w-3 h-3" /> Transfer Hold Music
                  </Label>
                  <Select value={holdMusic} onValueChange={setHoldMusic}>
                    <SelectTrigger className="font-mono text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None (silence)</SelectItem>
                      <SelectItem value="jazz">Smooth Jazz</SelectItem>
                      <SelectItem value="corporate">Corporate Upbeat</SelectItem>
                      <SelectItem value="smooth">Relaxing Ambient</SelectItem>
                      <SelectItem value="classical">Light Classical</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] font-mono text-muted-foreground">Plays while the caller waits for a human agent to pick up on transfer</p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-[10px] font-mono uppercase text-muted-foreground flex items-center gap-1.5">
                  <Phone className="w-3 h-3" /> Transfer-to Number
                  <span className="text-[9px] text-muted-foreground normal-case tracking-normal">(human agent, E.164 format e.g. +14155551234)</span>
                </Label>
                <input
                  value={transferNumber}
                  onChange={e => setTransferNumber(e.target.value)}
                  placeholder="+14155551234"
                  className="w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                />
                <p className="text-[10px] font-mono text-muted-foreground">When the AI completes its script it will transfer the caller to this number</p>
              </div>

              {transferNumber && (
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-mono uppercase text-muted-foreground">Transfer Mode</Label>
                  <Select value={transferMode} onValueChange={v => setTransferMode(v as "blind" | "warm")}>
                    <SelectTrigger className="text-sm h-9 font-mono"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="blind">Blind — Drop AI immediately, bridge caller</SelectItem>
                      <SelectItem value="warm">Warm — AI briefs human agent before bridging</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] font-mono text-muted-foreground">Warm transfers add ~5–10s of agent context before the caller is connected</p>
                </div>
              )}
            </>
          )}

          {/* ── Step 3: Dialing Engine ── */}
          {step === 3 && (
            <DialingEngineFields
              dialingMode={dialingMode} setDialingMode={setDialingMode}
              dialingRatio={dialingRatio} setDialingRatio={setDialingRatio}
              dialingSpeed={dialingSpeed} setDialingSpeed={setDialingSpeed}
              dropRateLimit={dropRateLimit} setDropRateLimit={setDropRateLimit}
              retryAttempts={retryAttempts} setRetryAttempts={setRetryAttempts}
              retryIntervalMinutes={retryIntervalMinutes} setRetryIntervalMinutes={setRetryIntervalMinutes}
              workingHoursStart={workingHoursStart} setWorkingHoursStart={setWorkingHoursStart}
              workingHoursEnd={workingHoursEnd} setWorkingHoursEnd={setWorkingHoursEnd}
              workingHoursTimezone={workingHoursTimezone} setWorkingHoursTimezone={setWorkingHoursTimezone}
              amdEnabled={amdEnabled} setAmdEnabled={setAmdEnabled}
              vmDropMessage={vmDropMessage} setVmDropMessage={setVmDropMessage}
              tcpaEnabled={tcpaEnabled} setTcpaEnabled={setTcpaEnabled}
            />
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
  const { data: dbVoices } = useListVoices() as { data: Array<{ id: number; name: string; voiceId: string; provider: string; gender: string; accent: string; previewUrl?: string; description?: string }> | undefined };
  const { data: numbers } = useListNumbers() as { data: Array<NumberOption> | undefined };
  const { data: leads } = useListLeads({ campaignId: campaign.id });
  const { data: elVoices = [], isLoading: elLoading } = useQuery<ElevenLabsVoice[]>({
    queryKey: ["elevenlabs-voices"],
    queryFn: () => customFetch("/api/voices/elevenlabs") as Promise<ElevenLabsVoice[]>,
    retry: false,
  });
  const { data: aiAgents = [] } = useQuery<AiAgent[]>({
    queryKey: ["ai-agents"],
    queryFn: () => customFetch("/api/ai-agents") as Promise<AiAgent[]>,
    retry: false,
  });
  const startCampaign = useStartCampaign();
  const { toast } = useToast();

  const [selectedAgent, setSelectedAgent] = useState(campaign.agentId ? String(campaign.agentId) : "none");
  const [selectedNumber, setSelectedNumber] = useState(campaign.fromNumber ?? "");
  const [selectedVoice, setSelectedVoice] = useState(campaign.voice || "default");
  const [prompt, setPrompt] = useState(campaign.agentPrompt ?? "");
  const [isLaunching, setIsLaunching] = useState(false);
  const [resetLeads, setResetLeads] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [backgroundSound, setBackgroundSound] = useState(campaign.backgroundSound ?? "none");
  const [holdMusic, setHoldMusic] = useState(campaign.holdMusic ?? "none");
  const [transferNumber, setTransferNumber] = useState(campaign.transferNumber ?? "");
  const [transferMode, setTransferMode] = useState<"blind" | "warm">(
    ((campaign as Record<string, unknown>).transferMode as "blind" | "warm" | undefined) ?? "blind"
  );
  const [humanLike, setHumanLike] = useState(campaign.humanLike ?? "true");
  const [showDialingEngine, setShowDialingEngine] = useState(false);

  // Dialing engine state (seeded from campaign)
  const [dialingMode, setDialingMode] = useState((campaign as Record<string, unknown>).dialingMode as string ?? "progressive");
  const [dialingRatio, setDialingRatio] = useState(String((campaign as Record<string, unknown>).dialingRatio ?? "1"));
  const [dialingSpeed, setDialingSpeed] = useState(String((campaign as Record<string, unknown>).dialingSpeed ?? "10"));
  const [dropRateLimit, setDropRateLimit] = useState(String((campaign as Record<string, unknown>).dropRateLimit ?? "3"));
  const [retryAttempts, setRetryAttempts] = useState(String((campaign as Record<string, unknown>).retryAttempts ?? "2"));
  const [retryIntervalMinutes, setRetryIntervalMinutes] = useState(String((campaign as Record<string, unknown>).retryIntervalMinutes ?? "60"));
  const [workingHoursStart, setWorkingHoursStart] = useState((campaign as Record<string, unknown>).workingHoursStart as string ?? "");
  const [workingHoursEnd, setWorkingHoursEnd] = useState((campaign as Record<string, unknown>).workingHoursEnd as string ?? "");
  const [workingHoursTimezone, setWorkingHoursTimezone] = useState((campaign as Record<string, unknown>).workingHoursTimezone as string ?? "UTC");
  const [amdEnabled, setAmdEnabled] = useState(Boolean((campaign as Record<string, unknown>).amdEnabled));
  const [vmDropMessage, setVmDropMessage] = useState(String((campaign as Record<string, unknown>).vmDropMessage ?? ""));
  const [tcpaEnabled, setTcpaEnabled] = useState(Boolean((campaign as Record<string, unknown>).tcpaEnabled));
  const [useVapi, setUseVapi] = useState(Boolean((campaign as Record<string, unknown>).useVapi));

  const pendingLeads = (leads ?? []).filter((l: { status: string }) => l.status === "pending");
  const calledLeads = (leads ?? []).filter((l: { status: string }) => ["called", "callback", "completed"].includes(l.status));
  const totalLeads = (leads ?? []).length;
  const effectivePending = resetLeads ? pendingLeads.length + calledLeads.length : pendingLeads.length;
  const canLaunch = effectivePending > 0;

  const [isSaving, setIsSaving] = useState(false);

  // Build the PATCH body from current modal state. Shared by Save and Launch.
  const buildPatchBody = () => {
    const resolvedVoiceProvider = selectedVoice !== "default"
      ? (dbVoices?.find(v => v.voiceId === selectedVoice)?.provider ?? (elVoices.some(v => v.voice_id === selectedVoice) ? "elevenlabs" : undefined))
      : undefined;
    return {
      voice: selectedVoice !== "default" ? selectedVoice : undefined,
      voiceProvider: resolvedVoiceProvider,
      fromNumber: selectedNumber || undefined,
      agentPrompt: prompt || undefined,
      agentId: selectedAgent !== "none" ? parseInt(selectedAgent) : null,
      backgroundSound,
      holdMusic,
      transferNumber: transferNumber || undefined,
      transferMode,
      humanLike,
      dialingMode,
      dialingRatio: parseInt(dialingRatio) || 1,
      dialingSpeed: parseInt(dialingSpeed) || 10,
      dropRateLimit: parseInt(dropRateLimit) || 3,
      retryAttempts: parseInt(retryAttempts) || 2,
      retryIntervalMinutes: parseInt(retryIntervalMinutes) || 60,
      workingHoursStart: workingHoursStart || undefined,
      workingHoursEnd: workingHoursEnd || undefined,
      workingHoursTimezone,
      amdEnabled,
      vmDropMessage: vmDropMessage || undefined,
      tcpaEnabled,
      useVapi,
    };
  };

  // Save changes (voice, prompt, dialing settings, etc.) WITHOUT starting calls.
  const handleSave = async () => {
    setIsSaving(true);
    try {
      await customFetch(`/api/campaigns/${campaign.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPatchBody()),
      });
      toast({ title: "Campaign saved", description: `Updated "${campaign.name}"` });
      onLaunched(); // refresh list / cache
      onClose();
    } catch {
      toast({ title: "Failed to save campaign", variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  };

  const handleLaunch = async () => {
    setIsLaunching(true);
    try {
      await customFetch(`/api/campaigns/${campaign.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPatchBody()),
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
    } catch (err) {
      // Extract the server's actual error message instead of a generic toast.
      // Covers customFetch errors (response.json().error), axios-style errors,
      // and plain Error instances.
      let description = "Please try again.";
      const e = err as { response?: { data?: { error?: string } }; body?: { error?: string }; message?: string };
      if (e?.response?.data?.error) description = e.response.data.error;
      else if (e?.body?.error) description = e.body.error;
      else if (e?.message) description = e.message;
      toast({
        title: "Failed to launch campaign",
        description,
        variant: "destructive",
      });
    } finally {
      setIsLaunching(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded w-full max-w-lg flex flex-col max-h-[90vh]">
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

          {/* AI Agent selector */}
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground flex items-center gap-1.5">
              <Brain className="w-3 h-3" /> AI Agent
              <span className="text-[9px] normal-case tracking-normal text-muted-foreground">(overrides prompt if set)</span>
            </Label>
            <Select value={selectedAgent} onValueChange={setSelectedAgent}>
              <SelectTrigger className="font-mono text-sm">
                <SelectValue placeholder="No agent — use campaign prompt" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No agent — use campaign prompt</SelectItem>
                {aiAgents.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.name}
                    {a.description && (
                      <span className="ml-2 text-muted-foreground text-[10px]">{a.description}</span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

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

          {/* Vapi engine toggle ─ routes call through Vapi's managed pipeline */}
          <div className="flex items-center justify-between rounded border border-border px-3 py-2.5">
            <div>
              <p className="text-xs font-mono font-medium text-foreground">Use Vapi engine (beta)</p>
              <p className="text-[10px] font-mono text-muted-foreground mt-0.5">Route calls through Vapi for air.ai-grade latency. Selected voice is sent as a per-call override.</p>
            </div>
            <button
              type="button"
              onClick={() => setUseVapi(!useVapi)}
              className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${useVapi ? "bg-primary" : "bg-muted"}`}
            >
              <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${useVapi ? "translate-x-4" : "translate-x-0"}`} />
            </button>
          </div>

          {/* Background sound + Hold music */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground flex items-center gap-1.5">
                <Volume2 className="w-3 h-3" /> Background Ambience
              </Label>
              <Select value={backgroundSound} onValueChange={setBackgroundSound}>
                <SelectTrigger className="font-mono text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None (silent)</SelectItem>
                  <SelectItem value="office">Office Environment</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground flex items-center gap-1.5">
                <Music className="w-3 h-3" /> Transfer Hold Music
              </Label>
              <Select value={holdMusic} onValueChange={setHoldMusic}>
                <SelectTrigger className="font-mono text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None (silence)</SelectItem>
                  <SelectItem value="jazz">Smooth Jazz</SelectItem>
                  <SelectItem value="corporate">Corporate Upbeat</SelectItem>
                  <SelectItem value="smooth">Relaxing Ambient</SelectItem>
                  <SelectItem value="classical">Light Classical</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Transfer-to Number */}
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground flex items-center gap-1.5">
              <Phone className="w-3 h-3" /> Transfer-to Number
              <span className="text-[9px] text-muted-foreground normal-case tracking-normal">(E.164 e.g. +14155551234)</span>
            </Label>
            <input
              value={transferNumber}
              onChange={e => setTransferNumber(e.target.value)}
              placeholder="+14155551234"
              className="w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            />
            <p className="text-[10px] font-mono text-muted-foreground">AI transfers the caller here after completing the script. Required for live transfer to work.</p>
          </div>

          {/* Transfer Mode (only relevant when a transfer number is set) */}
          {transferNumber && (
            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">Transfer Mode</Label>
              <Select value={transferMode} onValueChange={v => setTransferMode(v as "blind" | "warm")}>
                <SelectTrigger className="text-sm h-9 font-mono"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="blind">Blind — Drop AI immediately, bridge caller</SelectItem>
                  <SelectItem value="warm">Warm — AI briefs human agent before bridging</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[10px] font-mono text-muted-foreground">Warm transfers add ~5–10s of agent context before the caller is connected</p>
            </div>
          )}

          {/* Human-like toggle */}
          <div className="flex items-center justify-between rounded border border-border px-3 py-2.5">
            <div>
              <p className="text-xs font-mono font-medium text-foreground">Human-Like Mode</p>
              <p className="text-[10px] font-mono text-muted-foreground mt-0.5">Natural fillers, pauses &amp; empathy — sounds like a real person</p>
            </div>
            <button
              type="button"
              onClick={() => setHumanLike(h => h === "true" ? "false" : "true")}
              className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${humanLike === "true" ? "bg-primary" : "bg-muted"}`}
            >
              <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${humanLike === "true" ? "translate-x-4" : "translate-x-0"}`} />
            </button>
          </div>

          {/* Collapsible Dialing Engine */}
          <div className="space-y-2">
            <button
              type="button"
              className="flex items-center gap-1.5 text-[10px] font-mono uppercase text-muted-foreground hover:text-foreground w-full text-left"
              onClick={() => setShowDialingEngine(d => !d)}
            >
              <Settings2 className="w-3 h-3" />
              Dialing Engine Settings
              <span className="text-[9px] text-muted-foreground/50 normal-case ml-1">({dialingMode})</span>
              <ChevronRight className={`w-3 h-3 transition-transform ml-auto ${showDialingEngine ? "rotate-90" : ""}`} />
            </button>
            {showDialingEngine && (
              <div className="border border-border rounded p-3">
                <DialingEngineFields
                  dialingMode={dialingMode} setDialingMode={setDialingMode}
                  dialingRatio={dialingRatio} setDialingRatio={setDialingRatio}
                  dialingSpeed={dialingSpeed} setDialingSpeed={setDialingSpeed}
                  dropRateLimit={dropRateLimit} setDropRateLimit={setDropRateLimit}
                  retryAttempts={retryAttempts} setRetryAttempts={setRetryAttempts}
                  retryIntervalMinutes={retryIntervalMinutes} setRetryIntervalMinutes={setRetryIntervalMinutes}
                  workingHoursStart={workingHoursStart} setWorkingHoursStart={setWorkingHoursStart}
                  workingHoursEnd={workingHoursEnd} setWorkingHoursEnd={setWorkingHoursEnd}
                  workingHoursTimezone={workingHoursTimezone} setWorkingHoursTimezone={setWorkingHoursTimezone}
                  amdEnabled={amdEnabled} setAmdEnabled={setAmdEnabled}
                  vmDropMessage={vmDropMessage} setVmDropMessage={setVmDropMessage}
                  tcpaEnabled={tcpaEnabled} setTcpaEnabled={setTcpaEnabled}
                />
              </div>
            )}
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
          <Button variant="outline" className="flex-1 font-mono text-xs uppercase tracking-wider" onClick={onClose} disabled={isLaunching || isSaving}>
            Cancel
          </Button>
          <Button
            variant="outline"
            className="flex-1 font-mono text-xs uppercase tracking-wider border-primary/40 text-primary hover:bg-primary/10"
            onClick={handleSave}
            disabled={isLaunching || isSaving}
            title="Save changes (voice, prompt, etc.) without starting calls"
          >
            {isSaving ? (
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-primary animate-pulse" /> Saving...
              </span>
            ) : (
              "Save Changes"
            )}
          </Button>
          <Button
            className="flex-1 font-mono text-xs uppercase tracking-wider bg-green-600 hover:bg-green-700 text-white"
            onClick={handleLaunch}
            disabled={isLaunching || isSaving || !canLaunch}
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

// ── Test Call Modal ─────────────────────────────────────────────────────────────
type CallLog = { id: number; phoneNumber: string | null; status: string; campaignId: number | null; timestamp: string | null };
type TestResult = { success: boolean; jobId?: string; fromNumber?: string; voice?: string; error?: string; phone?: string };

function TestCallModal({ campaign, onClose }: { campaign: Campaign; onClose: () => void }) {
  const [phone, setPhone] = useState("+13079999564");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [logs, setLogs] = useState<CallLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [workerOk, setWorkerOk] = useState<boolean | null>(null);

  // Load call logs for this campaign
  const fetchLogs = useCallback(async () => {
    try {
      const data = await customFetch(`/api/call-logs?campaignId=${campaign.id}`) as CallLog[];
      setLogs((Array.isArray(data) ? data : []).slice(0, 15));
    } catch { setLogs([]); }
    setLogsLoading(false);
  }, [campaign.id]);

  // Check worker health
  useEffect(() => {
    customFetch("/api/healthz").then(() => setWorkerOk(true)).catch(() => setWorkerOk(false));
    fetchLogs();
  }, [fetchLogs]);

  const handleFire = async () => {
    if (!phone.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      const data = await customFetch(`/api/campaigns/${campaign.id}/test-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.trim() }),
      }) as TestResult;
      setResult({ ...data, phone: phone.trim() });
      await fetchLogs();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Call failed";
      setResult({ success: false, error: msg, phone: phone.trim() });
    } finally {
      setLoading(false);
    }
  };

  const statusIcon = (s: string) => {
    if (s === "completed") return <CheckCircle2 className="w-3 h-3 text-green-400" />;
    if (s === "failed") return <AlertCircle className="w-3 h-3 text-red-400" />;
    if (s === "initiated") return <Clock className="w-3 h-3 text-yellow-400" />;
    return <Activity className="w-3 h-3 text-blue-400" />;
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded w-full max-w-lg flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Zap className="w-3.5 h-3.5 text-yellow-400" />
            <p className="text-xs font-mono uppercase tracking-widest text-foreground">Test Call</p>
            <span className="text-[10px] font-mono text-muted-foreground">— {campaign.name}</span>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* System status */}
          <div className="flex items-center gap-4 text-[10px] font-mono">
            <span className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${workerOk === null ? "bg-yellow-400 animate-pulse" : workerOk ? "bg-green-400" : "bg-red-400"}`} />
              <span className="text-muted-foreground">API Server: </span>
              <span className={workerOk === null ? "text-yellow-400" : workerOk ? "text-green-400" : "text-red-400"}>
                {workerOk === null ? "checking..." : workerOk ? "online" : "unreachable"}
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
              <span className="text-muted-foreground">Worker: </span>
              <span className="text-green-400">ai-voice-worker1.replit.app</span>
            </span>
            <span className="flex items-center gap-1.5">
              <Phone className="w-2.5 h-2.5 text-muted-foreground" />
              <span className="text-muted-foreground">From: </span>
              <span className="text-foreground">{campaign.fromNumber ?? "default"}</span>
            </span>
          </div>

          {/* Phone input */}
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Target Phone Number</Label>
            <div className="flex gap-2">
              <Input
                value={phone}
                onChange={e => setPhone(e.target.value)}
                className="font-mono text-sm flex-1"
                placeholder="+1XXXXXXXXXX"
                disabled={loading}
              />
              <Button
                onClick={handleFire}
                disabled={loading || !phone.trim()}
                className="font-mono text-xs uppercase tracking-wider bg-yellow-500 hover:bg-yellow-600 text-black shrink-0"
              >
                {loading ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-black animate-pulse" /> Firing...
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <Zap className="w-3 h-3" /> Fire Call
                  </span>
                )}
              </Button>
            </div>
            <p className="text-[10px] font-mono text-muted-foreground">Uses the full campaign config (prompt, voice, background sound, hold music)</p>
          </div>

          {/* Result */}
          {result && (
            <div className={`rounded border px-3 py-2.5 space-y-1 ${result.success ? "border-green-500/30 bg-green-500/5" : "border-red-500/30 bg-red-500/5"}`}>
              <div className="flex items-center gap-2">
                {result.success
                  ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />
                  : <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />}
                <span className={`text-xs font-mono font-medium ${result.success ? "text-green-400" : "text-red-400"}`}>
                  {result.success ? "Call queued successfully" : "Call failed"}
                </span>
              </div>
              {result.success && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px] font-mono text-muted-foreground pl-5">
                  <span>Job ID: <span className="text-foreground">{result.jobId ?? "—"}</span></span>
                  <span>To: <span className="text-foreground">{result.phone}</span></span>
                  <span>From: <span className="text-foreground">{result.fromNumber}</span></span>
                  <span>Voice: <span className="text-foreground">{result.voice ?? "default"}</span></span>
                </div>
              )}
              {!result.success && (
                <p className="text-[10px] font-mono text-red-300 pl-5">{result.error}</p>
              )}
            </div>
          )}

          {/* Call logs for this campaign */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground flex items-center gap-1.5">
                <Activity className="w-3 h-3" /> Recent Calls — {campaign.name}
              </Label>
              <button onClick={fetchLogs} className="text-[10px] font-mono text-muted-foreground hover:text-foreground flex items-center gap-1">
                <RefreshCw className="w-2.5 h-2.5" /> Refresh
              </button>
            </div>
            <div className="border border-border rounded overflow-hidden">
              {logsLoading ? (
                <div className="px-3 py-4 text-center text-[10px] font-mono text-muted-foreground">Loading logs...</div>
              ) : logs.length === 0 ? (
                <div className="px-3 py-4 text-center text-[10px] font-mono text-muted-foreground">No calls yet for this campaign</div>
              ) : (
                <table className="w-full text-[10px] font-mono">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left px-3 py-1.5 text-muted-foreground uppercase tracking-wider">#</th>
                      <th className="text-left px-3 py-1.5 text-muted-foreground uppercase tracking-wider">Phone</th>
                      <th className="text-left px-3 py-1.5 text-muted-foreground uppercase tracking-wider">Status</th>
                      <th className="text-left px-3 py-1.5 text-muted-foreground uppercase tracking-wider">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map(log => (
                      <tr key={log.id} className="border-b border-border/30 hover:bg-white/[0.02]">
                        <td className="px-3 py-1.5 text-muted-foreground">{log.id}</td>
                        <td className="px-3 py-1.5 text-foreground">{log.phoneNumber ?? "—"}</td>
                        <td className="px-3 py-1.5">
                          <span className="flex items-center gap-1">
                            {statusIcon(log.status)}
                            <span className={
                              log.status === "completed" ? "text-green-400" :
                              log.status === "failed" ? "text-red-400" :
                              log.status === "initiated" ? "text-yellow-400" : "text-blue-400"
                            }>{log.status}</span>
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-muted-foreground">
                          {log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

        <div className="px-4 py-3 border-t border-border shrink-0">
          <Button variant="outline" className="w-full font-mono text-xs uppercase tracking-wider" onClick={onClose}>
            Close
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
  const [testingCampaign, setTestingCampaign] = useState<Campaign | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("all");

  const filteredCampaigns = (campaigns ?? []).filter((c: Campaign) => {
    if (filterStatus === "all") return true;
    if (filterStatus === "drafts") return c.status === "draft";
    return c.status === filterStatus;
  });

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
      {testingCampaign && (
        <TestCallModal
          campaign={testingCampaign}
          onClose={() => setTestingCampaign(null)}
        />
      )}
      <PageHeader
        title="Campaigns"
        subtitle={`${(campaigns ?? []).length} of ${(campaigns ?? []).length} campaigns`}
        action={
          <Button
            size="sm"
            className="h-8 px-3 text-xs"
            onClick={() => setShowCreate(true)}
          >
            <Plus className="w-3.5 h-3.5 mr-1.5" /> New Campaign
          </Button>
        }
      />

      {/* Filter pill row */}
      <div className="px-6 pt-4">
        <CampaignFilterPills
          campaigns={campaigns ?? []}
          value={filterStatus}
          onChange={setFilterStatus}
        />
      </div>

      <div className="p-6">
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-64 rounded-lg" />)}
          </div>
        ) : (campaigns ?? []).length === 0 ? (
          <div className="border border-dashed border-border rounded-lg p-12 text-center text-sm text-muted-foreground bg-card">
            No campaigns yet. Click "New Campaign" to get started.
          </div>
        ) : filteredCampaigns.length === 0 ? (
          <div className="border border-dashed border-border rounded-lg p-12 text-center text-sm text-muted-foreground bg-card">
            No campaigns in this filter.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filteredCampaigns.map((c: Campaign) => (
              <CampaignCard
                key={c.id}
                campaign={c}
                onTest={() => setTestingCampaign(c)}
                onLaunch={() => setLaunchingCampaign(c)}
                onStop={() => handleStop(c.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Hidden — preserve original table for reference (now a no-op) */}
      <div className="hidden">
        <div className="border border-border rounded bg-card overflow-hidden">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border">
                <th>Name</th><th>Type</th><th>Routing</th><th>Concurrent</th><th>Status</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {(campaigns ?? []).map((c: Campaign) => (
                <tr key={c.id} className="border-b border-border/30 hover:bg-white/[0.02] transition-colors">
                  <td className="px-4 py-3 text-foreground font-medium">{c.name}</td>
                  <td className="px-4 py-3 uppercase text-muted-foreground">{c.type}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.routingType?.replace("_", " ") ?? "-"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.maxConcurrentCalls ?? "-"}</td>
                  <td className="px-4 py-3"><StatusBadge status={c.status} /></td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        onClick={() => setTestingCampaign(c)}
                        className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/10 transition-colors"
                      >
                        <Zap className="w-2.5 h-2.5" /> Test
                      </button>
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

// ── Filter pill row ─────────────────────────────────────────────────────────────
function CampaignFilterPills({
  campaigns, value, onChange,
}: { campaigns: Campaign[]; value: string; onChange: (v: string) => void }) {
  const counts = {
    all: campaigns.length,
    active: campaigns.filter(c => c.status === "active").length,
    paused: campaigns.filter(c => c.status === "paused").length,
    completed: campaigns.filter(c => c.status === "completed").length,
    drafts: campaigns.filter(c => c.status === "draft").length,
  };
  const tabs: { key: keyof typeof counts; label: string }[] = [
    { key: "all", label: "ALL" },
    { key: "active", label: "ACTIVE" },
    { key: "paused", label: "PAUSED" },
    { key: "completed", label: "COMPLETED" },
    { key: "drafts", label: "DRAFTS" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      {tabs.map(t => {
        const active = value === t.key;
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={`rounded-full px-3 py-1 text-[11px] font-medium tracking-wide border transition-colors ${
              active
                ? "bg-foreground text-background border-foreground"
                : "bg-background text-muted-foreground border-border hover:bg-muted/40"
            }`}
          >
            {t.label} ({counts[t.key]})
          </button>
        );
      })}
    </div>
  );
}

// ── Campaign card ───────────────────────────────────────────────────────────────
function CampaignCard({
  campaign, onTest, onLaunch, onStop,
}: { campaign: Campaign; onTest: () => void; onLaunch: () => void; onStop: () => void }) {
  const c = campaign;
  const isActive = c.status === "active";

  const statusPill = (() => {
    const map: Record<string, string> = {
      active:    "bg-emerald-100 text-emerald-700 border-emerald-200",
      paused:    "bg-amber-100 text-amber-700 border-amber-200",
      completed: "bg-sky-100 text-sky-700 border-sky-200",
      draft:     "bg-amber-50 text-amber-700 border-amber-200",
    };
    return map[c.status] ?? "bg-slate-100 text-slate-600 border-slate-200";
  })();

  const typePill = (() => {
    const map: Record<string, string> = {
      outbound: "bg-emerald-100 text-emerald-700 border-emerald-200",
      inbound:  "bg-sky-100 text-sky-700 border-sky-200",
      both:     "bg-violet-100 text-violet-700 border-violet-200",
    };
    return map[c.type] ?? "bg-slate-100 text-slate-600 border-slate-200";
  })();

  return (
    <div className="border border-border rounded-lg bg-card p-4 space-y-3 hover:shadow-sm transition-shadow">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground truncate">{c.name}</h3>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium border ${statusPill}`}>
            {c.status}
          </span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium border ${typePill}`}>
            {c.type}
          </span>
        </div>
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1"><Users className="w-3 h-3" /> 0 total</span>
        <span className="flex items-center gap-1"><Phone className="w-3 h-3" /> 0 called</span>
        <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> 0 pending</span>
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <button
            onClick={onTest}
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium bg-amber-100 text-amber-700 border border-amber-200 hover:bg-amber-200 transition-colors"
          >
            <Zap className="w-3 h-3" /> Test
          </button>
          {!isActive ? (
            <button
              onClick={onLaunch}
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium bg-emerald-100 text-emerald-700 border border-emerald-200 hover:bg-emerald-200 transition-colors"
            >
              <Play className="w-3 h-3" /> Resume
            </button>
          ) : (
            <button
              onClick={onStop}
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium bg-rose-100 text-rose-700 border border-rose-200 hover:bg-rose-200 transition-colors"
            >
              <Square className="w-3 h-3" /> Stop
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium bg-orange-100 text-orange-700 border border-orange-200 hover:bg-orange-200 transition-colors"
            title="Scan campaign"
          >
            <RefreshCw className="w-3 h-3" /> Scan
          </button>
          <button
            onClick={onLaunch}
            className="p-1.5 rounded text-muted-foreground hover:bg-muted/60 transition-colors"
            title="Edit"
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>
          <button
            className="p-1.5 rounded text-muted-foreground hover:bg-muted/60 hover:text-destructive transition-colors"
            title="Delete"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Meta row */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground border-t border-border/50 pt-2">
        <span className="flex items-center gap-1">
          <Activity className="w-3 h-3" /> {c.routingType?.replace("_", " ") || "progressive"}
        </span>
        <span className="flex items-center gap-1">
          <Zap className="w-3 h-3 text-orange-500" /> {c.maxConcurrentCalls ?? 10} c/min
        </span>
        {c.transferNumber && (
          <span className="flex items-center gap-1">
            <Phone className="w-3 h-3 text-rose-500" /> Transfer: {c.transferNumber}
          </span>
        )}
        {c.backgroundSound && (
          <span className="flex items-center gap-1">
            <Music className="w-3 h-3" /> {c.backgroundSound}
          </span>
        )}
      </div>

      {/* Speed controls collapsible (visual only) */}
      <details className="text-[11px] text-muted-foreground border-t border-border/50 pt-2">
        <summary className="cursor-pointer flex items-center gap-1 hover:text-foreground transition-colors list-none">
          <Settings2 className="w-3 h-3" /> SPEED CONTROLS
          <ChevronDown className="w-3 h-3 ml-auto" />
        </summary>
        <p className="mt-2 text-muted-foreground/80">
          Configure pacing, concurrency, and call rate from the Edit panel.
        </p>
      </details>
    </div>
  );
}
