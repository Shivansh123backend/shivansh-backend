import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Layout, PageHeader } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Plus, X, Trash2, ClipboardList, ShieldX, ShieldCheck, AlertTriangle, RefreshCw, Search } from "lucide-react";
import { cn } from "@/lib/utils";

type DncEntry = {
  id: number;
  phone_number: string;
  reason?: string | null;
  created_at: string;
  spam_score?: number;
  line_type?: string | null;
  carrier_name?: string | null;
  last_checked_at?: string | null;
  auto_blocked?: boolean;
};

type SpamCheckResp = {
  on_dnc: boolean;
  blocked: boolean;
  spam_score: number;
  line_type: string | null;
  carrier_name: string | null;
  reason: string | null;
  cached: boolean;
};

// ── Visual helpers ───────────────────────────────────────────────────────────
function spamColor(score: number): string {
  if (score >= 80) return "text-red-400 bg-red-500/15 border-red-500/30";
  if (score >= 50) return "text-orange-400 bg-orange-500/15 border-orange-500/30";
  if (score >= 20) return "text-yellow-400 bg-yellow-500/15 border-yellow-500/30";
  return "text-green-400 bg-green-500/15 border-green-500/30";
}
function spamLabel(score: number): string {
  if (score >= 80) return "BLOCKED";
  if (score >= 50) return "HIGH";
  if (score >= 20) return "MEDIUM";
  return "LOW";
}

function SpamBadge({ score }: { score: number }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono uppercase",
      spamColor(score),
    )}>
      {score}
      <span className="opacity-70">/ {spamLabel(score)}</span>
    </span>
  );
}

