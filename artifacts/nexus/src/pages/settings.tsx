import { useState } from "react";
import { Link, useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProvidersTab } from "@/components/settings/providers-tab";
import { ComingSoonTab } from "@/components/settings/coming-soon-tab";
import {
  Database,
  Palette,
  Brain,
  Sparkles,
  Info,
  Key,
  ChevronLeft,
} from "lucide-react";

const TABS = [
  { value: "providers", label: "Providers", icon: Key },
  { value: "models", label: "Models", icon: Sparkles },
  { value: "memory", label: "Memory", icon: Brain },
  { value: "appearance", label: "Appearance", icon: Palette },
  { value: "data", label: "Data", icon: Database },
  { value: "about", label: "About", icon: Info },
] as const;

export default function Settings() {
  const [, params] = useRoute("/settings/:tab");
  const activeTab = (params?.tab as typeof TABS[number]["value"]) || "providers";

  return (
    <div className="w-full h-full flex flex-col">
      <div className="border-b border-border bg-card px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center gap-4">
          <Link href="/">
            <Button variant="ghost" size="sm" className="gap-2" data-testid="link-back">
              <ChevronLeft className="w-4 h-4" />
              Back
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Configure providers, models, and preferences
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto p-6">
          <Tabs value={activeTab} className="flex gap-6">
            <TabsList className="flex-col h-auto bg-transparent p-0 space-y-1 w-48 shrink-0">
              {TABS.map((tab) => {
                const Icon = tab.icon;
                return (
                  <Link key={tab.value} href={`/settings/${tab.value}`}>
                    <TabsTrigger
                      value={tab.value}
                      className="w-full justify-start gap-3 data-[state=active]:bg-accent data-[state=active]:text-accent-foreground"
                      data-testid={`tab-${tab.value}`}
                    >
                      <Icon className="w-4 h-4" />
                      {tab.label}
                    </TabsTrigger>
                  </Link>
                );
              })}
            </TabsList>

            <div className="flex-1 min-w-0">
              <TabsContent value="providers" className="mt-0">
                <ProvidersTab />
              </TabsContent>

              <TabsContent value="models" className="mt-0">
                <ComingSoonTab
                  title="Models"
                  description="Browse and configure available models from your connected providers."
                  icon={Sparkles}
                />
              </TabsContent>

              <TabsContent value="memory" className="mt-0">
                <ComingSoonTab
                  title="Memory"
                  description="Configure conversation summaries, recall settings, and long-term memory storage."
                  icon={Brain}
                />
              </TabsContent>

              <TabsContent value="appearance" className="mt-0">
                <ComingSoonTab
                  title="Appearance"
                  description="Customize theme, density, syntax highlighting, and UI preferences."
                  icon={Palette}
                />
              </TabsContent>

              <TabsContent value="data" className="mt-0">
                <ComingSoonTab
                  title="Data"
                  description="Export conversations, manage storage, and configure backups."
                  icon={Database}
                />
              </TabsContent>

              <TabsContent value="about" className="mt-0">
                <ComingSoonTab
                  title="About"
                  description="Version info, changelog, and project documentation."
                  icon={Info}
                />
              </TabsContent>
            </div>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
