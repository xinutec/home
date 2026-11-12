const KEY = 'house.image';

/** Whether this device draws the fine image (the image stage: contact shading,
 *  white balance, edge smoothing after the tone curve), else the room straight to
 *  the screen in one pass, the fast default. localStorage can throw (private mode):
 *  then the default. */
export function readFine(): boolean {
	try {
		return localStorage.getItem(KEY) === 'fine';
	} catch {
		return false;
	}
}

/** Keeps the choice on this device for the next visit. */
export function writeFine(fine: boolean): void {
	try {
		localStorage.setItem(KEY, fine ? 'fine' : 'fast');
	} catch {
		/* no storage: the choice lasts this visit */
	}
}
