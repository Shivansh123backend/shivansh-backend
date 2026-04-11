import { useState, useCallback } from "react";
import { Layout, PageHeader } from "@/components/layout";
import { customFetch, useListCampaigns } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Phone, Delete, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

type DialResult = { success: boolean; jobId?: string; fromNumber?: string; error?: string };

const NUMPAD = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  ["*", "0", "#"],
];

export default function DialerPage() {
  const [phone, setPhone] = useState("");
  const [campaignId, setCampaignId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DialResult | null>(null);
  const { data: campaigns = [] } = useListCampaigns() as { data: Array<{ id: number; name: string; fromNumber?: string }> | undefined };
  const { toast } = useToast();

  const dial = useCallback((digit: string) => {
    setPhone(p => (p + digit).slice(0, 16));
    setResult(null);
  }, []);

  const backspace = useCallback(() => {
    setPhone(p => p.slice(0, -1));
    setResult(null);
  }, []);

  const handleCall = async () => {
    if (!phone.trim() || !campaignId) {
      toast({ title: "Select a campaign and enter a number first", variant: "destructive" });
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const data = await customFetch(`/api/campaigns/${campaignId}/test-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.trim() }),
      }) as DialResult;
      setResult(data);
      if (data.success) {
        toast({ title: "Call queued", description: `Job ID: ${data.jobId}` });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Call failed";
      setResult({ success: false, error: msg });
      toast({ title: "Call failed", description: msg, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Layout>
      <PageHeader title="Dialer" subtitle="Place outbound calls" />
      <div className="p-6 flex justify-center">
        <div className="w-full max-w-sm space-y-5">
          {/* Campaign selector */}
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Campaign</Label>
            <Select value={campaignId} onValueChange={v => { setCampaignId(v); setResult(null); }}>
              <SelectTrigger className="font-mono text-sm">
                <SelectValue placeholder="Select campaign..." />
              </SelectTrigger>
              <SelectContent>
                {(campaigns ?? []).map(c => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Number display */}
          <div className="bg-[hsl(224,71%,3%)] border border-border rounded p-4">
            <div className="flex items-center gap-2 min-h-[42px]">
              <span className="flex-1 text-xl font-mono text-foreground tracking-widest text-center">
                {phone || <span className="text-muted-foreground text-base">Enter number...</span>}
              </span>
              {phone && (
                <button
                  type="button"
                  onClick={backspace}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Delete className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Number pad */}
            <div className="mt-4 grid grid-cols-3 gap-2">
              {NUMPAD.flat().map(digit => (
                <button
                  key={digit}
                  type="button"
                  onClick={() => dial(digit)}
                  className="h-12 rounded-lg bg-white/5 hover:bg-white/10 border border-border/50 hover:border-border font-mono text-lg text-foreground transition-all active:scale-95"
                >
                  {digit}
                </button>
              ))}
            </div>

            {/* Manual input */}
            <div className="mt-3">
              <Input
                value={phone}
                onChange={e => { setPhone(e.target.value.slice(0, 16)); setResult(null); }}
                className="font-mono text-sm text-center"
                placeholder="+1XXXXXXXXXX"
              />
            </div>
          </div>

          {/* Result */}
          {result && (
            <div className={`rounded border px-3 py-2.5 flex items-start gap-2 ${result.success ? "border-green-500/30 bg-green-500/5" : "border-red-500/30 bg-red-500/5"}`}>
              {result.success
                ? <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
                : <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />}
              <div className="text-xs font-mono">
                {result.success ? (
                  <>
                    <p className="text-green-400 font-medium">Call queued — Job #{result.jobId}</p>
                    <p className="text-muted-foreground mt-0.5">From: {result.fromNumber}</p>
                  </>
                ) : (
                  <p className="text-red-300">{result.error}</p>
                )}
              </div>
            </div>
          )}

          {/* Call button */}
          <Button
            className="w-full h-12 bg-green-600 hover:bg-green-700 text-white font-mono uppercase tracking-wider text-sm"
            onClick={handleCall}
            disabled={loading || !phone.trim() || !campaignId}
          >
            {loading ? (
              <span className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Connecting...</span>
            ) : (
              <span className="flex items-center gap-2"><Phone className="w-4 h-4" /> Call</span>
            )}
          </Button>
        </div>
      </div>
    </Layout>
  );
}
