import { useState } from "react";
import {
  useListUsers,
  useCreateUser,
  customFetch,
  getListUsersQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Layout, PageHeader } from "@/components/layout";
import { StatusBadge } from "./dashboard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Plus, X, ShieldCheck, Shield, User, Trash2 } from "lucide-react";

const ROLE_ICONS = { admin: ShieldCheck, supervisor: Shield, agent: User };
const ROLE_STYLES: Record<string, string> = {
  admin: "border-cyan-500/30 text-cyan-400 bg-cyan-500/5",
  supervisor: "border-purple-500/30 text-purple-400 bg-purple-500/5",
  agent: "border-border text-muted-foreground",
};

function CreateModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("agent");
  const createUser = useCreateUser();
  const qc = useQueryClient();
  const { toast } = useToast();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createUser.mutate(
      { data: { name, email, password, role: role as "admin" | "supervisor" | "agent" } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListUsersQueryKey() });
          toast({ title: "Team member added" });
          onClose();
        },
        onError: () => toast({ title: "Failed to create user", variant: "destructive" }),
      }
    );
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded w-full max-w-md">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <p className="text-xs font-mono uppercase tracking-widest text-foreground">Add Team Member</p>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Full Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} className="font-mono text-sm" required />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Email</Label>
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)} className="font-mono text-sm" required />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Password</Label>
            <Input type="password" value={password} onChange={e => setPassword(e.target.value)} className="font-mono text-sm" minLength={8} required />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground">Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger className="font-mono text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="agent">Agent</SelectItem>
                <SelectItem value="supervisor">Supervisor</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" className="w-full font-mono text-xs uppercase tracking-wider" disabled={createUser.isPending}>
            {createUser.isPending ? "Creating..." : "Add Member"}
          </Button>
        </form>
      </div>
    </div>
  );
}

export default function UsersPage() {
  const { data: users, isLoading } = useListUsers();
  const [showCreate, setShowCreate] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  // Decode the current admin's userId from the JWT so we can hide the delete
  // button on their own row (the API also blocks it server-side).
  const currentUserId = (() => {
    try {
      const t = localStorage.getItem("auth_token");
      if (!t) return null;
      const payload = JSON.parse(atob(t.split(".")[1]));
      return Number(payload.userId ?? payload.sub ?? null) || null;
    } catch { return null; }
  })();

  const handleDelete = async (u: { id: number; name: string }) => {
    if (!window.confirm(`Remove ${u.name}? This cannot be undone.`)) return;
    setDeletingId(u.id);
    try {
      await customFetch(`/api/users/${u.id}`, { method: "DELETE" });
      toast({ title: `${u.name} removed` });
      qc.invalidateQueries({ queryKey: getListUsersQueryKey() });
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message ?? "Failed to remove user";
      toast({ title: msg, variant: "destructive" });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Layout>
      {showCreate && <CreateModal onClose={() => setShowCreate(false)} />}
      <PageHeader
        title="Team"
        subtitle={`${(users ?? []).length} members`}
        action={
          <Button size="sm" className="font-mono text-xs uppercase tracking-wider h-7 px-3" onClick={() => setShowCreate(true)}>
            <Plus className="w-3 h-3 mr-1.5" /> Add Member
          </Button>
        }
      />
      <div className="p-6">
        <div className="border border-border rounded bg-card overflow-hidden">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Member</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Email</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Role</th>
                <th className="text-left px-4 py-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">Status</th>
                <th className="px-4 py-2.5 w-12"></th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                [...Array(5)].map((_, i) => (
                  <tr key={i}>
                    {[...Array(5)].map((_, j) => (
                      <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>
                    ))}
                  </tr>
                ))
              ) : (users ?? []).map((u: { id: number; name: string; email: string; role: string; status: string }) => {
                const RoleIcon = ROLE_ICONS[u.role as keyof typeof ROLE_ICONS] ?? User;
                return (
                  <tr key={u.id} className="border-b border-border/30 hover:bg-white/2 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-6 h-6 rounded bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
                          <RoleIcon className="w-3 h-3 text-primary" />
                        </div>
                        <span className="text-foreground font-medium">{u.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{u.email}</td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className={`text-[9px] font-mono uppercase ${ROLE_STYLES[u.role] ?? "border-border text-muted-foreground"}`}>
                        {u.role}
                      </Badge>
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={u.status} /></td>
                    <td className="px-4 py-3 text-right">
                      {u.id !== currentUserId && (
                        <button
                          onClick={() => handleDelete(u)}
                          disabled={deletingId === u.id}
                          title="Remove member"
                          className="p-1.5 rounded text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
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
