import GLib from 'gi://GLib';

import { fetchText } from './net.js';

// Hourly outage schedules (ГПВ) from yaroslav2901/OE_OUTAGE_DATA. Each
// provider file has fact.data[<local midnight, unix>][<group>][<hour 1-24>]
// with yes / no / maybe, or first / second (and mfirst / msecond) when
// only one half of the hour is affected.

export const DATA_URL = 'https://raw.githubusercontent.com/yaroslav2901/OE_OUTAGE_DATA/main/data/%s.json';
export const TIME_ZONE = 'Europe/Kyiv';
export const SLOTS_PER_DAY = 48;

export const PROVIDERS = [
	['Khmelnytskoblenerho', 'Khmelnytskyi Oblenergo'],
	['Zaporizhzhiaoblenergo', 'Zaporizhzhia Oblenergo'],
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

export function kyivNow() {
	return GLib.DateTime.new_now(GLib.TimeZone.new(TIME_ZONE));
};

export function midnightUnix(dateTime) {
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

// Some days never reach OE_OUTAGE_DATA: its scraper reads only the oblenergo's
// main schedule page, while a forecast for tomorrow may exist only as a news
// post. Providers listed here fill such days from their own website, in the
// same fact.data shape: {<local midnight, unix>: {<group>: {<hour>: state}}}.

const MONTHS_GENITIVE = [
	'січня', 'лютого', 'березня', 'квітня', 'травня', 'червня',
	'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня',
];
const DASH = '[-–—]';
const RANGE = new RegExp(`(\\d{1,2}):(\\d{2})\\s*${DASH}\\s*(\\d{1,2}):(\\d{2})`, 'g');
const QUEUE = new RegExp(`Підчерга\\s+(\\d\\.\\d)\\s*${DASH}\\s*((?:\\d{1,2}:\\d{2}\\s*${DASH}\\s*\\d{1,2}:\\d{2}[\\s;,]*)+)`, 'g');

function htmlText(html) {
	return html
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&ndash;/g, '–')
		.replace(/&mdash;/g, '—')
		.replace(/&amp;/g, '&')
		.replace(/\s+/g, ' ');
};

// "{day}.{month}" a block is about: "на 16 листопада (оновлено …)" for an
// update, "17.11.2026 р. … будуть застосовані" for a forecast.
function blockDate(text) {
	const named = text.match(new RegExp(`на\\s+(\\d{1,2})\\s+(${MONTHS_GENITIVE.join('|')})`));

	if (named) {
		return `${Number(named[1])}.${MONTHS_GENITIVE.indexOf(named[2]) + 1}`;
	};

	const numeric = text.match(/(\d{2})\.(\d{2})\.\d{4}\s*р/);

	return numeric ? `${Number(numeric[1])}.${Number(numeric[2])}` : null;
};

// Hours off per queue → {<group>: {<hour 1-24>: state}}; a queue the
// announcement leaves out has power all day. null without any queue.
function blockGroups(text) {
	const off = {};

	for (const [, queue, ranges] of text.matchAll(QUEUE)) {
		const slots = off[`GPV${queue}`] ??= new Array(SLOTS_PER_DAY).fill(false);

		for (const [, fromHour, fromMinute, toHour, toMinute] of ranges.matchAll(RANGE)) {
			const from = Number(fromHour) * 2 + (Number(fromMinute) >= 30 ? 1 : 0);
			const to = Math.min(SLOTS_PER_DAY, Number(toHour) * 2 + Math.ceil(Number(toMinute) / 30));

			slots.fill(true, from, to);
		};
	};

	if (Object.keys(off).length === 0) {
		return null;
	};

	const groups = {};

	for (const group of GROUPS) {
		const slots = off[group] ?? [];

		groups[group] = {};
		for (let hour = 1; hour <= 24; hour++) {
			const [first, second] = [slots[hour * 2 - 2], slots[hour * 2 - 1]];

			groups[group][String(hour)] = first && second ? 'no' : first ? 'first' : second ? 'second' : 'yes';
		};
	};

	return groups;
};

// Announcements on a page, in page order; the schedule page puts the newest
// first and separates them with <hr>.
function pageBlocks(html) {
	const start = html.indexOf('class="post"');

	return (start < 0 ? '' : html.slice(start)).split(/<hr\s*\/?>/i).map(htmlText);
};

const HOE_URL = 'https://hoe.com.ua';

async function fetchHoeDays(session, wanted, cancellable) {
	const found = {};
	const take = blocks => {
		for (const text of blocks) {
			const key = blockDate(text);
			const groups = key in wanted && !(key in found) ? blockGroups(text) : null;

			if (groups) {
				found[key] = groups;
			};
		};
	};
	const missing = () => Object.keys(wanted).filter(key => !(key in found));

	take(pageBlocks(await fetchText(session, `${HOE_URL}/page/pogodinni-vidkljuchennja`, cancellable)));

	if (missing().length > 0) {
		// Forecasts are news posts like /post/prognoz-gpv-na-17-listopada.html.
		const home = await fetchText(session, `${HOE_URL}/`, cancellable);
		const days = new Set(missing().map(key => key.split('.')[0]));
		const posts = new Set([...home.matchAll(/href="(\/post\/[a-z0-9-]*(?:gpv|vidkljuchennja)[a-z0-9-]*-na-(\d{1,2})-[a-z]+\.html)"/g)]
			.filter(([, , day]) => days.has(String(Number(day))))
			.map(([, path]) => path));

		for (const path of posts) {
			take(pageBlocks(await fetchText(session, `${HOE_URL}${path}`, cancellable)));
		};
	};

	return Object.fromEntries(Object.entries(found).map(([key, groups]) => [wanted[key], groups]));
};

export const SCHEDULE_FALLBACKS = {
	Khmelnytskoblenerho: {source: 'hoe.com.ua', fetchDays: fetchHoeDays},
};

// Today and tomorrow without a schedule in `data`, as {"{day}.{month}": midnight unix}.
export function missingDays(data, now = kyivNow()) {
	const wanted = {};

	for (const dateTime of [now, now.add_days(1)]) {
		const dayUnix = midnightUnix(dateTime);

		if (!data?.fact?.data?.[String(dayUnix)]) {
			wanted[`${dateTime.get_day_of_month()}.${dateTime.get_month()}`] = dayUnix;
		};
	};

	return wanted;
};
