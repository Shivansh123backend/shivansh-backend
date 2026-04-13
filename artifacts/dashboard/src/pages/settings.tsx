import { useState } from "react";
import { Layout, PageHeader } from "@/components/layout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Settings,
  Shield,
  Phone,
  Radio,
  CheckCircle,
  XCircle,
  Zap,
} from "lucide-react";

function SettingSection({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="border border-border rounded bg-[hsl(224,71%,3%)]">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Icon className="w-3.5 h-3.5 text-primary" />
        <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{title}</p>
      </div>
      <div className="p-4 space-y-4">{children}</div>
    </div>
  );
}

function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1">
        <p className="text-xs font-mono text-foreground">{label}</p>
        {description && <p className="text-[10px] font-mono text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function StatusBadge({ active, label }: { active: boolean; label?: string }) {
  return (
    <div className={`flex items-center gap-1.5 text-[10px] font-mono px-2 py-1 rounded border ${
      active ? "border-green-500/30 text-green-400 bg-green-500/5" : "border-border text-muted-foreground"
    }`}>
      {active ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
      {label ?? (active ? "Enabled" : "Disabled")}
    </div>
  );
}

export default function SettingsPage() {
  const { toast } = useToast();
  const [jwtExpiry, setJwtExpiry] = useState("24h");
  const [maxAgents, setMaxAgents] = useState("25");
  const [voipEndpoint, setVoipEndpoint] = useState("");
  const [telnyxKey, setTelnyxKey] = useState("");
  const [twilioSid, setTwilioSid] = useState("");
  const [twilioToken, setTwilioToken] = useState("");
  const [redisHost, setRedisHost] = useState("");
  const [redisPort, setRedisPort] = useState("6379");

  const handleSave = (section: string) => {
    toast({ title: `${section} settings saved`, description: "Changes will take effect on next restart." });
  };

  return (
    <Layout>
      <PageHeader title="Settings" subtitle="Platform configuration" />
      <div className="p-6 space-y-4">
        <SettingSection title="Platform" icon={Settings}>
          <SettingRow label="Max Agents per Account" description="Maximum number of AI agents allowed per account">
            <Input
              value={maxAgents}
              onChange={e => setMaxAgents(e.target.value)}
              className="font-mono text-sm w-24 text-center"
              type="number"
              min="1"
              max="100"
            />
          </SettingRow>
          <div className="pt-2 border-t border-border/50">
            <Button size="sm" className="font-mono text-xs uppercase tracking-wider" onClick={() => handleSave("Platform")}>
              Save Platform Settings
            </Button>
          </div>
        </SettingSection>

        <SettingSection title="Authentication" icon={Shield}>
          <SettingRow label="JWT Expiry" description="How long login sessions last before requiring re-authentication">
            <Input
              value={jwtExpiry}
              onChange={e => setJwtExpiry(e.target.value)}
              className="font-mono text-sm w-24 text-center"
              placeholder="24h"
            />
          </SettingRow>
          <SettingRow label="Session Secret" description="Secret key used to sign JWT tokens — set via SESSION_SECRET env var">
            <StatusBadge active={true} label="Configured" />
          </SettingRow>
          <div className="pt-2 border-t border-border/50">
            <Button size="sm" className="font-mono text-xs uppercase tracking-wider" onClick={() => handleSave("Auth")}>
              Save Auth Settings
            </Button>
          </div>
        </SettingSection>

        <SettingSection title="Telephony Providers" icon={Phone}>
          <div className="space-y-3">
            <div>
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">VoIP Endpoint URL</Label>
              <div className="flex gap-2 mt-1">
                <Input
                  value={voipEndpoint}
                  onChange={e => setVoipEndpoint(e.target.value)}
                  className="font-mono text-sm flex-1"
                  placeholder="https://your-voip-provider.com/api"
                />
                <StatusBadge active={false} label="Not Set" />
              </div>
            </div>
            <div>
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">Telnyx API Key</Label>
              <div className="flex gap-2 mt-1">
                <Input
                  value={telnyxKey}
                  onChange={e => setTelnyxKey(e.target.value)}
                  className="font-mono text-sm flex-1"
                  type="password"
                  placeholder="KEY..."
                />
                <StatusBadge active={true} label="Configured" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-[10px] font-mono uppercase text-muted-foreground">Twilio Account SID</Label>
                <Input
                  value={twilioSid}
                  onChange={e => setTwilioSid(e.target.value)}
                  className="font-mono text-sm mt-1"
                  placeholder="AC..."
                />
              </div>
              <div>
                <Label className="text-[10px] font-mono uppercase text-muted-foreground">Twilio Auth Token</Label>
                <Input
                  value={twilioToken}
                  onChange={e => setTwilioToken(e.target.value)}
                  className="font-mono text-sm mt-1"
                  type="password"
                />
              </div>
            </div>
          </div>
          <div className="pt-2 border-t border-border/50">
            <p className="text-[10px] font-mono text-muted-foreground mb-2">Provider priority: VoIP → Telnyx → Twilio (fallback chain)</p>
            <Button size="sm" className="font-mono text-xs uppercase tracking-wider" onClick={() => handleSave("Telephony")}>
              Save Provider Settings
            </Button>
          </div>
        </SettingSection>

        <SettingSection title="Queue (Redis / BullMQ)" icon={Zap}>
          <SettingRow label="Queue Status" description="Redis must be configured to enable the BullMQ call queue">
            <StatusBadge active={false} label="Disabled" />
          </SettingRow>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">Redis Host</Label>
              <Input value={redisHost} onChange={e => setRedisHost(e.target.value)} className="font-mono text-sm" placeholder="localhost" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">Redis Port</Label>
              <Input value={redisPort} onChange={e => setRedisPort(e.target.value)} className="font-mono text-sm" placeholder="6379" />
            </div>
          </div>
          <div className="pt-2 border-t border-border/50">
            <p className="text-[10px] font-mono text-muted-foreground mb-2">Set REDIS_HOST and REDIS_PORT environment variables to enable queue</p>
            <Button size="sm" className="font-mono text-xs uppercase tracking-wider" onClick={() => handleSave("Queue")}>
              Save Queue Settings
            </Button>
          </div>
        </SettingSection>

        <SettingSection title="Integrations" icon={Radio}>
          {[
            { name: "ElevenLabs", desc: "AI voice synthesis", active: true },
            { name: "Telnyx WebRTC", desc: "Telephony & WebRTC calling", active: true },
            { name: "PlayHT", desc: "Text-to-speech voices", active: false },
            { name: "Azure Cognitive Speech", desc: "Microsoft speech services", active: false },
            { name: "WebSocket Monitoring", desc: "Real-time supervisor monitoring via Socket.IO", active: true },
          ].map(item => (
            <SettingRow key={item.name} label={item.name} description={item.desc}>
              <StatusBadge active={item.active} />
            </SettingRow>
          ))}
        </SettingSection>
      </div>
    </Layout>
  );
}
