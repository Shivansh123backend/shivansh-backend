import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Plus, X, Filter, Upload, FileSpreadsheet, CheckCircle2, AlertCircle } from "lucide-react";

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
type UploadResult = { total_uploaded: number; total_skipped: number };

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
            <div className={`flex items-start gap-2.5 rounded p-3 border text-xs font-mono
              ${result.total_uploaded > 0 ? "bg-green-500/10 border-green-500/30 text-green-400" : "bg-yellow-500/10 border-yellow-500/30 text-yellow-400"}`}>
              {result.total_uploaded > 0 ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
              <div>
                <p className="font-semibold">{result.total_uploaded} lead{result.total_uploaded !== 1 ? "s" : ""} imported</p>
                {result.total_skipped > 0 && (
                  <p className="text-[10px] opacity-80 mt-0.5">{result.total_skipped} row{result.total_skipped !== 1 ? "s" : ""} skipped (invalid phone or duplicate)</p>
                )}
              </div>
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

  const campaignMap = Object.fromEntries((campaigns ?? []).map((c: { id: number; name: string }) => [c.id, c.name]));

  return (
    <Layout>
      {showCreate && <CreateModal onClose={() => setShowCreate(false)} campaigns={campaigns ?? []} />}
      {showUpload && <UploadModal onClose={() => setShowUpload(false)} campaigns={campaigns ?? []} />}

      <PageHeader
        title="Leads"
        subtitle={`${(leads ?? []).length} records`}
        action={
          <div className="flex items-center gap-2">
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
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">ID</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Name</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Phone</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Campaign</th>
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
              ) : (leads ?? []).length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">
                    No leads yet. Use <span className="text-primary">Upload CSV</span> to import in bulk or <span className="text-primary">Add Lead</span> to add one at a time.
                  </td>
                </tr>
              ) : (leads ?? []).map((l: { id: number; name: string; phone?: string; phone_number?: string; campaignId?: number; campaign_id?: number; status: string; email?: string | null }) => {
                const phone = l.phone || l.phone_number || "-";
                const cid = l.campaignId ?? l.campaign_id;
                return (
                  <tr key={l.id} className="border-b border-border/30 hover:bg-white/2 transition-colors">
                    <td className="px-4 py-3 text-muted-foreground">#{l.id}</td>
                    <td className="px-4 py-3 text-foreground font-medium">{l.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{phone}</td>
                    <td className="px-4 py-3 text-muted-foreground">{cid ? campaignMap[cid] ?? `#${cid}` : "-"}</td>
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
