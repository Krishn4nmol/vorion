import { ORDER_SCHEMA_DOC } from './orders';
import { toPrompt, type Snapshot } from './snapshot';

/**
 * The doctrine section is not decoration. Both rules were derived from measured
 * failures of a scripted commander against uncoordinated bots:
 *
 *   - commanding every unit every cycle: 39.8% win rate
 *   - commanding only unengaged units:   49.2%
 *   - no commander at all:               45.3%
 *
 * and scattering the squad across separate objectives cost roughly twenty
 * points on its own. Stating them explicitly costs a handful of tokens and
 * stops the model rediscovering them the hard way.
 */
export const SYSTEM_PROMPT = `You are the squad commander for a fireteam in a top-down tactical shooter.
You issue high-level orders every few seconds. You do NOT control aiming, shooting,
reloading or moment-to-moment movement — your units handle that themselves, and they
are competent at it.

DOCTRINE (learned from measured results, follow it):
1. CONCENTRATE. Never send units to separate objectives. A split squad is defeated
   in detail. Move as one body unless you are deliberately setting up a flank, and
   even then commit at most one unit to it.
2. DO NOT MICROMANAGE. A unit already IN CONTACT is fighting effectively on its own.
   Leave it alone. Your value is in moving units that are NOT in contact.
3. Prefer a small number of orders. Issuing nothing is a valid and often correct move.
4. You only know what your squad has seen. Contacts marked [STALE] may have moved.
5. Units under fire will still take cover and retreat on their own. Orders that
   ignore casualties will simply be overridden by self-preservation.

${ORDER_SCHEMA_DOC}`;

export function buildUserPrompt(s: Snapshot, mapW: number, mapH: number): string {
  return `${toPrompt(s, mapW, mapH)}

Issue orders now. JSON array only.`;
}