import { existsSync, readFileSync } from 'fs';

const path = 'eval-traces.jsonl';
if (!existsSync(path)) {
  console.log('no traces');
} else {
  const errs = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((t: any) => t.error);

  console.log(`${errs.length} errored calls\n`);
  const counts = new Map<string, number>();
  for (const e of errs) {
    const key = String(e.error).slice(0, 120);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [msg, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(n).padStart(4)}  ${msg}`);
  }
  console.log('\nfirst errored call:');
  const f = errs[0];
  console.log(`  arm=${f.arm} seed=${f.seed} tick=${f.tick} latency=${f.latencyMs}ms`);
  console.log(`  error: ${f.error}`);
  console.log(`  prompt chars: ${f.prompt?.length}`);
}