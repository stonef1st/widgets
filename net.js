import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const USER_AGENT = 'widgets-uk GNOME Shell extension (https://github.com/stonef1st/widgets)';

export function createSession() {
	return new Soup.Session({
		timeout: 20,
		user_agent: USER_AGENT,
	});
};

export async function fetchJson(session, url, cancellable = null) {
	const message = Soup.Message.new('GET', url);
	const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
	const status = message.get_status();

	if (status !== Soup.Status.OK) {
		throw new Error(`HTTP ${status} for ${url}`);
	};

	return JSON.parse(new TextDecoder().decode(bytes.get_data()));
};
