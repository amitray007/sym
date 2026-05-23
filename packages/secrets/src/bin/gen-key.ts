import { generateKey } from '../secrets.js';

// Prints a fresh base64 32-byte key for SYM_ENCRYPTION_KEY. Run: pnpm --filter @sym/secrets gen-key
const key = await generateKey();
process.stdout.write(`${key}\n`);
