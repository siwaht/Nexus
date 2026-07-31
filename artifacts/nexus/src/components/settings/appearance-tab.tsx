import { Monitor, Moon, Sun } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  useTheme,
  type Accent,
  type Density,
  type FontSize,
  type Theme,
} from '@/lib/theme-provider';
import { useUpdateSettings } from '@/lib/queries';
import { cn } from '@/lib/utils';

/**
 * Settings → Appearance.
 *
 * Applied locally on change (so it's instant, no flash) and mirrored to the
 * server so the choice follows the account to another device.
 */

const THEMES: Array<{ value: Theme; label: string; icon: React.ReactNode }> = [
  { value: 'light', label: 'Light', icon: <Sun className="h-4 w-4" /> },
  { value: 'dark', label: 'Dark', icon: <Moon className="h-4 w-4" /> },
  { value: 'system', label: 'System', icon: <Monitor className="h-4 w-4" /> },
];

const ACCENTS: Array<{ value: Accent; label: string; swatch: string }> = [
  { value: 'default', label: 'Default', swatch: 'bg-primary' },
  { value: 'blue', label: 'Blue', swatch: 'bg-[hsl(217_91%_60%)]' },
  { value: 'violet', label: 'Violet', swatch: 'bg-[hsl(263_70%_62%)]' },
  { value: 'emerald', label: 'Emerald', swatch: 'bg-[hsl(160_62%_42%)]' },
  { value: 'amber', label: 'Amber', swatch: 'bg-[hsl(38_92%_52%)]' },
  { value: 'rose', label: 'Rose', swatch: 'bg-[hsl(347_77%_56%)]' },
];

const FONT_SIZES: Array<{ value: FontSize; label: string }> = [
  { value: 'sm', label: 'Small' },
  { value: 'md', label: 'Medium' },
  { value: 'lg', label: 'Large' },
];

const DENSITIES: Array<{ value: Density; label: string; hint: string }> = [
  { value: 'compact', label: 'Compact', hint: 'More on screen' },
  { value: 'comfortable', label: 'Comfortable', hint: 'Balanced' },
  { value: 'spacious', label: 'Spacious', hint: 'Easier to scan' },
];

export function AppearanceTab() {
  const appearance = useTheme();
  const updateSettings = useUpdateSettings();

  return (
    <div className="space-y-4">
      <Card className="border-card-border">
        <CardHeader>
          <CardTitle className="text-lg">Colour scheme</CardTitle>
          <CardDescription>
            System follows your operating system setting and switches with it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {THEMES.map((option) => (
            <Button
              key={option.value}
              variant={appearance.theme === option.value ? 'default' : 'outline'}
              className="gap-2"
              onClick={() => {
                appearance.setTheme(option.value);
                updateSettings.mutate({ theme: option.value });
              }}
              data-testid={`button-theme-${option.value}`}
            >
              {option.icon}
              {option.label}
            </Button>
          ))}
        </CardContent>
      </Card>

      <Card className="border-card-border">
        <CardHeader>
          <CardTitle className="text-lg">Accent colour</CardTitle>
          <CardDescription>
            Buttons, links and focus rings pick this up.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {ACCENTS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                appearance.setAccent(option.value);
                updateSettings.mutate({ accentColor: option.value });
              }}
              className={cn(
                'flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                appearance.accent === option.value
                  ? 'border-primary bg-accent'
                  : 'border-border hover:bg-accent/50',
              )}
              aria-pressed={appearance.accent === option.value}
              data-testid={`button-accent-${option.value}`}
            >
              <span className={cn('h-4 w-4 rounded-full', option.swatch)} />
              {option.label}
            </button>
          ))}
        </CardContent>
      </Card>

      <Card className="border-card-border">
        <CardHeader>
          <CardTitle className="text-lg">Text and spacing</CardTitle>
          <CardDescription>
            Font size scales the whole app; density controls the gap between
            messages.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label className="text-sm">Font size</Label>
            <div className="flex flex-wrap gap-2">
              {FONT_SIZES.map((option) => (
                <Button
                  key={option.value}
                  variant={appearance.fontSize === option.value ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => {
                    appearance.setFontSize(option.value);
                    updateSettings.mutate({ fontSize: option.value });
                  }}
                  data-testid={`button-font-${option.value}`}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-2 border-t border-border pt-5">
            <Label className="text-sm">Message density</Label>
            <div className="flex flex-wrap gap-2">
              {DENSITIES.map((option) => (
                <Button
                  key={option.value}
                  variant={appearance.density === option.value ? 'default' : 'outline'}
                  size="sm"
                  className="flex-col items-start gap-0 py-1.5"
                  onClick={() => {
                    appearance.setDensity(option.value);
                    updateSettings.mutate({ density: option.value });
                  }}
                  data-testid={`button-density-${option.value}`}
                >
                  <span>{option.label}</span>
                  <span className="text-[10px] opacity-70">{option.hint}</span>
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-card-border">
        <CardHeader>
          <CardTitle className="text-lg">Keyboard shortcuts</CardTitle>
          <CardDescription>
            Nexus is keyboard-first. These work anywhere in the app.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-2 sm:grid-cols-2">
            {[
              ['Cmd/Ctrl + K', 'Command palette'],
              ['Cmd/Ctrl + N', 'New chat'],
              ['Cmd/Ctrl + /', 'Focus the composer'],
              ['Cmd/Ctrl + B', 'Toggle the sidebar'],
              ['Esc', 'Stop generating'],
              ['Enter', 'Send · Shift+Enter for a newline'],
            ].map(([keys, description]) => (
              <div key={keys} className="flex items-center gap-3 text-sm">
                <dt>
                  <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                    {keys}
                  </kbd>
                </dt>
                <dd className="text-muted-foreground">{description}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
