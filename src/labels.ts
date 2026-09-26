import type { DeviceLabel } from "./wire.js";

// Display label and role per stored device id, applied at read time: a room is
// never stored, so moving a sensor is an edit here, not a migration. An unmapped
// device still shows, under its raw id.

const LABELS: Record<string, DeviceLabel> = {
	airvisual: {
		name: "IQAir",
		room: "Bedroom",
		airQuality: true,
		order: 0,
		type: "IQAir AirVisual Pro",
	},
	"govee-A562": {
		name: "govee-A562",
		room: "Living Room",
		airQuality: false,
		order: 1,
		type: "Govee H5075",
	},
	"govee-525D": {
		name: "govee-525D",
		room: "Kitchen",
		airQuality: false,
		order: 2,
		type: "Govee H5075",
	},
	"govee-B7AC": {
		name: "govee-B7AC",
		room: "Hobby Room",
		airQuality: false,
		order: 3,
		type: "Govee H5075",
	},
	"govee-267F": {
		name: "govee-267F",
		room: "Guest Room",
		airQuality: false,
		order: 4,
		type: "Govee H5103",
	},
	"govee-0345": {
		name: "govee-0345",
		room: "Hallway",
		airQuality: false,
		order: 5,
		type: "Govee H5103",
	},
	"govee-251B": {
		name: "govee-251B",
		room: "Bathroom",
		airQuality: false,
		order: 6,
		type: "Govee H5103",
	},
	"govee-014E": {
		name: "govee-014E",
		room: "Stairs",
		airQuality: false,
		order: 7,
		type: "Govee H5103",
	},
	// Smart plugs, named by the appliance they meter. Not reporting yet: doc/energy-sockets.md.
	"socket-fan": { name: "Fan", airQuality: false, power: true, order: 10, type: "Smart plug" },
	"socket-coffee": {
		name: "Coffee Machine",
		airQuality: false,
		power: true,
		order: 11,
		type: "Smart plug",
	},
	"socket-desk": {
		name: "Desktop PC",
		airQuality: false,
		power: true,
		order: 12,
		type: "Smart plug",
	},
	"socket-tv": { name: "TV", airQuality: false, power: true, order: 13, type: "Smart plug" },
};

export function labelFor(device: string): DeviceLabel {
	return LABELS[device] ?? { name: device, airQuality: false, order: 99, type: "Unknown" };
}

/** Label each row and sort for the UI. */
export function decorateDevices<T extends { device: string }>(
	rows: T[],
): (T & { label: DeviceLabel })[] {
	return rows
		.map((r) => ({ ...r, label: labelFor(r.device) }))
		.sort((a, b) => a.label.order - b.label.order);
}
