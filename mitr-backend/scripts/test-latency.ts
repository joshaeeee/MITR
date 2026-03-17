/**
 * Latency measurement tool for Mitr voice agent.
 *
 * Modes:
 *   baseline  — Save current /health/latency as baseline
 *   compare   — Compare current /health/latency against saved baseline
 *   snapshot  — Print current /health/latency snapshot
 *   watch     — Poll /health/latency every N seconds
 *
 * Usage:
 *   pnpm tsx scripts/test-latency.ts snapshot
 *   pnpm tsx scripts/test-latency.ts baseline
 *   pnpm tsx scripts/test-latency.ts compare
 *   pnpm tsx scripts/test-latency.ts watch [--interval=5]
 *
 * How to test:
 *   1. Start API (pnpm dev:api) and Agent (pnpm dev:agent)
 *   2. Open web simulator (pnpm test:web) at http://localhost:8787
 *   3. Have a conversation (5-10+ turns)
 *   4. Run: pnpm test:latency snapshot   (to see current metrics)
 *   5. Run: pnpm test:latency baseline   (to save as baseline)
 *   6. Apply optimizations, restart agent
 *   7. Have another conversation (5-10+ turns)
 *   8. Run: pnpm test:latency compare    (to see improvement)
 */
import dotenv from 'dotenv';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

dotenv.config({ path: '.env' });

const API_BASE = process.env.TEST_API_URL ?? 'http://localhost:8080';
const BASELINE_PATH = 'scripts/latency-baseline.json';
const REPORT_PATH = 'scripts/latency-report.json';

interface LatencyBucket {
  p50: number | null;
  p95: number | null;
}

interface LatencySnapshot {
  totalTurns: number;
  turnTotal: LatencyBucket;
  firstAudio: LatencyBucket;
  modelTtft: LatencyBucket;
  byMode: {
    fast: { count: number } & LatencyBucket;
    slow: { count: number } & LatencyBucket;
  };
}

interface SavedReport {
  timestamp: string;
  apiBase: string;
  snapshot: LatencySnapshot;
}

