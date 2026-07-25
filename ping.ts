import 'dotenv/config';

async function main() {
  const key = process.env.GEMINI_API_KEY!;
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'say hi' }] }] }),
        signal: ctl.signal,
      },
    );
    console.log(res.status, `${Date.now() - t0}ms`);
    console.log((await res.text()).slice(0, 400));
  } catch (e) {
    console.log(`${Date.now() - t0}ms ABORTED/FAILED:`, (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}
main();