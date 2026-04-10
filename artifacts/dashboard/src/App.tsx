import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthContext, useAuth, useAuthState } from "@/lib/auth";
import React, { useEffect } from "react";
import Login from "@/pages/login";
import DashboardPage from "@/pages/dashboard";
import CampaignsPage from "@/pages/campaigns";
import AgentsPage from "@/pages/agents";
import LeadsPage from "@/pages/leads";
import CallsPage from "@/pages/calls";
import NumbersPage from "@/pages/numbers";
import UsersPage from "@/pages/users";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    },
  },
});

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { token } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!token) {
      setLocation("/login");
    }
  }, [token, setLocation]);

  if (!token) return null;

  return <Component />;
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/">
        <ProtectedRoute component={DashboardPage} />
      </Route>
      <Route path="/campaigns">
        <ProtectedRoute component={CampaignsPage} />
      </Route>
      <Route path="/agents">
        <ProtectedRoute component={AgentsPage} />
      </Route>
      <Route path="/leads">
        <ProtectedRoute component={LeadsPage} />
      </Route>
      <Route path="/calls">
        <ProtectedRoute component={CallsPage} />
      </Route>
      <Route path="/numbers">
        <ProtectedRoute component={NumbersPage} />
      </Route>
      <Route path="/users">
        <ProtectedRoute component={UsersPage} />
      </Route>
      <Route>
        <div className="flex h-screen items-center justify-center font-mono text-sm text-muted-foreground">
          404 — Not Found
        </div>
      </Route>
    </Switch>
  );
}

function AppInner() {
  const authState = useAuthState();
  return (
    <AuthContext.Provider value={authState}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <Router />
      </WouterRouter>
      <Toaster />
    </AuthContext.Provider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <div className="dark">
          <AppInner />
        </div>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
