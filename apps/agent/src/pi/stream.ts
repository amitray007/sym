/**
 * Pi 0.82 requires Agent to receive an explicit stream function.
 * Compat `streamSimple` is the same dispatcher the previous Agent used implicitly.
 */

import { streamSimple } from '@earendil-works/pi-ai/compat';

import type { StreamFn } from '@earendil-works/pi-agent-core';

export const piStreamFn: StreamFn = streamSimple;
