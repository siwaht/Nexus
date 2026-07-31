import { Link, useRoute } from 'wouter';
import {
  Bot,
  ChevronLeft,
  Database,
  Info,
  Key,
  KeyRound,
  Palette,
  Plug,
  Brain,
  Sparkles,
  Wrench,
} from 'lucide-react';

import { AboutTab } from '@/components/settings/about-tab';
import { AppearanceTab } from '@/components/settings/appearance-tab';
import { DataTab } from '@/components/settings/data-tab';
import { KeysTab } from '@/components/settings/keys-tab';
import { McpTab } from '@/components/settings/mcp-tab';
import { MemoryTab } from '@/components/settings/memory-tab';
import { ModelsTab } from '@/components/settings/models-tab';
import { ProvidersTab } from '@/components/settings/providers-tab';
import { SkillsTab } from '@/components/settings/skills-tab';
import { ToolsTab } from '@/components/settings/tools-tab';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

/**
 * Settings.
 *
 * Tabs are routes (`/settings/:tab`) so a tab is linkable and survives a reload
 * — which matters when an error elsewhere in the app links straight at the fix.
 */

const TABS = [
  { value: 'providers', label: 'Providers', icon: KeyRound, Component: ProvidersTab },
  { value: 'models', label: 'Models', icon: Sparkles, Component: ModelsTab },
  { value: 'tools', label: 'Tools', icon: Wrench, Component: ToolsTab },
  { value: 'mcp', label: 'MCP', icon: Plug, Component: McpTab },
  { value: 'skills', label: 'Skills', icon: Bot, Component: SkillsTab },
  { value: 'keys', label: 'API keys', icon: Key, Component: KeysTab },
  { value: 'memory', label: 'Memory', icon: Brain, Component: MemoryTab },
  { value: 'appearance', label: 'Appearance', icon: Palette, Component: AppearanceTab },
  { value: 'data', label: 'Data & usage', icon: Database, Component: DataTab },
  { value: 'about', label: 'About', icon: Info, Component: AboutTab },
] as const;

export default function Settings() {
  const [, params] = useRoute('/settings/:tab');
  const requested = params?.tab ?? 'providers';
  const active = TABS.find((tab) => tab.value === requested) ?? TABS[0];
  const ActiveComponent = active.Component;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border bg-card px-6 py-4">
        <div className="mx-auto flex max-w-6xl items-center gap-4">
          <Button asChild variant="ghost" size="sm" className="gap-2">
            <Link href="/" data-testid="link-back">
              <ChevronLeft className="h-4 w-4" />
              Back
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Providers, models, tools, MCP servers, skills, memory and data
            </p>
          </div>
        </div>
      </header>

      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-6xl p-6">
          <div className="flex flex-col gap-6 lg:flex-row">
            <nav
              className="flex shrink-0 gap-1 overflow-x-auto lg:w-48 lg:flex-col lg:overflow-visible"
              aria-label="Settings sections"
            >
              {TABS.map((tab) => {
                const Icon = tab.icon;
                const isActive = tab.value === active.value;
                return (
                  <Link
                    key={tab.value}
                    href={`/settings/${tab.value}`}
                    className={cn(
                      'flex shrink-0 items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                      isActive
                        ? 'bg-accent font-medium text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                    )}
                    aria-current={isActive ? 'page' : undefined}
                    data-testid={`tab-${tab.value}`}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {tab.label}
                  </Link>
                );
              })}
            </nav>

            <div className="min-w-0 flex-1">
              <ActiveComponent />
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
