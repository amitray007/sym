/**
 * Vitest unit-suite setup. Pins the unencrypted settings store to an in-memory
 * DB so no test writes a real `settings.db` into the working tree — the agent's
 * real `runTurnLoop` (exercised by handle-turn.test) reads the channel-persona
 * store per turn, which would otherwise open the default-path file on disk.
 *
 * Tests that need their own settings DB still override SYM_SETTINGS_DB_PATH and
 * reset the store singleton themselves (see cli.persona.test / persona-resolve.test).
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['SYM_SETTINGS_DB_PATH'] = ':memory:';

// Point persona-spec overrides at a non-existent dir so the suite always reads
// the shipped defaults (tests that exercise overrides set their own temp
// SYM_PERSONAS_DIR). Keeps a dev's real `.sym/personas` out of the tests.
process.env['SYM_PERSONAS_DIR'] = join(tmpdir(), 'sym-test-personas-absent');
