/** What the view's engine can do, each on or off on this device, to compare. */
export type Feature = 'fine' | 'shadows' | 'occlusion' | 'directional' | 'reflections' | 'planar';

/** Each feature as the settings list it: its label, whether switching it reloads
 *  the page (it changes how the view is built), and what it is by default. */
export const FEATURES: readonly {
	feature: Feature;
	label: string;
	reload: boolean;
	on: boolean;
}[] = [
	{ feature: 'fine', label: 'Fine image (slower)', reload: true, on: false },
	{ feature: 'shadows', label: 'Lamp shadows', reload: false, on: true },
	{ feature: 'occlusion', label: 'Daylight shade by things', reload: false, on: true },
	{ feature: 'directional', label: '… from the window’s side', reload: false, on: true },
	{ feature: 'reflections', label: 'Reflections from where they hang', reload: false, on: true },
	{ feature: 'planar', label: 'The TV reflects the room as it is', reload: false, on: true },
];

/** Where each is kept: the fine image under its first key, which says fine or fast. */
function keyOf(feature: Feature): string {
	return feature === 'fine' ? 'house.image' : `house.${feature}`;
}

/** Whether `feature` is on on this device: as last set, else its default.
 *  localStorage can throw (private mode): then the default. */
export function readFeature(feature: Feature): boolean {
	const on = FEATURES.find((f) => f.feature === feature)?.on ?? false;
	let stored: string | null;
	try {
		stored = localStorage.getItem(keyOf(feature));
	} catch {
		return on;
	}
	if (stored === null) return on;
	return stored === 'on' || stored === 'fine';
}

/** Keeps `feature` on or off on this device. */
export function writeFeature(feature: Feature, on: boolean): void {
	const value = feature === 'fine' ? (on ? 'fine' : 'fast') : on ? 'on' : 'off';
	try {
		localStorage.setItem(keyOf(feature), value);
	} catch {
		/* no storage: the choice lasts this visit */
	}
}

/** Every feature, on or off on this device. */
export function readFeatures(): Record<Feature, boolean> {
	return {
		fine: readFeature('fine'),
		shadows: readFeature('shadows'),
		occlusion: readFeature('occlusion'),
		directional: readFeature('directional'),
		reflections: readFeature('reflections'),
		planar: readFeature('planar'),
	};
}
