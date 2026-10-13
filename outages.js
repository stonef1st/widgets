import GLib from 'gi://GLib';

// Hourly outage schedules (ГПВ) from yaroslav2901/OE_OUTAGE_DATA. Each
// provider file has fact.data[<local midnight, unix>][<group>][<hour 1-24>]
// with yes / no / maybe, or first / second (and mfirst / msecond) when
// only one half of the hour is affected.

export const DATA_URL = 'https://raw.githubusercontent.com/yaroslav2901/OE_OUTAGE_DATA/main/data/%s.json';
export const TIME_ZONE = 'Europe/Kyiv';
export const SLOTS_PER_DAY = 48;

export const PROVIDERS = [
	['Cherkasyoblenergo', 'Cherkasy Oblenergo'],
	['Chernihivoblenergo', 'Chernihiv Oblenergo'],
	['Kharkivoblenerho', 'Kharkiv Oblenergo'],
	['Khmelnytskoblenerho', 'Khmelnytskyi Oblenergo'],
	['Lvivoblenerho', 'Lviv Oblenergo'],
	['Poltavaoblenergo', 'Poltava Oblenergo'],
	['Prykarpattiaoblenerho', 'Prykarpattia Oblenergo'],
	['Rivneoblenergo', 'Rivne Oblenergo'],
	['Ternopiloblenerho', 'Ternopil Oblenergo'],
	['Zakarpattiaoblenerho', 'Zakarpattia Oblenergo'],
	['Zaporizhzhiaoblenergo', 'Zaporizhzhia Oblenergo'],
	['Zhytomyroblenergo', 'Zhytomyr Oblenergo'],
];

export const GROUPS = [1, 2, 3, 4, 5, 6].flatMap(queue => [`GPV${queue}.1`, `GPV${queue}.2`]);

// [first half, second half] of an hour.
const HOUR_STATES = {
	yes: ['on', 'on'],
	no: ['off', 'off'],
	maybe: ['maybe', 'maybe'],
	first: ['off', 'on'],
	second: ['on', 'off'],
	mfirst: ['maybe', 'on'],
	msecond: ['on', 'maybe'],
};

export function groupLabel(group) {
	return group.replace(/^GPV/, '');
};

function kyivNow() {
	return GLib.DateTime.new_now(GLib.TimeZone.new(TIME_ZONE));
};

function midnightUnix(dateTime) {
	return GLib.DateTime.new(dateTime.get_timezone(), dateTime.get_year(), dateTime.get_month(), dateTime.get_day_of_month(), 0, 0, 0).to_unix();
};

// Half-hour slot states for one day, or null when the day has no schedule.
export function daySlots(data, group, dayUnix) {
	const hours = data?.fact?.data?.[String(dayUnix)]?.[group];

	if (!hours) {
		return null;
	};

	const slots = [];

	for (let hour = 1; hour <= 24; hour++) {
		slots.push(...(HOUR_STATES[hours[String(hour)]] ?? ['unknown', 'unknown']));
	};

	return slots;
};

function slotTime(dayUnix, slot) {
	return new Date((dayUnix + slot * 30 * 60) * 1000);
};

// {today, tomorrow, slot, current, next: {state, at} | null, updated}
export function scheduleStatus(data, group, now = kyivNow()) {
	const todayUnix = midnightUnix(now);
	const tomorrowUnix = midnightUnix(now.add_days(1));
	const today = daySlots(data, group, todayUnix);
	const tomorrow = daySlots(data, group, tomorrowUnix);
	const slot = now.get_hour() * 2 + (now.get_minute() >= 30 ? 1 : 0);
	const result = {
		today,
		tomorrow,
		slot,
		current: today?.[slot] ?? null,
		next: null,
		updated: data?.fact?.update ?? null,
	};

	if (!today) {
		return result;
	};

	const timeline = [
		...today.map((state, index) => [state, slotTime(todayUnix, index)]),
		...(tomorrow ?? []).map((state, index) => [state, slotTime(tomorrowUnix, index)]),
	];

	for (let index = slot + 1; index < timeline.length; index++) {
		if (timeline[index][0] !== result.current) {
			result.next = {state: timeline[index][0], at: timeline[index][1]};
			break;
		};
	};

	return result;
};
