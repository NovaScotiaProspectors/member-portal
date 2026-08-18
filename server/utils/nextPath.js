/* ── Where the visitor was actually going ──────────────────────────────────
 * A guarded page bounces signed-out visitors to the sign-in form. Without
 * carrying the original destination, everyone lands on the same default page —
 * so a member following a claim-alert email to /claims.html signs in and finds
 * themselves somewhere else entirely, with nothing to say where they meant to
 * be. The `?next=` parameter carries it across.
 *
 * It is a redirect target supplied through a URL, so it is only ever a
 * same-origin path: never an absolute URL, never protocol-relative, or the
 * sign-in page becomes an open redirect for anyone who can get a member to
 * click a link.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Narrows a requested URL to a path safe to redirect back to.
 * @returns {string} the path, or '' when it cannot be trusted.
 */
function safeNextPath(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';

  // Must be a rooted path. '//evil.test' is protocol-relative and would leave
  // the site; '/\evil.test' is treated as protocol-relative by some browsers.
  if (!raw.startsWith('/')) return '';
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '';

  // A control character or newline could be used to smuggle a second header.
  if (/[\x00-\x1f\x7f]/.test(raw)) return '';

  return raw.slice(0, 512);
}

/** `?next=…` for a redirect, or '' when there is nothing worth carrying. */
function nextQuery(value) {
  const path = safeNextPath(value);
  return path ? `?next=${encodeURIComponent(path)}` : '';
}

module.exports = { safeNextPath, nextQuery };
