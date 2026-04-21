import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useListLeads,
  useListCampaigns,
  getListLeadsQueryKey,
  customFetch,
} from "@workspace/api-client-react";
import { Layout, PageHeader } from "@/components/layout";
import { StatusBadge } from "./dashboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Plus, X, Filter, Upload, FileSpreadsheet, CheckCircle2, AlertCircle, ClipboardList, Trash2, FolderInput } from "lucide-react";

type LeadList = { id: number; name: string; description: string | null; campaignId: number | null; active: boolean; campaignName: string | null; leadsCount: number };

// ── Single-lead modal ──────────────────────────────────────────────────────────
function CreateModal({ onClose, campaigns }: { onClose: () => void; campaigns: { id: number; name: string }[] }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const qc = useQueryClient();
  const { toast } = useToast();

  const addLead = useMutation({
    mutationFn: async () => {
      return await customFetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          phone_number: phone,
          email: email || undefined,
          campaign_id: parseInt(campaignId),
        }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getListLeadsQueryKey() });
      toast({ title: "Lead added successfully" });
      onClose();
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!campaignId) {
      toast({ title: "Please select a campaign", variant: "destructive" });
      return;
    }
    addLead.mutate();
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[hsl(224,71%,3%)] border border-border rounded w-full max-w-md">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <p className="text-xs font-mono uppercase tracking-widest text-foreground">Add Lead</p>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Full Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} className="font-mono text-sm" placeholder="John Smith" required />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Phone Number</Label>
            <Input value={phone} onChange={e => setPhone(e.target.value)} className="font-mono text-sm" placeholder="+14155550100" required />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Email <span className="text-muted-foreground/50 normal-case">(optional)</span></Label>
            <Input value={email} onChange={e => setEmail(e.target.value)} className="font-mono text-sm" placeholder="john@example.com" type="email" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Campaign</Label>
            <Select value={campaignId} onValueChange={setCampaignId}>
              <SelectTrigger className="font-mono text-sm"><SelectValue placeholder="Select campaign" /></SelectTrigger>
              <SelectContent>
                {campaigns.map(c => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" className="w-full font-mono text-xs uppercase tracking-wider" disabled={addLead.isPending}>
            {addLead.isPending ? "Adding..." : "Add Lead"}
          </Button>
        </form>
      </div>
    </div>
  );
}

// ── CSV / XLSX bulk upload modal ───────────────────────────────────────────────
type UploadResult = {
  total_uploaded: number;
  total_skipped: number;
  invalid_numbers: number;
  duplicates: number;
  dnc_skipped: number;
};

