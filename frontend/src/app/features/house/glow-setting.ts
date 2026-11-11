import { GLOW_DEFAULT } from './image-stage';

const KEY = 'house.glow';

/** The glow setting this device keeps (0 to 1), or GLOW_DEFAULT if it keeps none.
 *  localStorage can throw (private mode): then none is kept. */
export function readGlow(): number {
	let stored: string | null;
	try {
		stored = localStorage.getItem(KEY);
	} catch {
		return GLOW_DEFAULT;
	}
	const glow = Number(stored);
	return stored !== null && glow >= 0 && glow <= 1 ? glow : GLOW_DEFAULT;
}

/** Keeps `glow` on this device for the next visit. */
export function writeGlow(glow: number): void {
	try {
		localStorage.setItem(KEY, String(glow));
	} catch {
		/* no storage: the setting lasts this visit */
	}
}
