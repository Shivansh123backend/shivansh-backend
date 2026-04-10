import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
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
} from "lucide-react";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/campaigns", label: "Campaigns", icon: Megaphone },
  { href: "/leads", label: "Lead Lists", icon: List },
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

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { logout } = useAuth();

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <aside className="w-52 flex-shrink-0 flex flex-col border-r border-border bg-[hsl(224,71%,3%)]">
        <div className="flex items-center gap-2.5 px-4 py-4 border-b border-border">
          <div className="w-7 h-7 rounded bg-primary/20 border border-primary/40 flex items-center justify-center">
            <Radio className="w-3.5 h-3.5 text-primary" />
          </div>
          <div>
            <p className="text-xs font-bold tracking-widest font-mono text-primary uppercase">NexusCall</p>
            <p className="text-[9px] text-muted-foreground font-mono tracking-wider">AI Operations</p>
          </div>
        </div>

        <nav className="flex-1 px-2 py-2 space-y-0.5 overflow-y-auto">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
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

        <UserFooter onLogout={logout} />
      </aside>

      <main className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          {children}
        </div>
      </main>
    </div>
  );
}

function UserFooter({ onLogout }: { onLogout: () => void }) {
  const initials = "A";
  return (
    <div className="border-t border-border p-3 space-y-2">
      <div className="flex items-center gap-2.5 px-2 py-1.5">
        <div className="w-7 h-7 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center flex-shrink-0">
          <span className="text-[10px] font-bold font-mono text-primary">{initials}</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-foreground font-medium truncate">Admin User</p>
          <p className="text-[10px] text-muted-foreground truncate">Company Admin</p>
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
