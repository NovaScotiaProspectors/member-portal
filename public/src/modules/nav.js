// Shared site navigation. Pages provide an empty <nav class="site-nav">
// container and this module renders the links from one definition so ordering,
// active states, and labels stay consistent.
//
// Base links render immediately. Session-specific links are appended after
// /api/me resolves.
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ── Single source of truth ──
     `match` lists additional paths that should activate the same nav item. */
  const NAV_ITEMS = [
    { href: '/',                label: 'Home',         match: ['/home.html'] },
    { href: '/map.html',        label: 'Map',          match: ['/project.html', '/compare.html'] },
    { href: '/network.html',    label: 'Network',      match: ['/member.html'] },
    { href: '/events.html',     label: 'Events' },
    { href: '/membership.html', label: 'Join' },
  ];

  const PORTAL_ITEMS = [
    { href: '/dashboard.html',  label: 'Member Dashboard' },
    { href: '/index.html',      label: 'Project Form' },
    { href: '/claims.html',     label: 'Claims & Alerts' },
    { href: '/search.html',     label: 'Search' },
    { href: '/field.html',      label: 'Field Mode' },
    { href: '/saved.html',      label: 'Saved' },
    { href: '/activity.html',   label: 'Activity' },
    { href: '/prices.html',     label: 'Metal Prices' },
  ];

  // Public pages are excluded from this list. All listed paths require active
  // membership; notifications are reached through the bell.
  const MEMBER_ONLY = [
    '/index.html', '/dashboard.html', '/network.html',
    '/notifications.html', '/saved.html', '/events.html',
    '/activity.html', '/search.html', '/project.html', '/compare.html',
    '/member.html', '/field.html', '/claims.html',
  ];

  const nav = document.querySelector('.site-nav');
  const here = location.pathname === '/' ? '/' : location.pathname;
  const isCurrent = item => item.href === here || (item.match || []).includes(here);
  let mobileMenu = null;

  function renderMobileMenu(state = {}) {
    if (!mobileMenu) return;
    const extras = [];
    if (state.wixSiteUrl) extras.push({ href: state.wixSiteUrl, label: 'Website' });
    if (state.isAdmin) extras.push({ href: '/admin.html', label: 'Admin' });
    if (!state.authenticated) extras.push({ href: state.loginUrl || '/signup.html', label: 'Member Login' });

    const link = item => `
      <a href="${esc(item.href)}" class="nav-mobile-link${isCurrent(item) ? ' active' : ''}"${isCurrent(item) ? ' aria-current="page"' : ''}>
        ${esc(item.label)}
      </a>`;

    mobileMenu.querySelector('.nav-mobile-panel').innerHTML = `
      <span class="nav-mobile-group">Main</span>
      ${NAV_ITEMS.map(link).join('')}
      <span class="nav-mobile-group">Portal</span>
      ${PORTAL_ITEMS.map(link).join('')}
      ${extras.length || state.authenticated ? `<span class="nav-mobile-group">Account</span>${extras.map(link).join('')}` : ''}
      ${state.authenticated ? '<button type="button" class="nav-mobile-link nav-mobile-button" id="navMobileLogout">Log Out</button>' : ''}`;

    mobileMenu.querySelectorAll('a[href]').forEach(a => {
      a.addEventListener('click', () => { mobileMenu.open = false; });
    });
    const mobileLogout = document.getElementById('navMobileLogout');
    if (mobileLogout) {
      mobileLogout.addEventListener('click', () => {
        const logout = document.getElementById('navLogout');
        if (logout) logout.click();
      });
    }
  }

  /* ── Links, rendered immediately ── */
  if (nav) {
    nav.innerHTML = ''; // normalize any page-level placeholder content
    nav.setAttribute('aria-label', 'Site navigation');
    nav.classList.add('nspa-nav');

    const brand = document.createElement('a');
    brand.href = '/';
    brand.className = 'nav-brand';
    brand.setAttribute('aria-label', 'Nova Scotia Prospectors Association home');
    brand.innerHTML = `
      <img src="/assets/nspa-logo.png" alt="" class="nav-logo" />
      <span class="nav-brand-text">Nova Scotia Prospectors Association</span>`;
    nav.appendChild(brand);

    mobileMenu = document.createElement('details');
    mobileMenu.className = 'nav-mobile-menu';
    mobileMenu.innerHTML = `
      <summary class="nav-mobile-summary">Menu</summary>
      <div class="nav-mobile-panel"></div>`;
    nav.appendChild(mobileMenu);
    renderMobileMenu();

    for (const item of NAV_ITEMS) {
      const a = document.createElement('a');
      a.href = item.href;
      a.textContent = item.label;
      a.className = 'nav-link nav-desktop-item';
      if (isCurrent(item)) {
        a.classList.add('active');
        a.setAttribute('aria-current', 'page');
      }
      nav.appendChild(a);
    }

    const portalMenu = document.createElement('details');
    portalMenu.className = 'nav-menu nav-desktop-item';
    portalMenu.innerHTML = `
      <summary class="nav-link${PORTAL_ITEMS.some(isCurrent) ? ' active' : ''}">Portal</summary>
      <div class="nav-menu-panel">
        ${PORTAL_ITEMS.map(item => `
          <a href="${item.href}" class="nav-menu-link${isCurrent(item) ? ' active' : ''}"${isCurrent(item) ? ' aria-current="page"' : ''}>${esc(item.label)}</a>
        `).join('')}
      </div>`;
    nav.appendChild(portalMenu);

    const closePortalMenu = () => { portalMenu.open = false; };
    const openPortalMenu = () => { portalMenu.open = true; };
    portalMenu.addEventListener('mouseenter', openPortalMenu);
    portalMenu.addEventListener('mouseleave', closePortalMenu);
    portalMenu.querySelector('summary').addEventListener('focus', openPortalMenu);
    portalMenu.querySelectorAll('a[href]').forEach(a => {
      a.addEventListener('click', closePortalMenu);
    });
    portalMenu.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        closePortalMenu();
        portalMenu.querySelector('summary').focus();
      }
    });
    portalMenu.addEventListener('focusout', () => {
      requestAnimationFrame(() => {
        if (!portalMenu.contains(document.activeElement)) closePortalMenu();
      });
    });
    document.addEventListener('pointerdown', e => {
      if (portalMenu.open && !portalMenu.contains(e.target)) closePortalMenu();
    });
  }

  /* ── Members-only popup ── */
  let overlay = null;
  let me = { authenticated: false };
  let isMember = false;

  function buildModal() {
    overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const loginUrl = me.wixMemberLoginUrl || '/signup.html';
    const cta = me.authenticated
      ? '<a class="submit-btn" href="/membership.html">View Membership</a>'
      : `<a class="submit-btn" href="${esc(loginUrl)}">Member Login</a>`;
    const msg = me.authenticated
      ? "Your membership isn't active. Join to unlock the project form, network, and your dashboard."
      : 'Please log in or create an account to access member features like the project form, network, and your dashboard.';

    overlay.innerHTML = `
      <div class="modal-box" role="document">
        <p class="modal-title">Members only</p>
        <p class="modal-text">${msg}</p>
        <div class="modal-actions">
          <button type="button" class="secondary-btn modal-close">Close</button>
          ${cta}
        </div>
      </div>`;

    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => {
      if (e.target === overlay || e.target.classList.contains('modal-close')) closeModal();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  }

  function openModal() { if (!overlay) buildModal(); overlay.classList.add('open'); }
  function closeModal() { if (overlay) overlay.classList.remove('open'); }

  /* ── Auth-aware pieces, once the session is known ── */
  (async function () {
    try { me = await (await fetch('/api/me')).json(); } catch { /* offline — links still work */ }
    isMember = !!(me.member && me.member.isMember);

    // Guard member-only links for users without an active membership.
    if (!isMember) {
      document.addEventListener('click', e => {
        const a = e.target.closest ? e.target.closest('a[href]') : null;
        if (!a) return;
        let path;
        try { path = new URL(a.href, location.origin).pathname; } catch { return; }
        if (MEMBER_ONLY.includes(path)) {
          e.preventDefault();
          openModal();
        }
      });
    }

    if (!nav) return;

    if (me.wixSiteUrl) {
      const a = document.createElement('a');
      a.href = me.wixSiteUrl;
      a.className = 'nav-link nav-desktop-item';
      a.textContent = 'Website';
      nav.appendChild(a);
    }

    // Admins receive a consistent admin entry across pages.
    if (me.isAdmin) {
      const a = document.createElement('a');
      a.href = '/admin.html';
      a.className = 'nav-admin nav-desktop-item';
      a.textContent = 'Admin';
      if (here === '/admin.html') {
        a.classList.add('active');
        a.setAttribute('aria-current', 'page');
      }
      nav.appendChild(a);
    }

    const auth = document.createElement('div');
    auth.className = 'nav-auth nav-desktop-item';

    if (me.authenticated) {
      const name = esc((me.member && me.member.firstName) || 'Member');
      const badge = isMember ? '<span class="nav-badge">Member</span>' : '';
      const bell = isMember
        ? `<a class="nav-bell" href="/notifications.html" aria-label="Notifications">
             <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
               <path d="M8 1.8a4 4 0 00-4 4v2.3L2.9 10.4a.5.5 0 00.45.72h9.3a.5.5 0 00.45-.72L12 8.1V5.8a4 4 0 00-4-4zM6.4 12.6a1.7 1.7 0 003.2 0"
                     stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
             </svg>
             <span class="nav-bell-count" id="navBellCount" hidden></span>
           </a>`
        : '';
      auth.innerHTML = `${badge}${bell}<span class="nav-user">${name}</span><button type="button" class="nav-logout" id="navLogout">Log Out</button>`;
    } else {
      auth.innerHTML = `<a class="nav-login" href="${esc(me.wixMemberLoginUrl || '/signup.html')}">Member Login</a>`;
    }

    nav.appendChild(auth);
    renderMobileMenu({
      wixSiteUrl: me.wixSiteUrl,
      isAdmin: me.isAdmin,
      authenticated: me.authenticated,
      loginUrl: me.wixMemberLoginUrl || '/signup.html',
    });

    /* ── Unread notification badge ── */
    if (isMember) {
      const countEl = document.getElementById('navBellCount');
      const paint = n => {
        if (!countEl) return;
        countEl.textContent = n > 99 ? '99+' : String(n);
        countEl.hidden = n === 0;
        const bellLink = countEl.closest('.nav-bell');
        if (bellLink) {
          bellLink.setAttribute('aria-label', n === 0 ? 'Notifications' : `Notifications, ${n} unread`);
        }
      };

      const refresh = async () => {
        try {
          const r = await fetch('/api/notifications/unread-count');
          if (!r.ok) return;
          paint((await r.json()).unread || 0);
        } catch {}
      };

      refresh();
      window.addEventListener('nspa:notifications-changed', refresh);
      // Keep the badge current without polling while the tab is hidden.
      setInterval(() => { if (!document.hidden) refresh(); }, 120000);
    }

    const logout = document.getElementById('navLogout');
    if (logout) {
      logout.addEventListener('click', async () => {
        try { sessionStorage.removeItem('nspaMember'); } catch {}
        if (window.NSPA && NSPA.signOut) return NSPA.signOut();
        try { localStorage.removeItem('nspaMember'); } catch {}
        try { await fetch('/api/signout', { method: 'POST' }); } catch {}
        window.location.href = me.wixMemberLoginUrl || '/signup.html';
      });
    }
  })();
})();
