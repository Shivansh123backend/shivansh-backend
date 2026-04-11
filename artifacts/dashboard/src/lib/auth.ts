import { createContext, useContext, useState } from "react";
import { setAuthTokenGetter, setOnUnauthorized } from "@workspace/api-client-react";

const TOKEN_KEY = "auth_token";
const USER_KEY = "auth_user";

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: "admin" | "supervisor" | "agent";
  status: string;
}

export interface AuthContextType {
  token: string | null;
  user: AuthUser | null;
  login: (token: string, user: AuthUser) => void;
  logout: () => void;
  setUserStatus: (status: string) => void;
}

setAuthTokenGetter(() => localStorage.getItem(TOKEN_KEY));

setOnUnauthorized(() => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
  window.location.href = `${base}/login?reason=session_expired`;
});

function loadUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

export const AuthContext = createContext<AuthContextType>({
  token: null,
  user: null,
  login: () => {},
  logout: () => {},
  setUserStatus: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function useAuthState(): AuthContextType {
  const [token, setToken] = useState<string | null>(localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState<AuthUser | null>(loadUser);

  const login = (newToken: string, newUser: AuthUser) => {
    localStorage.setItem(TOKEN_KEY, newToken);
    localStorage.setItem(USER_KEY, JSON.stringify(newUser));
    setToken(newToken);
    setUser(newUser);
  };

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
  };

  const setUserStatus = (status: string) => {
    if (!user) return;
    const updated = { ...user, status };
    localStorage.setItem(USER_KEY, JSON.stringify(updated));
    setUser(updated);
  };

  return { token, user, login, logout, setUserStatus };
}