// ── Add modal — now with live spam preview before adding ─────────────────────
function AddModal({ onClose }: { onClose: () => void }) {
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<SpamCheckResp | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  const check = useMutation({
    mutationFn: () => customFetch(`/api/dnc/check/${encodeURIComponent(phone)}`) as Promise<SpamCheckResp>,
    onSuccess: (data) => setPreview(data),
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

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
            <div className="flex gap-2">
              <Input
                value={phone}
                onChange={e => { setPhone(e.target.value); setPreview(null); }}
                className="font-mono text-sm"
                placeholder="+14155550100"
              />
              <Button
                variant="outline"
                size="sm"
                className="font-mono text-[10px] uppercase tracking-wider shrink-0"
                disabled={!phone.trim() || check.isPending}
                onClick={() => check.mutate()}
                title="Check spam score before adding"
              >
                {check.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
                <span className="ml-1">Check</span>
              </Button>
            </div>
          </div>

          {preview && (
            <div className="rounded border border-border bg-white/[0.02] p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase text-muted-foreground">Spam Score</span>
                <SpamBadge score={preview.spam_score} />
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
                <div>
                  <div className="text-muted-foreground text-[9px] uppercase">Line Type</div>
                  <div className="text-foreground">{preview.line_type ?? "unknown"}</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-[9px] uppercase">Carrier</div>
                  <div className="text-foreground truncate" title={preview.carrier_name ?? ""}>
                    {preview.carrier_name ?? "—"}
                  </div>
                </div>
              </div>
              {preview.on_dnc && (
                <div className="text-[11px] font-mono text-yellow-400 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> Already on DNC list
                </div>
              )}
            </div>
          )}

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

// ── Standalone "Lookup any number" widget ────────────────────────────────────
function LookupWidget() {
  const [phone, setPhone] = useState("");
  const [result, setResult] = useState<SpamCheckResp | null>(null);
  const { toast } = useToast();

  const check = useMutation({
    mutationFn: () => customFetch(`/api/dnc/check/${encodeURIComponent(phone)}`) as Promise<SpamCheckResp>,
    onSuccess: (d) => setResult(d),
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const rescan = useMutation({
    mutationFn: () => customFetch(`/api/dnc/scan/${encodeURIComponent(phone)}`, { method: "POST" }) as Promise<SpamCheckResp & { phoneNumber: string }>,
    onSuccess: (d) => { setResult(d); toast({ title: "Re-scanned" }); },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  return (
    <div className="border border-border rounded bg-[hsl(224,71%,3%)] p-4 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <Search className="w-3.5 h-3.5 text-primary" />
        <h3 className="text-xs font-mono uppercase tracking-wider text-foreground">Spam Lookup</h3>
        <span className="ml-auto text-[10px] font-mono text-muted-foreground">
          Check any number against DNC + carrier reputation
        </span>
      </div>
      <div className="flex gap-2">
        <Input
          value={phone}
          onChange={e => { setPhone(e.target.value); setResult(null); }}
          onKeyDown={e => { if (e.key === "Enter" && phone.trim()) check.mutate(); }}
          className="font-mono text-sm"
          placeholder="+14155550100  — paste any number to check"
        />
        <Button
          size="sm"
          className="font-mono text-[10px] uppercase tracking-wider shrink-0"
          disabled={!phone.trim() || check.isPending}
          onClick={() => check.mutate()}
        >
          {check.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
          <span className="ml-1">Check</span>
        </Button>
        {result && (
          <Button
            size="sm"
            variant="outline"
            className="font-mono text-[10px] uppercase tracking-wider shrink-0"
            disabled={rescan.isPending}
            onClick={() => rescan.mutate()}
            title="Force fresh Telnyx lookup (bypass cache)"
          >
            {rescan.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            <span className="ml-1">Re-scan</span>
          </Button>
        )}
      </div>
      {result && (
        <div className="mt-3 grid grid-cols-4 gap-3 text-[11px] font-mono">
          <div>
            <div className="text-muted-foreground text-[9px] uppercase mb-1">Score</div>
            <SpamBadge score={result.spam_score} />
          </div>
          <div>
            <div className="text-muted-foreground text-[9px] uppercase mb-1">Line Type</div>
            <div className="text-foreground">{result.line_type ?? "unknown"}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-[9px] uppercase mb-1">Carrier</div>
            <div className="text-foreground truncate" title={result.carrier_name ?? ""}>{result.carrier_name ?? "—"}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-[9px] uppercase mb-1">Status</div>
            <div className={cn("flex items-center gap-1", result.blocked ? "text-red-400" : "text-green-400")}>
              {result.blocked ? <ShieldX className="w-3 h-3" /> : <ShieldCheck className="w-3 h-3" />}
              {result.blocked ? "BLOCKED" : "ALLOWED"}
              {result.cached && <span className="text-muted-foreground ml-1">(cached)</span>}
            </div>
          </div>
        </div>
      )}
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

  const rescan = useMutation({
    mutationFn: (number: string) => customFetch(`/api/dnc/scan/${encodeURIComponent(number)}`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dnc"] });
      toast({ title: "Re-scanned" });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const totalBlocked = (data ?? []).filter(e => (e.spam_score ?? 0) >= 80 || !e.auto_blocked).length;
  const autoBlocked = (data ?? []).filter(e => e.auto_blocked).length;

  return (
    <Layout>
      {showAdd && <AddModal onClose={() => setShowAdd(false)} />}
      {showImport && <PasteImportModal onClose={() => setShowImport(false)} />}

      <PageHeader
        title="Do Not Call List"
        subtitle={`${totalBlocked} blocked · ${autoBlocked} auto-detected as spam`}
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
        <LookupWidget />

        <div className="border border-border rounded bg-[hsl(224,71%,3%)] overflow-hidden">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Phone Number</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Spam Score</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Line Type</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Carrier</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Reason</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Source</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Added</th>
                <th className="w-20 px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                [...Array(5)].map((_, i) => (
                  <tr key={i}>
                    {[...Array(8)].map((_, j) => (
                      <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>
                    ))}
                  </tr>
                ))
              ) : (data ?? []).length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center">
                    <ShieldX className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                    <p className="text-muted-foreground">DNC list is empty. Numbers added here — manually or auto-detected as spam — will never be dialed and will be hung up if they call in.</p>
                  </td>
                </tr>
              ) : (data ?? []).map((entry) => (
                <tr key={entry.id} className="border-b border-border/30 hover:bg-white/2 transition-colors">
                  <td className="px-4 py-3 text-primary font-medium">{entry.phone_number}</td>
                  <td className="px-4 py-3"><SpamBadge score={entry.spam_score ?? 0} /></td>
                  <td className="px-4 py-3 text-muted-foreground">{entry.line_type ?? "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground truncate max-w-[160px]" title={entry.carrier_name ?? ""}>{entry.carrier_name ?? "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground truncate max-w-[200px]" title={entry.reason ?? ""}>{entry.reason ?? "—"}</td>
                  <td className="px-4 py-3">
                    {entry.auto_blocked ? (
                      <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-400 border border-orange-500/30">AUTO</span>
                    ) : (
                      <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/30">MANUAL</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{new Date(entry.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => rescan.mutate(entry.phone_number)}
                        className="text-muted-foreground hover:text-foreground transition-colors"
                        title="Re-scan spam score"
                        disabled={rescan.isPending}
                      >
                        <RefreshCw className={cn("w-3.5 h-3.5", rescan.isPending && "animate-spin")} />
                      </button>
                      <button
                        onClick={() => remove.mutate(entry.id)}
                        className="text-muted-foreground hover:text-destructive transition-colors"
                        title="Remove from DNC"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
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
