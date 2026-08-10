/* Shared helpers for the portal pages (notifications, saved, events,
   resources, activity). Loaded before each page's own script. */
window.NSPA = (function () {
  const esc = s =>
    String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

  async function api(url, opts) {
    const r = await fetch(url, opts);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(d.error || 'Request failed.');
      err.status = r.status;
      err.auth = d.auth || null; // 'signin' | 'membership'
      throw err;
    }
    return d;
  }

  /* ── Session ───────────────────────────────────────────────────────────
     The signed httpOnly cookie set at sign-in is the only real source of
     truth, and it lasts 30 days. Pages must therefore ask the server who
     the user is rather than trusting browser storage.

     sessionStorage in particular is per-tab: gating on it logged people out
     whenever they opened a page in a new tab or restarted the browser, even
     though their session was still perfectly valid. localStorage is now used
     only as a paint hint, never as the gate. */
  const MEMBER_CACHE_KEY = 'nspaMember';
  let mePromise = null;

  function cachedMember() {
    try {
      return JSON.parse(localStorage.getItem(MEMBER_CACHE_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function cacheMember(member) {
    try {
      if (member) localStorage.setItem(MEMBER_CACHE_KEY, JSON.stringify(member));
      else localStorage.removeItem(MEMBER_CACHE_KEY);
    } catch { /* private browsing — the server session still works */ }
  }

  // De-duplicated so several widgets on one page share a single request.
  function getSession({ force = false } = {}) {
    if (!mePromise || force) {
      mePromise = api('/api/me')
        .then(me => {
          cacheMember(me.authenticated ? me.member : null);
          return me;
        })
        .catch(() => ({ authenticated: false, member: null, isAdmin: false, offline: true }));
    }
    return mePromise;
  }

  /**
   * Gate a member-only page. Returns the session, or redirects and never
   * resolves. `requireMembership` also demands an active membership.
   */
  async function requireSession({ requireMembership = true } = {}) {
    const me = await getSession();
    if (!me.authenticated) {
      const next = encodeURIComponent(location.pathname + location.search);
      location.replace(me.wixMemberLoginUrl || `/signup.html?next=${next}`);
      return new Promise(() => {});
    }
    if (requireMembership && !(me.member && me.member.isMember)) {
      location.replace('/membership.html');
      return new Promise(() => {});
    }
    return me;
  }

  async function signOut() {
    const session = await getSession({ force: true }).catch(() => ({}));
    cacheMember(null);
    mePromise = null;
    try { await fetch('/api/signout', { method: 'POST' }); } catch {}
    location.href = session.wixMemberLoginUrl || '/signup.html';
  }

  // Toasts double as the page's live region, so screen readers announce them.
  function showToast(msg, type = 'success') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.innerHTML = `<span class="toast-icon" aria-hidden="true">${type === 'success' ? '✓' : '✕'}</span>${esc(msg)}`;
    toast.className = `toast ${type} show`;
    setTimeout(() => toast.classList.remove('show'), 3500);
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? esc(iso) : d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return esc(iso);
    return d.toLocaleString('en-CA', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  // "3 days ago" style, falling back to a date past a week.
  function fmtRelative(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    const secs = Math.round((Date.now() - d.getTime()) / 1000);
    if (secs < 60) return 'just now';
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.round(hours / 24);
    if (days <= 7) return `${days} day${days === 1 ? '' : 's'} ago`;
    return fmtDate(iso);
  }

  function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (!n) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function debounce(fn, ms = 250) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function statusBadge(status) {
    const s = String(status || 'Pending');
    const cls = s.toLowerCase().replace(/[^a-z]+/g, '-');
    return `<span class="status-badge status-${esc(cls)}">${esc(s)}</span>`;
  }

  // Tells nav.js to refresh the unread badge after a read/delete.
  function notificationsChanged() {
    window.dispatchEvent(new CustomEvent('nspa:notifications-changed'));
  }

  /* Bookmark toggle shared by any list that shows projects. */
  function favoriteButton(projectId, saved) {
    return `<button type="button" class="fav-btn${saved ? ' saved' : ''}" data-project="${esc(projectId)}"
              aria-pressed="${saved ? 'true' : 'false'}"
              aria-label="${saved ? 'Remove from saved projects' : 'Save this project'}">
              <svg viewBox="0 0 14 16" width="13" height="15" aria-hidden="true">
                <path d="M2.5 1.5h9v13l-4.5-3.2-4.5 3.2z" fill="${saved ? 'currentColor' : 'none'}"
                      stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
              </svg>
              <span class="fav-btn-text">${saved ? 'Saved' : 'Save'}</span>
            </button>`;
  }

  async function toggleFavorite(btn) {
    const id = btn.dataset.project;
    const saved = btn.classList.contains('saved');
    btn.disabled = true;
    try {
      await api(`/api/favorites/${encodeURIComponent(id)}`, { method: saved ? 'DELETE' : 'POST' });
      const nowSaved = !saved;
      btn.classList.toggle('saved', nowSaved);
      btn.setAttribute('aria-pressed', String(nowSaved));
      btn.setAttribute('aria-label', nowSaved ? 'Remove from saved projects' : 'Save this project');
      btn.querySelector('.fav-btn-text').textContent = nowSaved ? 'Saved' : 'Save';
      btn.querySelector('path').setAttribute('fill', nowSaved ? 'currentColor' : 'none');
      showToast(nowSaved ? 'Project saved.' : 'Removed from saved projects.', 'success');
      return nowSaved;
    } catch (e) {
      showToast(e.message, 'error');
      return saved;
    } finally {
      btn.disabled = false;
    }
  }

  return {
    esc, api, showToast, fmtDate, fmtDateTime, fmtRelative, fmtSize,
    debounce, statusBadge, notificationsChanged, favoriteButton, toggleFavorite,
    getSession, requireSession, signOut, cachedMember, cacheMember,
  };
})();
