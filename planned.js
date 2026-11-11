import GLib from 'gi://GLib';

import { fetchText } from './net.js';

// Planned works and emergency outages that an oblenergo announces for
// specific addresses, apart from the ГПВ queues. Every provider has its own
// website, so each gets an adapter that turns it into common events:
// {kind: 'planned' | 'emergency', start: Date, end: Date, endKnown, city,
// streets: [{name, houses: [string]}]}. An empty house list means the whole
// street.

const TIME_ZONE = 'Europe/Kyiv';
export const KINDS = ['emergency', 'planned'];

function kyivDate(day, month, year, hour, minute) {
	return new Date(GLib.DateTime.new(GLib.TimeZone.new(TIME_ZONE), year, month, day, hour, minute, 0).to_unix() * 1000);
};

function decodeEntities(text) {
	return text
		.replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&');
};

function cleanText(html) {
	return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
};

// hoe.com.ua answers a POST with an HTML table: a row per settlement and
// time, followed by a row with its streets and houses.
function parseHoe(html, kind) {
	const events = [];

	for (const chunk of html.split('<p class="city">').slice(1)) {
		const times = [...chunk.matchAll(/(\d{2})\.(\d{2})\.(\d{4})\s*<strong>\s*(\d{1,2}):(\d{2})\s*<\/strong>/g)]
			.map(([, day, month, year, hour, minute]) => kyivDate(+day, +month, +year, +hour, +minute));

		if (times.length === 0) {
			continue;
		};

		const streets = [...chunk.matchAll(/<strong>([^<]*)<\/strong>\s*<span class="house">([^<]*)<\/span>/g)]
			.map(([, name, houses]) => ({
				name: cleanText(name),
				houses: cleanText(houses).split(',').map(house => house.trim()).filter(Boolean),
			}));
		// Without an estimate the end is unknown; keep the event alive for a while.
		const endKnown = times.length > 1;

		events.push({
			kind,
			start: times[0],
			end: endKnown ? times[1] : new Date(times[0].getTime() + 6 * 3600 * 1000),
			endKnown,
			city: cleanText(chunk.slice(0, chunk.indexOf('</p>'))),
			streets,
		});
	};

	return events;
};

function hoeDateRange() {
	const now = GLib.DateTime.new_now(GLib.TimeZone.new(TIME_ZONE));

	// The site ignores the range but refuses a request without one.
	return `${now.format('%d.%m.%Y')} - ${now.add_days(7).format('%d.%m.%Y')}`;
};

export const ADAPTERS = {
	Khmelnytskoblenerho: {
		source: 'hoe.com.ua',
		areas: [
			['4', 'Городоцький РЕМ'],
			['23', 'Кам’янець-Подільський РЕМ'],
			['24', 'Летичівський РЕМ'],
			['12', 'Старокостянтинівський РЕМ'],
			['21', 'Хмельницький РЕМ'],
			['17', 'Шепетівський РЕМ'],
		],
		async fetch(session, area, kind, cancellable) {
			const html = await fetchText(session, 'https://hoe.com.ua/shutdown/eventlist', cancellable, {
				form: {
					TypeId: kind === 'planned' ? '2' : '1',
					RemId: area,
					DateRange: hoeDateRange(),
					PageNumber: '1',
				},
			});

			return parseHoe(html, kind);
		},
	},
};

function normalize(text) {
	return text.toLowerCase().replace(/[’'ʼ`´‘]/g, "'").replace(/\s+/g, ' ').trim();
};

// "м. Кам'янець-Подільський (Кам’янець-Подільська громада)" → "кам'янець-подільський"
function cityKey(text) {
	return normalize(text)
		.replace(/\(.*?\)/g, '')
		.replace(/^(м|с|смт|сел|с-ще|селище|село|місто)\.?\s+/, '')
		.trim();
};

const STREET_TYPES = new Set([
	'вул', 'вулиця', 'пров', 'провулок', 'пр', 'просп', 'проспект', 'пл', 'площа',
	'бульв', 'бульвар', 'б-р', 'туп', 'тупик', 'проїзд', 'майдан', 'узвіз', 'шосе', 'тракт',
]);

// Word sets, so "вул. Сис Тамари" matches "Тамари Сис" and "Грушевського М."
// matches "Грушевського Михайла". Initials and street types are dropped.
function streetWords(text) {
	return new Set(normalize(text)
		.split(/[\s.,"«»()]+/)
		.filter(word => word.length > 2 && !STREET_TYPES.has(word)));
};

function isSubset(small, big) {
	return small.size > 0 && [...small].every(word => big.has(word));
};

function houseKey(text) {
	return normalize(text).replace(/[\s"'«»-]/g, '');
};

// Events that touch the address, without duplicates, sorted by start.
export function matchAddress(events, {city, street, house}) {
	const wantCity = cityKey(city);
	const wantStreet = streetWords(street);
	const wantHouse = houseKey(house);
	const seen = new Set();
	const matched = [];

	if (!wantCity || wantStreet.size === 0) {
		return matched;
	};

	for (const event of events) {
		if (cityKey(event.city) !== wantCity) {
			continue;
		};

		const hit = event.streets.some(({name, houses}) => {
			const words = streetWords(name);

			if (!isSubset(wantStreet, words) && !isSubset(words, wantStreet)) {
				return false;
			};

			return houses.length === 0 || !wantHouse || houses.some(item => houseKey(item) === wantHouse);
		});
		const id = `${event.kind}|${event.start.getTime()}|${event.end.getTime()}`;

		if (hit && !seen.has(id)) {
			seen.add(id);
			matched.push(event);
		};
	};

	return matched.sort((a, b) => a.start - b.start);
};
