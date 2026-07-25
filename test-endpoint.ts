/** Hits the dev server's own endpoint — isolates transport from game logic. */
async function main() {
  const res = await fetch('http://localhost:5173/api/commander', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system: 'Reply with a JSON array only.', user: 'Return [{"unit":1,"order":"hold","reason":"test"}]' }),
  });
  console.log('status:', res.status, res.headers.get('content-type'));
  const body = await res.text();
  console.log('body:', body.slice(0, 500));
}
main().catch(e => console.error('FETCH FAILED:', e.message));