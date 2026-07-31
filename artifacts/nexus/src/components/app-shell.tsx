import { useState } from "react";
import { Link, useRoute } from "wouter";
import { useAuth } from "@workspace/replit-auth-web";
import { useHealthCheck } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  Terminal,
  LogOut,
  Sun,
  Moon,
  Circle,
} from "lucide-react";
import { useTheme } from "@/lib/theme-provider";

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isSettingsRoute] = useRoute("/settings");
  const { data: health } = useHealthCheck();

  const userInitials = user
    ? `${user.firstName?.[0] || ""}${user.lastName?.[0] || ""}`.toUpperCase() || user.email?.[0]?.toUpperCase() || "U"
    : "U";

  return (
    <div className="min-h-[100dvh] w-full flex bg-background">
      {/* Sidebar */}
      <aside
        className={`${
          sidebarCollapsed ? "w-0" : "w-64"
        } transition-all duration-200 ease-out border-r border-sidebar-border bg-sidebar flex flex-col shrink-0 overflow-hidden`}
      >
        <div className="p-4 border-b border-sidebar-border">
          <Button
            className="w-full justify-start gap-3 h-10 font-medium"
            data-testid="button-new-chat"
          >
            <Plus className="w-4 h-4" />
            New Chat
          </Button>
        </div>

        <div className="p-3 border-b border-sidebar-border">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search conversations..."
              className="pl-9 h-9 bg-sidebar-accent border-sidebar-border"
              data-testid="input-search-conversations"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          <p className="text-sm text-muted-foreground text-center py-8">No conversations yet</p>
        </div>

        <div className="p-3 border-t border-sidebar-border space-y-2">
          {health && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Circle className="w-2 h-2 fill-primary text-primary" />
              <span>API online</span>
            </div>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-sidebar-accent transition-colors text-left"
                data-testid="button-user-menu"
              >
                <Avatar className="w-8 h-8">
                  <AvatarFallback className="bg-primary text-primary-foreground text-sm font-medium">
                    {userInitials}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {user?.firstName || user?.lastName
                      ? `${user.firstName || ""} ${user.lastName || ""}`.trim()
                      : user?.email || "User"}
                  </p>
                </div>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => setTheme(theme === "dark" ? "light" : "dark")} data-testid="button-toggle-theme">
                {theme === "dark" ? <Sun className="w-4 h-4 mr-2" /> : <Moon className="w-4 h-4 mr-2" />}
                {theme === "dark" ? "Light mode" : "Dark mode"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={logout} data-testid="button-logout">
                <LogOut className="w-4 h-4 mr-2" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="h-14 border-b border-border bg-card flex items-center px-4 gap-3 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="shrink-0"
            data-testid="button-toggle-sidebar"
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen className="w-5 h-5" />
            ) : (
              <PanelLeftClose className="w-5 h-5" />
            )}
          </Button>

          <div className="flex items-center gap-2 shrink-0">
            <Terminal className="w-5 h-5 text-primary" />
            <h1 className="text-lg font-bold tracking-tight">Nexus</h1>
          </div>

          <div className="flex-1" />

          <Button
            variant="ghost"
            size="sm"
            className="gap-2 font-mono text-xs"
            disabled
            data-testid="button-model-picker"
          >
            Model picker
          </Button>

          <Link href="/settings">
            <Button
              variant={isSettingsRoute ? "secondary" : "ghost"}
              size="icon"
              data-testid="link-settings"
            >
              <Settings className="w-5 h-5" />
            </Button>
          </Link>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
