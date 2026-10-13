// Air raid alert data from siren.pp.ua, a public mirror of the
// ukrainealarm.com v3 API (no token required).

export const ALERTS_URL = 'https://siren.pp.ua/api/v3/alerts';
export const REGIONS_URL = 'https://siren.pp.ua/api/v3/regions';

// Flattens the regions tree into a Map of id -> {id, name, type, parentId}.
export function indexRegions(data) {
	const regions = new Map();

	const walk = (items, parentId) => {
		for (const item of items ?? []) {
			const id = String(item.regionId);

			regions.set(id, {
				id,
				name: item.regionName,
				type: item.regionType,
				parentId,
			});
			walk(item.regionChildIds, id);
		};
	};

	walk(data?.states, null);
	return regions;
};

// The region itself, its ancestors (an oblast-wide alert covers every
// district) and its descendants (communities inside a district).
export function relevantRegionIds(regions, regionId) {
	const ids = new Set([regionId]);
	let parentId = regions.get(regionId)?.parentId;

	while (parentId) {
		ids.add(parentId);
		parentId = regions.get(parentId)?.parentId;
	};

	for (const region of regions.values()) {
		if (isDescendant(regions, region.id, regionId)) {
			ids.add(region.id);
		};
	};

	return ids;
};

function isDescendant(regions, id, ancestorId) {
	let parentId = regions.get(id)?.parentId;

	while (parentId) {
		if (parentId === ancestorId) {
			return true;
		};
		parentId = regions.get(parentId)?.parentId;
	};

	return false;
};

// Returns {active, types, since} for the watched region ids.
export function alertStatus(alerts, regionIds) {
	const types = new Set();
	let since = null;

	for (const region of alerts ?? []) {
		if (!regionIds.has(String(region.regionId))) {
			continue;
		};

		for (const alert of region.activeAlerts ?? []) {
			types.add(alert.type);

			const started = new Date(alert.lastUpdate ?? region.lastUpdate);

			if (!Number.isNaN(started.getTime()) && (!since || started < since)) {
				since = started;
			};
		};
	};

	return {
		active: types.size > 0,
		types: [...types],
		since,
	};
};
