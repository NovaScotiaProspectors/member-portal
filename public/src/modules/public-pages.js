'use strict';

function safePortalNext(value) {
  const next = String(value || '').trim();
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '';
  if (/[\x00-\x1f\x7f]/.test(next)) return '';
  return next.slice(0, 512);
}

/* signup */
if (location.pathname === '/signup.html') {
  (() => {
    const next = safePortalNext(new URLSearchParams(location.search).get('next'));
    const wixButton = document.getElementById('wix-signin-btn');
    if (wixButton) wixButton.href = `/api/auth/wix${next ? `?next=${encodeURIComponent(next)}` : ''}`;

    NSPA.getSession().then(me => {
      if (!me.authenticated || !me.member) return;
      if (!me.profileComplete) {
        window.location.replace(`/complete-profile.html${next ? `?next=${encodeURIComponent(next)}` : ''}`);
        return;
      }
      window.location.replace(me.member.isMember ? (next || '/dashboard.html') : '/membership.html');
    });
  })();
}

/* Wix profile completion */
if (location.pathname === '/complete-profile.html') {
  (() => {
    const showToast = NSPA.showToast;
    const form = document.getElementById('wix-profile-form');
    const submit = document.getElementById('complete-profile-btn');
    const next = safePortalNext(new URLSearchParams(location.search).get('next'));

    NSPA.getSession().then(me => {
      if (!me.authenticated || !me.member) {
        window.location.replace(`/api/auth/wix${next ? `?next=${encodeURIComponent(next)}` : ''}`);
        return;
      }
      if (me.profileComplete) {
        window.location.replace(me.member.isMember ? (next || '/dashboard.html') : '/membership.html');
        return;
      }

      document.getElementById('wix-profile-email').textContent = me.member.email;
      const missingFields = new Set(me.missingProfileFields || []);
      for (const field of ['firstName', 'lastName', 'phone']) {
        const input = document.getElementById(`wix-profile-${field}`);
        const wrapper = input.closest('[data-profile-field]');
        const value = String(me.member[field] || '').trim();
        const needsConfirmation = missingFields.has(field);
        input.value = needsConfirmation ? '' : value;
        wrapper.hidden = !needsConfirmation;
      }
      form.hidden = false;
    }).catch(() => showToast('Could not load your Wix account.', 'error'));

    form.addEventListener('submit', async event => {
      event.preventDefault();
      submit.disabled = true;
      try {
        const response = await fetch('/api/auth/wix/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            firstName: document.getElementById('wix-profile-firstName').value,
            lastName: document.getElementById('wix-profile-lastName').value,
            phone: document.getElementById('wix-profile-phone').value,
            next,
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Could not save your details.');
        NSPA.cacheMember(data.member);
        window.location.href = data.next;
      } catch (error) {
        showToast(error.message || 'Could not save your details.', 'error');
        submit.disabled = false;
      }
    });
  })();
}

/* membership */
if (location.pathname === '/membership.html') {
  (() => {
    const body = document.getElementById('membershipBody');
        const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
    
        function showToast(msg, type = 'success') {
          const toast = document.getElementById('toast');
          toast.innerHTML = `<span class="toast-icon">${type === 'success' ? '✓' : '✕'}</span>${esc(msg)}`;
          toast.className = `toast ${type} show`;
          setTimeout(() => toast.classList.remove('show'), 3500);
        }
    
        async function api(url, opts) {
          const r = await fetch(url, opts);
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || 'Request failed.');
          return d;
        }
    
        function render(me) {
          const m = me.member;
    
          if (!me.authenticated) {
            const loginUrl = me.wixMemberLoginUrl || '/signup.html';
            body.innerHTML = `
              <p class="section-label">Membership</p>
              <p class="membership-lead">You need an account before you can join.</p>
              <a class="submit-btn" href="${esc(loginUrl)}">Member Login</a>`;
            return;
          }

          if (!me.profileComplete) {
            window.location.replace('/complete-profile.html');
            return;
          }
    
          if (m.isMember) {
            const expiry = m.membershipExpiry
              ? new Date(m.membershipExpiry).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })
              : '';
            body.innerHTML = `
              <p class="section-label">Your Membership</p>
              <p class="membership-lead"><span class="nav-badge">Active Member</span></p>
              <p class="membership-lead">You're all set, ${esc(m.firstName)}. Member ID <strong>${esc(m.memberId)}</strong>${expiry ? ` · valid through <strong>${esc(expiry)}</strong>` : ''}.</p>
              <div class="membership-links">
                <a class="submit-btn" href="/index.html">Open Project Form</a>
                <a class="secondary-btn" href="/dashboard.html">Member Dashboard</a>
                <a class="secondary-btn" href="/network.html">Network</a>
              </div>
              <p class="auth-footer"><a href="#" id="cancelLink">Cancel membership</a> · <a href="#" id="logoutLink">Log out</a></p>`;
            const cl = document.getElementById('cancelLink');
            if (cl) cl.addEventListener('click', cancelMembership);
            bindLogout(me);
            return;
          }
    
          // New members (no memberSince yet) who join on or after 1 July get the
          // rest of this year free — their payment covers the following year.
          // Renewals (lapsed members re-joining) stay on the current-year expiry.
          const now = new Date();
          const isNewMember = !m.memberSince;
          const julyBonus = isNewMember && now.getMonth() >= 6;
          const expiryYear = julyBonus ? now.getFullYear() + 1 : now.getFullYear();
          const sv = m.studentVerification || { status: 'none' };
          const studentVerified = sv.status === 'verified';
          body.innerHTML = `
            <p class="section-label">Membership</p>
            <div class="membership-plan-grid">
              <article class="membership-plan">
                <p class="membership-plan-kicker">Student Member</p>
                <div class="membership-price"><span>CA$15</span><small>valid through Dec 31, ${expiryYear}</small></div>
                ${studentVerified
                  ? `<p class="form-hint">School email verified: ${esc(sv.schoolEmail || '')}</p>`
                  : `<div class="student-verify-box">
                      <label for="studentInstitution">School / institution</label>
                      <input id="studentInstitution" type="text" maxlength="120" value="${esc(sv.institution || '')}" autocomplete="organization" />
                      <label for="studentEmail">School email</label>
                      <input id="studentEmail" type="email" value="${esc(sv.schoolEmail || '')}" autocomplete="email" />
                      <button type="button" class="secondary-btn" id="sendStudentCodeBtn">Send Code</button>
                      <div class="student-code-row">
                        <input id="studentCode" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="6-digit code" />
                        <button type="button" class="secondary-btn" id="confirmStudentCodeBtn">Verify</button>
                      </div>
                    </div>`}
                <button class="submit-btn membership-plan-btn" data-plan="student"${me.paymentsEnabled && studentVerified ? '' : ' disabled'}>Pay with Zeffy</button>
              </article>
              <article class="membership-plan">
                <p class="membership-plan-kicker">Regular Member</p>
                <div class="membership-price"><span>CA$35</span><small>valid through Dec 31, ${expiryYear}</small></div>
                <button class="submit-btn membership-plan-btn" data-plan="regular"${me.paymentsEnabled ? '' : ' disabled'}>Pay with Zeffy</button>
              </article>
            </div>
            <ul class="membership-benefits">
              <li>Submit and track projects with NovaROC tenure lookup</li>
              <li>Confirm claim locations on the map</li>
              <li>Live metal &amp; mineral prices</li>
              <li>Membership runs until 31 December ${expiryYear}</li>
              ${julyBonus ? `<li><strong>New-member bonus:</strong> join on or after 1 July and the rest of ${now.getFullYear()} is included at no extra cost — your payment covers the ${expiryYear} membership year</li>` : ''}
            </ul>
            ${me.paymentsEnabled ? '<p class="form-hint">Payment opens in Zeffy. Your access is activated automatically after Zeffy verifies the payment. Use the same email as your portal account.</p>' : '<p class="form-hint">Zeffy automatic checkout is not configured yet. Add the checkout URLs, API key, campaign IDs, and webhook described in .env.example.</p>'}
            <p class="auth-footer"><a href="#" id="logoutLink">Log out</a></p>`;
    
          document.querySelectorAll('.membership-plan-btn').forEach(btn => {
            if (me.paymentsEnabled) btn.addEventListener('click', () => startCheckout(btn));
          });
          const sendStudentCodeBtn = document.getElementById('sendStudentCodeBtn');
          if (sendStudentCodeBtn) sendStudentCodeBtn.addEventListener('click', sendStudentCode);
          const confirmStudentCodeBtn = document.getElementById('confirmStudentCodeBtn');
          if (confirmStudentCodeBtn) confirmStudentCodeBtn.addEventListener('click', confirmStudentCode);
          bindLogout(me);
        }
    
        function bindLogout(me = {}) {
          const ll = document.getElementById('logoutLink');
          if (ll) ll.addEventListener('click', async e => {
            e.preventDefault();
            try { await fetch('/api/signout', { method: 'POST' }); } catch {}
            window.location.href = me.wixMemberLoginUrl || '/signup.html';
          });
        }
    
        async function startCheckout(btn) {
          const plan = btn.dataset.plan;
          btn.disabled = true;
          btn.textContent = 'Opening Zeffy...';
          try {
            const d = await api('/api/checkout', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ plan }),
            });
            window.location.href = d.url;
          } catch (e) {
            showToast(e.message, 'error');
            btn.disabled = false;
            btn.textContent = 'Pay with Zeffy';
          }
        }
    
        async function sendStudentCode() {
          const btn = document.getElementById('sendStudentCodeBtn');
          btn.disabled = true;
          btn.textContent = 'Sending...';
          try {
            const d = await api('/api/student-verification/send', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                institution: document.getElementById('studentInstitution').value,
                schoolEmail: document.getElementById('studentEmail').value,
              }),
            });
            showToast('Verification code sent.', 'success');
            const me = await api('/api/me');
            me.member.studentVerification = d.verification;
            render(me);
          } catch (e) {
            showToast(e.message, 'error');
            btn.disabled = false;
            btn.textContent = 'Send Code';
          }
        }
    
        async function confirmStudentCode() {
          const btn = document.getElementById('confirmStudentCodeBtn');
          btn.disabled = true;
          btn.textContent = 'Checking...';
          try {
            await api('/api/student-verification/confirm', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code: document.getElementById('studentCode').value }),
            });
            showToast('Student email verified.', 'success');
            render(await api('/api/me'));
          } catch (e) {
            showToast(e.message, 'error');
            btn.disabled = false;
            btn.textContent = 'Verify';
          }
        }
    
        async function cancelMembership(e) {
          if (e) e.preventDefault();
          if (!confirm('Cancel your membership? You keep your account and project history but lose member access until you re-join.')) return;
          try {
            await api('/api/membership/cancel', { method: 'POST' });
            showToast('Membership cancelled.', 'success');
            render(await api('/api/me'));
          } catch (err) {
            showToast(err.message, 'error');
          }
        }
    
        async function init() {
          const params = new URLSearchParams(location.search);
          if (params.get('canceled')) showToast('Checkout canceled — you can join any time.', 'error');
          try {
            render(await api('/api/me'));
          } catch (e) {
            body.innerHTML = '<p class="section-label">Membership</p><p class="form-hint">Could not load membership status. Please refresh.</p>';
          }
        }
    
        init();
  })();
}

