import 'dotenv/config';
import { listModels } from './lib/gemini';

async function main() {
  const models = await listModels();
  console.log(`${models.length} models support generateContent:\n`);
  for (const m of models) console.log('  ' + m);
  const flash = models.filter(m => /flash/i.test(m) && !/image|tts|embedding|live/i.test(m));
  console.log('\nGood candidates for the commander (cheap, fast, free tier):');
  for (const m of flash) console.log('  ' + m);
}
main().catch(e => { console.error(e.message); process.exit(1); });