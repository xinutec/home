/**
 * The `return_to` of a sign-in, or `/` if it is anything but a same-site path.
 *
 * Guards the open redirect: `/login?return_to=//evil.com` would otherwise end
 * in `302 Location: //evil.com`, which the browser follows off-site. So the
 * value must be `/` then a non-`/` (`/\evil.com` is refused too: browsers read
 * `\` as `/`), and only URL-safe characters after that.
 */

const SAFE_PATH = /^\/[a-zA-Z0-9_\-.~+/?=&%]*$/;

export function validateReturnTo(raw: string | undefined): string {
	if (!raw) return "/";
	if (raw === "/") return "/";
	if (raw.length < 2 || raw[0] !== "/" || raw[1] === "/" || raw[1] === "\\") return "/";
	if (!SAFE_PATH.test(raw)) return "/";
	return raw;
}
