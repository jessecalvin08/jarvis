/**
 * Downloads the offline speech models into ./models so Jarvis can run without internet.
 *   npm run models
 */
import { config } from "../server/config.js";
import { loadKokoro, loadWhisper } from "../server/voice/local.js";

const log = (msg: string) => console.log(`  ${msg}`);
console.log(`\n  Caching models in ${config.modelsDir}\n`);
try {
  await loadWhisper(log);
  await loadKokoro(log);
  console.log("\n  Done. Set STT_PROVIDER=local and TTS_PROVIDER=kokoro in .env to use them.\n");
  process.exit(0);
} catch (err) {
  console.error(`\n  Download failed: ${(err as Error).message}\n`);
  process.exit(1);
}
