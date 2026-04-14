import { useState, useRef, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { customFetch } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Megaphone,
  List,
  Tag,
  Users,
  Layers,
  Radio,
  PhoneIncoming,
  GitBranch,
  PhoneCall,
  BarChart2,
  Settings,
  LogOut,
  Activity,
  Mic2,
  Phone,
  PhoneMissed,
  ChevronDown,
  Bot,
  ShieldX,
} from "lucide-react";

// ── Navigation items ────────────────────────────────────────────────────────────
const ADMIN_NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/campaigns", label: "Campaigns", icon: Megaphone },
  { href: "/leads", label: "Lead Lists", icon: List },
  { href: "/dnc", label: "DNC List", icon: ShieldX },
  { href: "/agents", label: "AI Agents", icon: Bot },
  { href: "/voices", label: "Voices", icon: Mic2 },
  { href: "/dispositions", label: "Dispositions", icon: Tag },
  { href: "/users", label: "Users", icon: Users },
  { href: "/queues", label: "Queues", icon: Layers },
  { href: "/live-monitor", label: "Live Monitor", icon: Activity },
  { href: "/numbers", label: "DIDs", icon: PhoneIncoming },
  { href: "/inbound-routes", label: "Inbound Routes", icon: GitBranch },
  { href: "/calls", label: "CDR", icon: PhoneCall },
  { href: "/analytics", label: "Analytics", icon: BarChart2 },
  { href: "/settings", label: "Settings", icon: Settings },
];

const AGENT_NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/dialer", label: "Dialer", icon: Phone },
  { href: "/callbacks", label: "Callbacks", icon: PhoneMissed },
  { href: "/calls", label: "Call History", icon: PhoneCall },
];

// ── Agent status configuration ──────────────────────────────────────────────────
const STATUSES = [
  { value: "available", label: "Available", color: "bg-green-400" },
  { value: "busy", label: "Busy", color: "bg-red-400" },
  { value: "break", label: "Break", color: "bg-orange-400" },
  { value: "offline", label: "Offline", color: "bg-gray-400" },
];

function getStatusColor(status: string) {
  return STATUSES.find(s => s.value === status)?.color ?? "bg-gray-400";
}

function getStatusLabel(status: string) {
  return STATUSES.find(s => s.value === status)?.label ?? "Offline";
}

// ── Agent status dropdown ────────────────────────────────────────────────────────
function AgentStatusDropdown() {
  const { user, setUserStatus } = useAuth();
  const [open, setOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current = user?.status ?? "offline";

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  const changeStatus = async (status: string) => {
    setUpdating(true);
    setOpen(false);
    try {
      await customFetch("/api/users/me/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      setUserStatus(status);
    } catch {
      // silently ignore — local state still updated
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        disabled={updating}
        className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-mono hover:bg-white/5 transition-colors"
      >
        <span className={cn("w-1.5 h-1.5 rounded-full", getStatusColor(current))} />
        <span className="text-foreground">{getStatusLabel(current)}</span>
        <ChevronDown className={cn("w-3 h-3 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-36 rounded border border-border bg-[hsl(224,71%,4%)] shadow-xl z-50 py-1">
          {STATUSES.map(s => (
            <button
              key={s.value}
              onClick={() => changeStatus(s.value)}
              className={cn(
                "w-full flex items-center gap-2 px-3 py-1.5 text-[10px] font-mono hover:bg-white/5 transition-colors text-left",
                s.value === current ? "text-foreground" : "text-muted-foreground"
              )}
            >
              <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", s.color)} />
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Layout ─────────────────────────────────────────────────────────────────
export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { logout, user } = useAuth();
  const isAgent = user?.role === "agent";
  const navItems = isAgent ? AGENT_NAV : ADMIN_NAV;

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <aside className="w-52 flex-shrink-0 flex flex-col border-r border-border bg-[hsl(224,71%,3%)]">
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-4 py-4 border-b border-border">
          <div className="w-7 h-7 rounded bg-primary/20 border border-primary/40 flex items-center justify-center">
            <Radio className="w-3.5 h-3.5 text-primary" />
          </div>
          <div>
            <p className="text-xs font-bold tracking-widest font-mono text-primary uppercase">SHIVANSH</p>
            <p className="text-[9px] text-muted-foreground font-mono tracking-wider">
              {isAgent ? "Agent Console" : "AI Operations"}
            </p>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-2 space-y-0.5 overflow-y-auto">
          {navItems.map(({ href, label, icon: Icon }) => {
            const isActive = href === "/" ? location === "/" : location.startsWith(href);
            return (
              <Link key={href} href={href}>
                <div
                  className={cn(
                    "flex items-center gap-2.5 px-3 py-1.5 rounded text-xs cursor-pointer transition-all",
                    isActive
                      ? "bg-primary/15 text-primary border border-primary/25 font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                  )}
                >
                  <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                  {label}
                </div>
              </Link>
            );
          })}
        </nav>

        <UserFooter onLogout={logout} user={user} />
      </aside>

      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Agent status bar */}
        {isAgent && (
          <div className="flex items-center justify-end gap-4 px-4 py-1.5 border-b border-border bg-[hsl(224,71%,3%)] shrink-0">
            <span className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
              SIP: Ready
            </span>
            <AgentStatusDropdown />
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          {children}
        </div>
      </main>
    </div>
  );
}

function UserFooter({ onLogout, user }: { onLogout: () => void; user: { name: string; email: string; role: string } | null }) {
  const initials = user?.name ? user.name.split(" ").map(p => p[0]).join("").slice(0, 2).toUpperCase() : "?";
  return (
    <div className="border-t border-border p-3 space-y-2">
      <div className="flex items-center gap-2.5 px-2 py-1.5">
        <div className="w-7 h-7 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center flex-shrink-0">
          <span className="text-[10px] font-bold font-mono text-primary">{initials}</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-foreground font-medium truncate">{user?.name ?? "User"}</p>
          <p className="text-[10px] text-muted-foreground truncate capitalize">{user?.role ?? "agent"}</p>
        </div>
      </div>
      <button
        onClick={onLogout}
        className="w-full flex items-center gap-2 px-3 py-1.5 rounded text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
      >
        <LogOut className="w-3.5 h-3.5" />
        Sign out
      </button>
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-6 py-4 border-b border-border">
      <div>
        <h1 className="text-sm font-bold font-mono tracking-widest text-foreground uppercase">{title}</h1>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5 font-mono">{subtitle}</p>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}