async function fetchSnapshot(): Promise<LatencySnapshot | null> {
  try {
    const res = await fetch(`${API_BASE}/health/latency`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { snapshot: LatencySnapshot };
    return data.snapshot;
  } catch (err) {
    console.error('Failed to fetch /health/latency:', (err as Error).message);
    return null;
  }
}

function printSnapshot(label: string, snap: LatencySnapshot) {
  console.log(`\n=== ${label} (${snap.totalTurns} turns) ===`);
  console.log(`Turn Total     P50: ${snap.turnTotal?.p50 ?? 'n/a'}ms   P95: ${snap.turnTotal?.p95 ?? 'n/a'}ms`);
  console.log(`First Audio    P50: ${snap.firstAudio?.p50 ?? 'n/a'}ms   P95: ${snap.firstAudio?.p95 ?? 'n/a'}ms`);
  console.log(`Model TTFT     P50: ${snap.modelTtft?.p50 ?? 'n/a'}ms   P95: ${snap.modelTtft?.p95 ?? 'n/a'}ms`);
  if (snap.byMode) {
    const fast = snap.byMode.fast;
    const slow = snap.byMode.slow;
    console.log(`Fast (no tools) ${fast.count} turns  P50: ${fast.p50 ?? 'n/a'}ms  P95: ${fast.p95 ?? 'n/a'}ms`);
    console.log(`Slow (w/ tools) ${slow.count} turns  P50: ${slow.p50 ?? 'n/a'}ms  P95: ${slow.p95 ?? 'n/a'}ms`);
  }
}

function pctChange(baseline: number | null, current: number | null): string {
  if (baseline == null || current == null) return 'n/a';
  const pct = ((current - baseline) / baseline) * 100;
  const sign = pct <= 0 ? '' : '+';
  const emoji = pct <= -20 ? ' (great!)' : pct <= 0 ? ' (improved)' : ' (slower)';
  return `${sign}${pct.toFixed(1)}%${emoji}`;
}

function compareSnapshots(baseline: LatencySnapshot, current: LatencySnapshot) {
  console.log('\n=== Comparison ===');
  console.log(`Turns: baseline=${baseline.totalTurns}  current=${current.totalTurns}`);
  console.log('');
  console.log(`Turn Total P50:  ${baseline.turnTotal?.p50 ?? 'n/a'}ms → ${current.turnTotal?.p50 ?? 'n/a'}ms  (${pctChange(baseline.turnTotal?.p50, current.turnTotal?.p50)})`);
  console.log(`Turn Total P95:  ${baseline.turnTotal?.p95 ?? 'n/a'}ms → ${current.turnTotal?.p95 ?? 'n/a'}ms  (${pctChange(baseline.turnTotal?.p95, current.turnTotal?.p95)})`);
  console.log(`First Audio P50: ${baseline.firstAudio?.p50 ?? 'n/a'}ms → ${current.firstAudio?.p50 ?? 'n/a'}ms  (${pctChange(baseline.firstAudio?.p50, current.firstAudio?.p50)})`);
  console.log(`First Audio P95: ${baseline.firstAudio?.p95 ?? 'n/a'}ms → ${current.firstAudio?.p95 ?? 'n/a'}ms  (${pctChange(baseline.firstAudio?.p95, current.firstAudio?.p95)})`);
  console.log(`Model TTFT P50:  ${baseline.modelTtft?.p50 ?? 'n/a'}ms → ${current.modelTtft?.p50 ?? 'n/a'}ms  (${pctChange(baseline.modelTtft?.p50, current.modelTtft?.p50)})`);
  console.log(`Model TTFT P95:  ${baseline.modelTtft?.p95 ?? 'n/a'}ms → ${current.modelTtft?.p95 ?? 'n/a'}ms  (${pctChange(baseline.modelTtft?.p95, current.modelTtft?.p95)})`);

  // Check 50% target
  const turnP50Change = baseline.turnTotal?.p50 && current.turnTotal?.p50
    ? ((current.turnTotal.p50 - baseline.turnTotal.p50) / baseline.turnTotal.p50) * 100
    : null;
  console.log('');
  if (turnP50Change != null && turnP50Change <= -50) {
    console.log('TARGET MET: 50%+ improvement in turn latency P50!');
  } else if (turnP50Change != null) {
    console.log(`TARGET: Need 50% improvement. Current: ${turnP50Change.toFixed(1)}% change.`);
  }
}

async function main() {
  const mode = process.argv[2] ?? 'snapshot';

  switch (mode) {
    case 'snapshot': {
      const snap = await fetchSnapshot();
      if (!snap) return;
      printSnapshot('Current Latency', snap);
      break;
    }

    case 'baseline': {
      const snap = await fetchSnapshot();
      if (!snap) return;
      if (snap.totalTurns === 0) {
        console.log('No latency data yet. Have a conversation first via the web simulator.');
        return;
      }
      printSnapshot('Baseline Captured', snap);
      const report: SavedReport = { timestamp: new Date().toISOString(), apiBase: API_BASE, snapshot: snap };
      writeFileSync(BASELINE_PATH, JSON.stringify(report, null, 2));
      console.log(`\nBaseline saved to ${BASELINE_PATH}`);
      break;
    }

    case 'compare': {
      if (!existsSync(BASELINE_PATH)) {
        console.log('No baseline found. Run with "baseline" mode first.');
        return;
      }
      const baselineReport = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as SavedReport;
      const current = await fetchSnapshot();
      if (!current) return;
      if (current.totalTurns === 0) {
        console.log('No current latency data. Have a conversation first.');
        return;
      }
      printSnapshot('Baseline', baselineReport.snapshot);
      printSnapshot('Current', current);
      compareSnapshots(baselineReport.snapshot, current);

      const report = {
        timestamp: new Date().toISOString(),
        baseline: baselineReport,
        current: { timestamp: new Date().toISOString(), apiBase: API_BASE, snapshot: current }
      };
      writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
      console.log(`\nReport saved to ${REPORT_PATH}`);
      break;
    }

    case 'watch': {
      const interval = parseInt(process.argv.find((a) => a.startsWith('--interval='))?.split('=')[1] ?? '5', 10);
      console.log(`Watching /health/latency every ${interval}s (Ctrl+C to stop)\n`);
      const poll = async () => {
        const snap = await fetchSnapshot();
        if (snap && snap.totalTurns > 0) {
          const ts = new Date().toLocaleTimeString();
          console.log(
            `[${ts}] Turns: ${snap.totalTurns}  TurnP50: ${snap.turnTotal?.p50 ?? '-'}ms  FirstAudioP50: ${snap.firstAudio?.p50 ?? '-'}ms  TTFT_P50: ${snap.modelTtft?.p50 ?? '-'}ms`
          );
        }
      };
      await poll();
      setInterval(poll, interval * 1000);
      break;
    }

    default:
      console.log('Usage: pnpm test:latency [snapshot|baseline|compare|watch]');
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
