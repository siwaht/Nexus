import { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Check, Copy, Download } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { ChartSpec } from '@/lib/types';

import { downloadText } from './markdown';

/**
 * Renders a chart spec produced by the `create_chart` tool.
 *
 * The spec is model output, so every field is validated before it reaches
 * Recharts — a malformed series or a non-numeric value degrades to a readable
 * message rather than a blank panel or a thrown render error.
 */

const PALETTE = [
  'hsl(var(--chart-1, 217 91% 60%))',
  'hsl(var(--chart-2, 160 60% 45%))',
  'hsl(var(--chart-3, 43 96% 56%))',
  'hsl(var(--chart-4, 280 65% 60%))',
  'hsl(var(--chart-5, 340 75% 55%))',
];

export function parseChartSpec(raw: string | null | undefined): ChartSpec | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ChartSpec>;
    if (!Array.isArray(parsed.data) || parsed.data.length === 0) return null;
    if (!Array.isArray(parsed.series) || parsed.series.length === 0) return null;
    const series = parsed.series
      .filter(
        (entry): entry is { key: string; label?: string } =>
          Boolean(entry) && typeof entry.key === 'string',
      )
      .slice(0, 8);
    if (series.length === 0) return null;
    const type = parsed.type ?? 'bar';
    return {
      type: ['line', 'bar', 'area', 'pie', 'scatter'].includes(type) ? type : 'bar',
      title: typeof parsed.title === 'string' ? parsed.title : 'Chart',
      xKey: typeof parsed.xKey === 'string' ? parsed.xKey : 'name',
      yLabel: typeof parsed.yLabel === 'string' ? parsed.yLabel : null,
      series,
      data: parsed.data.slice(0, 500) as Array<Record<string, unknown>>,
    };
  } catch {
    return null;
  }
}

export interface ChartViewProps {
  spec: ChartSpec;
  height?: number;
}

export function ChartView({ spec, height = 300 }: ChartViewProps) {
  const [copied, setCopied] = useState(false);

  const data = useMemo(
    () =>
      spec.data.map((row) => {
        const clean: Record<string, unknown> = {
          [spec.xKey]: row[spec.xKey] ?? '',
        };
        for (const entry of spec.series) {
          const value = row[entry.key];
          const numeric =
            typeof value === 'number'
              ? value
              : Number.parseFloat(String(value ?? '').replace(/[$,%\s]/g, ''));
          clean[entry.key] = Number.isFinite(numeric) ? numeric : 0;
        }
        return clean;
      }),
    [spec],
  );

  const csv = useMemo(() => {
    const header = [spec.xKey, ...spec.series.map((entry) => entry.key)];
    const rows = data.map((row) => header.map((key) => String(row[key] ?? '')));
    return [header, ...rows].map((row) => row.join(',')).join('\n');
  }, [data, spec]);

  const axes = (
    <>
      <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
      <XAxis
        dataKey={spec.xKey}
        tick={{ fontSize: 12 }}
        className="text-muted-foreground"
      />
      <YAxis
        tick={{ fontSize: 12 }}
        className="text-muted-foreground"
        label={
          spec.yLabel
            ? { value: spec.yLabel, angle: -90, position: 'insideLeft', fontSize: 12 }
            : undefined
        }
      />
      <Tooltip
        contentStyle={{
          background: 'hsl(var(--popover))',
          border: '1px solid hsl(var(--border))',
          borderRadius: 8,
          fontSize: 12,
        }}
      />
      {spec.series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
    </>
  );

  const chart = (() => {
    switch (spec.type) {
      case 'line':
        return (
          <LineChart data={data}>
            {axes}
            {spec.series.map((entry, index) => (
              <Line
                key={entry.key}
                type="monotone"
                dataKey={entry.key}
                name={entry.label ?? entry.key}
                stroke={PALETTE[index % PALETTE.length]}
                strokeWidth={2}
                dot={data.length <= 40}
              />
            ))}
          </LineChart>
        );
      case 'area':
        return (
          <AreaChart data={data}>
            {axes}
            {spec.series.map((entry, index) => (
              <Area
                key={entry.key}
                type="monotone"
                dataKey={entry.key}
                name={entry.label ?? entry.key}
                stroke={PALETTE[index % PALETTE.length]}
                fill={PALETTE[index % PALETTE.length]}
                fillOpacity={0.2}
              />
            ))}
          </AreaChart>
        );
      case 'scatter':
        return (
          <ScatterChart data={data}>
            {axes}
            {spec.series.map((entry, index) => (
              <Scatter
                key={entry.key}
                dataKey={entry.key}
                name={entry.label ?? entry.key}
                fill={PALETTE[index % PALETTE.length]}
              />
            ))}
          </ScatterChart>
        );
      case 'pie':
        return (
          <PieChart>
            <Tooltip
              contentStyle={{
                background: 'hsl(var(--popover))',
                border: '1px solid hsl(var(--border))',
                borderRadius: 8,
                fontSize: 12,
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Pie
              data={data}
              dataKey={spec.series[0].key}
              nameKey={spec.xKey}
              cx="50%"
              cy="50%"
              outerRadius="75%"
              label={data.length <= 12}
            >
              {data.map((_row, index) => (
                <Cell key={index} fill={PALETTE[index % PALETTE.length]} />
              ))}
            </Pie>
          </PieChart>
        );
      default:
        return (
          <BarChart data={data}>
            {axes}
            {spec.series.map((entry, index) => (
              <Bar
                key={entry.key}
                dataKey={entry.key}
                name={entry.label ?? entry.key}
                fill={PALETTE[index % PALETTE.length]}
                radius={[3, 3, 0, 0]}
              />
            ))}
          </BarChart>
        );
    }
  })();

  return (
    <figure className="my-4 overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5">
        <figcaption className="truncate text-sm font-medium">{spec.title}</figcaption>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() => {
              void navigator.clipboard.writeText(csv).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1600);
              });
            }}
            data-testid="button-copy-chart-csv"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            CSV
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() =>
              downloadText(csv, `${spec.title.replace(/[^\w-]+/g, '-')}.csv`, 'text/csv')
            }
            aria-label="Download chart data"
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className="p-3" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {chart}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