/* prices */
if (location.pathname === '/prices.html') {
  (() => {
    const grid = document.getElementById('pricesGrid');
        const updatedEl = document.getElementById('pricesUpdated');
        const refreshBtn = document.getElementById('refreshBtn');
        const searchEl = document.getElementById('priceSearch');
        const categoryEl = document.getElementById('categoryFilter');
        const availabilityEl = document.getElementById('availabilityFilter');
        const summaryEl = document.getElementById('pricesSummary');
        let metals = [];
    
        function fmtPrice(value, currency) {
          const digits = Math.abs(value) < 10 ? 4 : 2;
          const num = value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits });
          return `${currency === 'USD' ? '$' : ''}${num}${currency !== 'USD' ? ' ' + currency : ''}`;
        }
    
        function changeBadge(m) {
          if (!m.ok || typeof m.change !== 'number') return ''; // no change data on the free plan
          const dir = m.change > 0.0001 ? 'up' : m.change < -0.0001 ? 'down' : 'flat';
          const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '◆';
          const pct = Math.abs(m.changePct).toFixed(2);
          return `<span class="price-change ${dir}">${arrow} ${pct}%</span>`;
        }
    
        function renderCard(m) {
          if (!m.ok) {
            return `
              <div class="price-card unavailable" data-category="${esc(m.category || '')}">
                <div class="price-card-head">
                  <span class="price-name">${esc(m.name)}</span>
                  <span class="price-symbol">${esc(m.symbol)}</span>
                </div>
                <span class="price-category">${esc(m.category || 'Metal')}</span>
                <div class="price-value">Unavailable</div>
                <div class="price-meta"><span class="price-unit">${esc(m.unit)}</span>${changeBadge(m)}</div>
              </div>`;
          }
          return `
            <div class="price-card" data-category="${esc(m.category || '')}">
              <div class="price-card-head">
                <span class="price-name">${esc(m.name)}</span>
                <span class="price-symbol">${esc(m.symbol)}</span>
              </div>
              <span class="price-category">${esc(m.category || 'Metal')}</span>
              <div class="price-value">${fmtPrice(m.price, m.currency)}</div>
              <div class="price-meta"><span class="price-unit">${esc(m.unit)}</span>${changeBadge(m)}</div>
            </div>`;
        }
    
        function esc(s) {
          return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
        }
    
        function fillCategories() {
          const current = categoryEl.value;
          const categories = [...new Set(metals.map(m => m.category).filter(Boolean))].sort();
          categoryEl.innerHTML = '<option value="">All categories</option>' +
            categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
          categoryEl.value = categories.includes(current) ? current : '';
        }
    
        function filteredMetals() {
          const term = searchEl.value.trim().toLowerCase();
          const category = categoryEl.value;
          const availability = availabilityEl.value;
          return metals.filter(m => {
            const haystack = [m.name, m.symbol, m.category, m.unit].join(' ').toLowerCase();
            if (term && !haystack.includes(term)) return false;
            if (category && m.category !== category) return false;
            if (availability === 'available' && !m.ok) return false;
            if (availability === 'unavailable' && m.ok) return false;
            return true;
          });
        }
    
        function renderPrices() {
          const shown = filteredMetals();
          const available = shown.filter(m => m.ok).length;
          summaryEl.textContent = `${shown.length} of ${metals.length} shown · ${available} available`;
          grid.innerHTML = shown.length
            ? shown.map(renderCard).join('')
            : '<p class="prices-disclaimer">No prices match those filters.</p>';
        }
    
        async function loadPrices() {
          refreshBtn.disabled = true;
          updatedEl.textContent = 'Refreshing…';
          try {
            const res = await fetch('/api/metal-prices');
            if (!res.ok) throw new Error('request failed');
            const data = await res.json();
    
            metals = data.metals || [];
            fillCategories();
            renderPrices();
    
            const t = new Date(data.updatedAt);
            updatedEl.textContent = 'Updated ' + t.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' });
          } catch (err) {
            updatedEl.textContent = 'Could not load prices';
            if (!grid.children.length) {
              grid.innerHTML = '<p class="prices-disclaimer">Unable to reach the price service right now. Try Refresh in a moment.</p>';
            }
          } finally {
            refreshBtn.disabled = false;
          }
        }
    
        refreshBtn.addEventListener('click', loadPrices);
        searchEl.addEventListener('input', renderPrices);
        categoryEl.addEventListener('change', renderPrices);
        availabilityEl.addEventListener('change', renderPrices);
        loadPrices();
        setInterval(loadPrices, 90000); // auto-refresh every 90s
  })();
}