function UploadModal({ onClose, campaigns }: { onClose: () => void; campaigns: { id: number; name: string }[] }) {
  const [campaignId, setCampaignId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("No file selected");
      if (!campaignId) throw new Error("Please select a campaign");
      const fd = new FormData();
      fd.append("file", file);
      fd.append("campaign_id", campaignId);
      const res = await fetch("/api/leads/upload", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("auth_token") ?? ""}`,
        },
        body: fd,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Upload failed (${res.status})`);
      }
      return res.json() as Promise<UploadResult>;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: getListLeadsQueryKey() });
      setResult(data);
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const pickFile = (f: File) => {
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    if (!["csv", "xlsx", "xls"].includes(ext)) {
      toast({ title: "Only CSV or XLSX files are supported", variant: "destructive" });
      return;
    }
    setFile(f);
    setResult(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) pickFile(f);
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[hsl(224,71%,3%)] border border-border rounded w-full max-w-lg">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <p className="text-xs font-mono uppercase tracking-widest text-foreground">Upload Leads (CSV / XLSX)</p>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-4">
          {/* Campaign selector */}
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Campaign</Label>
            <Select value={campaignId} onValueChange={setCampaignId}>
              <SelectTrigger className="font-mono text-sm"><SelectValue placeholder="Select campaign" /></SelectTrigger>
              <SelectContent>
                {campaigns.map(c => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Drop zone */}
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileRef.current?.click()}
            className={`border-2 border-dashed rounded-lg p-8 flex flex-col items-center gap-3 cursor-pointer transition-colors
              ${dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-white/[0.02]"}`}
          >
            <FileSpreadsheet className={`w-8 h-8 ${file ? "text-primary" : "text-muted-foreground"}`} />
            {file ? (
              <div className="text-center">
                <p className="text-sm font-mono text-foreground">{file.name}</p>
                <p className="text-[10px] font-mono text-muted-foreground mt-1">{(file.size / 1024).toFixed(1)} KB — click to change</p>
              </div>
            ) : (
              <div className="text-center">
                <p className="text-sm font-mono text-muted-foreground">Drop CSV or XLSX here</p>
                <p className="text-[10px] font-mono text-muted-foreground/60 mt-1">or click to browse</p>
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) pickFile(f); e.target.value = ""; }}
            />
          </div>

          {/* Column hint */}
          <div className="bg-white/[0.03] border border-border/50 rounded p-3 space-y-1">
            <p className="text-[10px] font-mono uppercase text-muted-foreground tracking-wider">Required columns</p>
            <p className="text-[11px] font-mono text-foreground/70">
              <span className="text-primary">phone_number</span>
              <span className="text-muted-foreground"> · </span>
              <span className="text-foreground/50">name</span>
              <span className="text-muted-foreground"> · </span>
              <span className="text-foreground/50">email (optional)</span>
            </p>
            <p className="text-[10px] font-mono text-muted-foreground/60 leading-relaxed">
              Also accepts: phone, Phone, mobile · name, Name, full_name
            </p>
          </div>

          {/* Result banner */}
          {result && (
            <div className={`rounded p-3 border text-xs font-mono space-y-1.5
              ${result.total_uploaded > 0 ? "bg-green-500/10 border-green-500/30 text-green-400" : "bg-yellow-500/10 border-yellow-500/30 text-yellow-400"}`}>
              <div className="flex items-center gap-2">
                {result.total_uploaded > 0 ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                <p className="font-semibold">{result.total_uploaded} lead{result.total_uploaded !== 1 ? "s" : ""} imported successfully</p>
              </div>
              {(result.total_skipped > 0) && (
                <div className="pl-6 space-y-0.5 text-[10px] opacity-80">
                  {result.invalid_numbers > 0 && <p>· {result.invalid_numbers} invalid / non-E.164 phone number{result.invalid_numbers !== 1 ? "s" : ""}</p>}
                  {result.duplicates > 0 && <p>· {result.duplicates} duplicate{result.duplicates !== 1 ? "s" : ""} already in campaign</p>}
                  {result.dnc_skipped > 0 && <p>· {result.dnc_skipped} on Do Not Call list — skipped</p>}
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <Button
              variant="outline"
              className="flex-1 font-mono text-xs uppercase tracking-wider"
              onClick={onClose}
            >
              {result ? "Done" : "Cancel"}
            </Button>
            <Button
              className="flex-1 font-mono text-xs uppercase tracking-wider"
              disabled={!file || !campaignId || upload.isPending}
              onClick={() => upload.mutate()}
            >
              {upload.isPending ? (
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" /> Uploading…</span>
              ) : (
                <span className="flex items-center gap-1.5"><Upload className="w-3 h-3" /> Upload</span>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Paste phone numbers modal ─────────────────────────────────────────────────
function PasteModal({ onClose, campaigns }: { onClose: () => void; campaigns: { id: number; name: string }[] }) {
  const [campaignId, setCampaignId] = useState("");
  const [text, setText] = useState("");
  const [result, setResult] = useState<UploadResult | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  const parsed = text
    .split(/[\n,;]+/)
    .map(s => s.replace(/[^\d+]/g, "").trim())
    .filter(s => s.length >= 7);

  const upload = useMutation({
    mutationFn: async () => {
      if (!campaignId) throw new Error("Please select a campaign");
      if (parsed.length === 0) throw new Error("No valid phone numbers found");
      const csv = "phone_number\n" + parsed.join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const fd = new FormData();
      fd.append("file", blob, "leads.csv");
      fd.append("campaign_id", campaignId);
      const res = await fetch("/api/leads/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("auth_token") ?? ""}` },
        body: fd,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Upload failed (${res.status})`);
      }
      return res.json() as Promise<UploadResult>;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: getListLeadsQueryKey() });
      setResult(data);
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[hsl(224,71%,3%)] border border-border rounded w-full max-w-lg">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <p className="text-xs font-mono uppercase tracking-widest text-foreground">Paste Phone Numbers</p>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Campaign</Label>
            <Select value={campaignId} onValueChange={setCampaignId}>
              <SelectTrigger className="font-mono text-sm"><SelectValue placeholder="Select campaign" /></SelectTrigger>
              <SelectContent>
                {campaigns.map(c => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">
              Phone Numbers
              {parsed.length > 0 && (
                <span className="ml-2 text-primary normal-case">{parsed.length} detected</span>
              )}
            </Label>
            <textarea
              value={text}
              onChange={e => { setText(e.target.value); setResult(null); }}
              placeholder={`+14155550100\n+14155550101\n+14155550102\n\nOne per line, or comma / semicolon separated.`}
              rows={8}
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <p className="text-[10px] font-mono text-muted-foreground/60">
              Accepts any format — +1 (415) 555-0100, 4155550100, etc. Duplicates are skipped automatically.
            </p>
          </div>

          {result && (
            <div className={`rounded p-3 border text-xs font-mono space-y-1.5
              ${result.total_uploaded > 0 ? "bg-green-500/10 border-green-500/30 text-green-400" : "bg-yellow-500/10 border-yellow-500/30 text-yellow-400"}`}>
              <div className="flex items-center gap-2">
                {result.total_uploaded > 0 ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                <p className="font-semibold">{result.total_uploaded} lead{result.total_uploaded !== 1 ? "s" : ""} imported successfully</p>
              </div>
              {(result.total_skipped > 0) && (
                <div className="pl-6 space-y-0.5 text-[10px] opacity-80">
                  {result.invalid_numbers > 0 && <p>· {result.invalid_numbers} invalid / non-E.164 phone number{result.invalid_numbers !== 1 ? "s" : ""}</p>}
                  {result.duplicates > 0 && <p>· {result.duplicates} duplicate{result.duplicates !== 1 ? "s" : ""} already in campaign</p>}
                  {result.dnc_skipped > 0 && <p>· {result.dnc_skipped} on Do Not Call list — skipped</p>}
                </div>
              )}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <Button variant="outline" className="flex-1 font-mono text-xs uppercase tracking-wider" onClick={onClose}>
              {result ? "Done" : "Cancel"}
            </Button>
            <Button
              className="flex-1 font-mono text-xs uppercase tracking-wider"
              disabled={parsed.length === 0 || !campaignId || upload.isPending}
              onClick={() => upload.mutate()}
            >
              {upload.isPending ? (
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" /> Importing…</span>
              ) : (
                <span className="flex items-center gap-1.5"><ClipboardList className="w-3 h-3" /> Import {parsed.length > 0 ? parsed.length : ""}</span>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Assign-to-list modal ─────────────────────────────────────────────────────
function AssignListModal({ ids, onClose, lists }: { ids: number[]; onClose: () => void; lists: LeadList[] }) {
  const [listId, setListId] = useState<string>("");
  const qc = useQueryClient();
  const { toast } = useToast();
  const mut = useMutation({
    mutationFn: async () => customFetch("/api/leads/bulk-assign-list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, listId: listId === "__none__" ? null : parseInt(listId) }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getListLeadsQueryKey() });
      qc.invalidateQueries({ queryKey: ["/api/lists"] });
      toast({ title: `${ids.length} lead${ids.length !== 1 ? "s" : ""} assigned` });
      onClose();
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[hsl(224,71%,3%)] border border-border rounded w-full max-w-md">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <p className="text-xs font-mono uppercase tracking-widest">Assign {ids.length} Lead{ids.length !== 1 ? "s" : ""} to List</p>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">List</Label>
            <Select value={listId} onValueChange={setListId}>
              <SelectTrigger className="font-mono text-sm"><SelectValue placeholder="Select a list" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— Remove from list —</SelectItem>
                {lists.map(l => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1 font-mono text-xs uppercase" onClick={onClose}>Cancel</Button>
            <Button className="flex-1 font-mono text-xs uppercase" disabled={!listId || mut.isPending} onClick={() => mut.mutate()}>
              {mut.isPending ? "Saving…" : "Assign"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function LeadsPage() {
  const [filterCampaign, setFilterCampaign] = useState("__all__");
  const [filterStatus, setFilterStatus] = useState("__all__");
  const { data: leads, isLoading } = useListLeads({
    campaignId: filterCampaign !== "__all__" ? parseInt(filterCampaign) : undefined,
    status: filterStatus !== "__all__" ? filterStatus : undefined,
  });
  const { data: campaigns } = useListCampaigns();
  const [showCreate, setShowCreate] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [showAssign, setShowAssign] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: lists = [] } = useQuery<LeadList[]>({
    queryKey: ["/api/lists"],
    queryFn: () => customFetch<LeadList[]>("/api/lists"),
  });

  const campaignMap = Object.fromEntries((campaigns ?? []).map((c: { id: number; name: string }) => [c.id, c.name]));
  const listMap = Object.fromEntries(lists.map(l => [l.id, l.name]));
  const visibleLeads = leads ?? [];
  const allChecked = visibleLeads.length > 0 && visibleLeads.every((l: { id: number }) => selected.has(l.id));

  const toggleAll = () => {
    if (allChecked) setSelected(new Set());
    else setSelected(new Set(visibleLeads.map((l: { id: number }) => l.id)));
  };
  const toggleOne = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const bulkDelete = useMutation({
    mutationFn: async () => customFetch("/api/leads/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: Array.from(selected) }),
    }),
    onSuccess: () => {
      const count = selected.size;
      qc.invalidateQueries({ queryKey: getListLeadsQueryKey() });
      qc.invalidateQueries({ queryKey: ["/api/lists"] });
      setSelected(new Set());
      toast({ title: `${count} lead${count !== 1 ? "s" : ""} deleted` });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  return (
    <Layout>
      {showCreate && <CreateModal onClose={() => setShowCreate(false)} campaigns={campaigns ?? []} />}
      {showUpload && <UploadModal onClose={() => setShowUpload(false)} campaigns={campaigns ?? []} />}
      {showPaste && <PasteModal onClose={() => setShowPaste(false)} campaigns={campaigns ?? []} />}
      {showAssign && <AssignListModal ids={Array.from(selected)} onClose={() => setShowAssign(false)} lists={lists} />}

      <PageHeader
        title="Leads"
        subtitle={`${(leads ?? []).length} records`}
        action={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="font-mono text-xs uppercase tracking-wider h-7 px-3"
              onClick={() => setShowPaste(true)}
            >
              <ClipboardList className="w-3 h-3 mr-1.5" /> Paste Numbers
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="font-mono text-xs uppercase tracking-wider h-7 px-3"
              onClick={() => setShowUpload(true)}
            >
              <Upload className="w-3 h-3 mr-1.5" /> Upload CSV
            </Button>
            <Button
              size="sm"
              className="font-mono text-xs uppercase tracking-wider h-7 px-3"
              onClick={() => setShowCreate(true)}
            >
              <Plus className="w-3 h-3 mr-1.5" /> Add Lead
            </Button>
          </div>
        }
      />

      {selected.size > 0 && (
        <div className="px-6 py-2 border-b border-border bg-primary/5 flex items-center gap-3">
          <span className="text-xs font-mono text-foreground">{selected.size} selected</span>
          <Button size="sm" variant="outline" className="font-mono text-xs uppercase tracking-wider h-7 px-3" onClick={() => setShowAssign(true)}>
            <FolderInput className="w-3 h-3 mr-1.5" /> Assign to List
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="font-mono text-xs uppercase tracking-wider h-7 px-3 border-destructive/40 text-destructive hover:bg-destructive/10"
            disabled={bulkDelete.isPending}
            onClick={() => {
              if (confirm(`Delete ${selected.size} lead${selected.size !== 1 ? "s" : ""}? This cannot be undone.`)) bulkDelete.mutate();
            }}
          >
            <Trash2 className="w-3 h-3 mr-1.5" /> {bulkDelete.isPending ? "Deleting…" : "Delete"}
          </Button>
          <Button size="sm" variant="ghost" className="font-mono text-xs uppercase tracking-wider h-7 px-3 ml-auto" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      <div className="px-6 py-3 border-b border-border flex items-center gap-3">
        <Filter className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        <Select value={filterCampaign} onValueChange={setFilterCampaign}>
          <SelectTrigger className="font-mono text-xs h-7 w-48">
            <SelectValue placeholder="All campaigns" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All campaigns</SelectItem>
            {(campaigns ?? []).map((c: { id: number; name: string }) => (
              <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="font-mono text-xs h-7 w-40">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All statuses</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="called">Called</SelectItem>
            <SelectItem value="callback">Callback</SelectItem>
            <SelectItem value="do_not_call">Do Not Call</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="p-6">
        <div className="border border-border rounded bg-[hsl(224,71%,3%)] overflow-hidden">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border">
                <th className="px-4 py-2.5 w-8">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={toggleAll}
                    className="w-3.5 h-3.5 cursor-pointer accent-primary"
                  />
                </th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">ID</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Name</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Phone</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Campaign</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">List</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Status</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                [...Array(6)].map((_, i) => (
                  <tr key={i}>
                    {[...Array(7)].map((_, j) => (
                      <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>
                    ))}
                  </tr>
                ))
              ) : visibleLeads.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                    No leads yet. Use <span className="text-primary">Upload CSV</span> to import in bulk or <span className="text-primary">Add Lead</span> to add one at a time.
                  </td>
                </tr>
              ) : visibleLeads.map((l: { id: number; name: string; phone?: string; phone_number?: string; campaignId?: number; campaign_id?: number; listId?: number | null; list_id?: number | null; status: string; email?: string | null }) => {
                const phone = l.phone || l.phone_number || "-";
                const cid = l.campaignId ?? l.campaign_id;
                const lid = l.listId ?? l.list_id ?? null;
                const isSel = selected.has(l.id);
                return (
                  <tr key={l.id} className={`border-b border-border/30 hover:bg-white/2 transition-colors ${isSel ? "bg-primary/5" : ""}`}>
                    <td className="px-4 py-3">
                      <input type="checkbox" checked={isSel} onChange={() => toggleOne(l.id)} className="w-3.5 h-3.5 cursor-pointer accent-primary" />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">#{l.id}</td>
                    <td className="px-4 py-3 text-foreground font-medium">{l.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{phone}</td>
                    <td className="px-4 py-3 text-muted-foreground">{cid ? campaignMap[cid] ?? `#${cid}` : "-"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{lid ? listMap[lid] ?? `#${lid}` : "-"}</td>
                    <td className="px-4 py-3"><StatusBadge status={l.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}
