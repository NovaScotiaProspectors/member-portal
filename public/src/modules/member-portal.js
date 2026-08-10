'use strict';

/* activity */
if (location.pathname === '/activity.html') {
  (() => {
    const { esc, api, fmtRelative } = NSPA;
        const body = document.getElementById('activityBody');
        const pager = document.getElementById('pager');
        const loadMoreBtn = document.getElementById('loadMoreBtn');
    
        const PAGE_SIZE = 20;
        let offset = 0;
        let loaded = [];
    
        // Each activity type gets a glyph and accent so the feed scans quickly.
        const TYPE_META = {
          project_submitted: { icon: '◆', cls: 'submitted', label: 'New project' },
          project_approved:  { icon: '✓', cls: 'approved',  label: 'Approved' },
          documents_added:   { icon: '⎘', cls: 'document',  label: 'Documents' },
          event_created:     { icon: '◈', cls: 'event',     label: 'Event' },
          resource_added:    { icon: '❖', cls: 'resource',  label: 'Resource' },
        };
    
        function row(item) {
          const meta = TYPE_META[item.type] || { icon: '•', cls: 'default', label: 'Update' };
          const link = item.projectId
            ? `<a class="activity-link" href="/dashboard.html">${esc(item.projectId)}</a>`
            : '';
          return `
            <li class="activity-item">
              <span class="activity-icon activity-${meta.cls}" aria-hidden="true">${meta.icon}</span>
              <span class="activity-main">
                <span class="activity-summary">${esc(item.summary)}</span>
                <span class="activity-meta">
                  <span class="activity-type">${esc(meta.label)}</span>
                  <time datetime="${esc(item.createdAt)}">${esc(fmtRelative(item.createdAt))}</time>
                  ${link}
                </span>
              </span>
            </li>`;
        }
    
        function render(total) {
          if (!loaded.length) {
            body.innerHTML = '<p class="membership-lead">No activity yet. Once members submit projects, it will show up here.</p>';
            pager.hidden = true;
            return;
          }
          body.innerHTML = `<ul class="activity-list">${loaded.map(row).join('')}</ul>`;
          pager.hidden = loaded.length >= total;
        }
    
        async function load() {
          loadMoreBtn.disabled = true;
          try {
            const data = await api(`/api/activity?limit=${PAGE_SIZE}&offset=${offset}`);
            loaded = loaded.concat(data.items);
            offset += data.items.length;
            render(data.total);
          } catch (e) {
            body.innerHTML = `<p class="form-hint">Could not load the activity feed. ${esc(e.message)}</p>`;
          } finally {
            body.setAttribute('aria-busy', 'false');
            loadMoreBtn.disabled = false;
          }
        }
    
        loadMoreBtn.addEventListener('click', load);
        load();
  })();
}

/* dashboard */
if (location.pathname === '/dashboard.html') {
  (() => {
    // Shared helpers come from portal.js so behaviour matches the other pages.
        const { esc, api, showToast, fmtDate, fmtDateTime } = NSPA;
    
        const accountBody = document.getElementById('accountBody');
        const projectsBody = document.getElementById('projectsBody');
    
        /* ── Profile editor ─────────────────────────────────────────────────── */
        const PF = id => document.getElementById(id);
        const VIS_KEYS = ['email', 'phone', 'projects', 'tenures', 'commodities'];
        let myMemberId = '';
    
        function paintAvatar(hasAvatar, name) {
          const img = PF('avatarPreview');
          const fallback = PF('avatarFallback');
          if (hasAvatar && myMemberId) {
            img.src = `/api/members/${encodeURIComponent(myMemberId)}/avatar?t=${Date.now()}`;
            img.hidden = false;
            fallback.hidden = true;
          } else {
            img.hidden = true;
            fallback.hidden = false;
            fallback.textContent = (name || '?').slice(0, 1).toUpperCase();
          }
          PF('avatarRemoveBtn').hidden = !hasAvatar;
        }
    
        function fillProfileForm(data) {
          const p = data.profile || {};
          const socials = p.socials || {};
          myMemberId = data.member.memberId;
          PF('pf-company').value = p.company || '';
          PF('pf-role').value = p.role || '';
          PF('pf-location').value = p.location || '';
          PF('pf-phone').value = data.member.phone || '';
          PF('pf-bio').value = p.bio || '';
          PF('pf-website').value = socials.website || '';
          PF('pf-linkedin').value = socials.linkedin || '';
          PF('pf-facebook').value = socials.facebook || '';
          PF('pf-x').value = socials.x || '';
          PF('pf-expertise').value = (p.expertise || []).join(', ');
          VIS_KEYS.forEach(k => { PF('vis-' + k).checked = !!(data.visibility || {})[k]; });
          paintAvatar(!!p.avatar, data.member.firstName);
        }
    
        async function saveProfile() {
          const btn = PF('saveProfileBtn');
          btn.disabled = true;
          PF('profileStatus').textContent = 'Saving…';
          try {
            await NSPA.api('/api/profile', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                profile: {
                  company: PF('pf-company').value,
                  role: PF('pf-role').value,
                  location: PF('pf-location').value,
                  bio: PF('pf-bio').value,
                  socials: {
                    website: PF('pf-website').value,
                    linkedin: PF('pf-linkedin').value,
                    facebook: PF('pf-facebook').value,
                    x: PF('pf-x').value,
                  },
                  expertise: PF('pf-expertise').value.split(',').map(s => s.trim()).filter(Boolean),
                },
                phone: PF('pf-phone').value,
                visibility: Object.fromEntries(VIS_KEYS.map(k => [k, PF('vis-' + k).checked])),
              }),
            });
            PF('profileStatus').textContent = 'Saved';
            showToast('Profile saved.', 'success');
            setTimeout(() => { PF('profileStatus').textContent = ''; }, 2500);
          } catch (e) {
            PF('profileStatus').textContent = '';
            showToast(e.message, 'error');
          } finally {
            btn.disabled = false;
          }
        }
    
        async function uploadAvatar(file) {
          const fd = new FormData();
          fd.append('avatar', file, file.name);
          try {
            await NSPA.api('/api/profile/avatar', { method: 'POST', body: fd });
            paintAvatar(true, '');
            showToast('Profile picture updated.', 'success');
          } catch (e) {
            showToast(e.message, 'error');
          }
        }
    
        PF('saveProfileBtn').addEventListener('click', saveProfile);
        PF('avatarChooseBtn').addEventListener('click', () => PF('avatarInput').click());
        PF('avatarInput').addEventListener('change', () => {
          const file = PF('avatarInput').files[0];
          if (!file) return;
          if (file.size > 2 * 1024 * 1024) return showToast('Profile pictures must be 2 MB or smaller.', 'error');
          uploadAvatar(file);
          PF('avatarInput').value = '';
        });
        PF('avatarRemoveBtn').addEventListener('click', async () => {
          try {
            await NSPA.api('/api/profile/avatar', { method: 'DELETE' });
            paintAvatar(false, PF('pf-company').value || '?');
            showToast('Profile picture removed.', 'success');
          } catch (e) { showToast(e.message, 'error'); }
        });
    
        /* ── My Claims ──────────────────────────────────────────────────────── */
    
        const URGENCY_LABEL = {
          expired: 'Expired',
          critical: 'Expires soon',
          warning: 'Watch',
          ok: 'Good standing',
          unknown: 'Not yet checked',
        };
    
        // NovaROC status codes members won't recognise on sight.
        const TENURE_STATUS_LABEL = {
          GOOD_STAND: 'Good standing',
          APPL_RNWL: 'Renewal applied for',
          PEND_EXPIRY: 'Pending expiry',
          EXPIRED: 'Expired',
          TERMINATED: 'Terminated',
          CANCELLED: 'Cancelled',
        };
    
        const countdown = days => {
          if (days == null) return '—';
          if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`;
          if (days === 0) return 'today';
          return `in ${days} day${days === 1 ? '' : 's'}`;
        };
    
        function claimRow(c) {
          const status = TENURE_STATUS_LABEL[c.status] || c.status || 'Unknown';
          // The anniversary only earns its own line when it differs from expiry.
          const annivRow = c.anniversary && c.anniversary !== c.expiry
            ? `<div><span class="dash-key">Anniversary</span><span class="dash-val">${esc(c.anniversary)} · ${esc(countdown(c.anniversaryDays))}</span></div>`
            : '';
    
          return `
            <article class="claim-card claim-${esc(c.urgency)}">
              <div class="claim-card-head">
                <span class="claim-number mono">${esc(c.tenureNumber)}</span>
                <span class="claim-urgency">${esc(URGENCY_LABEL[c.urgency] || '')}</span>
              </div>
              <div class="claim-facts">
                <div><span class="dash-key">Status</span><span class="dash-val">${esc(status)}</span></div>
                <div><span class="dash-key">Expires</span><span class="dash-val">${esc(c.expiry || '—')} · ${esc(countdown(c.expiryDays))}</span></div>
                ${annivRow}
                ${c.areaHa != null ? `<div><span class="dash-key">Area</span><span class="dash-val">${esc(c.areaHa)} ha</span></div>` : ''}
                ${c.projectTitle ? `<div><span class="dash-key">Project</span><span class="dash-val"><a href="/project.html?id=${encodeURIComponent(c.projectId)}">${esc(c.projectTitle)}</a></span></div>` : ''}
              </div>
              ${c.missing ? '<p class="claim-missing">NovaROC no longer returns this tenure — it may have lapsed or been re-numbered.</p>' : ''}
              ${neighbourBlock(c)}
            </article>`;
        }
    
        // Who holds the ground next door. Fellow NSPA members are named and linked;
        // everyone else stays an anonymous tenure number, which is all NovaROC
        // gives us publicly.
        function neighbourBlock(c) {
          const list = c.neighbours || [];
          if (!list.length) return '';
          const members = list.filter(n => n.memberId);
          const others = list.filter(n => !n.memberId);
    
          const chip = n => n.memberId
            ? `<a class="neighbour-chip is-member" href="/member.html?id=${encodeURIComponent(n.memberId)}"
                  title="${esc(n.memberName)} · tenure ${esc(n.tenureNumber)}">
                 <span class="mono">${esc(n.tenureNumber)}</span> ${esc(n.memberName)}
               </a>`
            : `<span class="neighbour-chip" title="Tenure ${esc(n.tenureNumber)}${n.expiry ? ' · expires ' + esc(n.expiry) : ''}">
                 <span class="mono">${esc(n.tenureNumber)}</span>
               </span>`;
    
          return `
            <details class="claim-neighbours">
              <summary>
                Adjacent ground · ${list.length} tenure${list.length === 1 ? '' : 's'}
                ${members.length ? `<span class="neighbour-member-count">${members.length} NSPA member${members.length === 1 ? '' : 's'}</span>` : ''}
              </summary>
              <div class="neighbour-chips">
                ${members.map(chip).join('')}${others.map(chip).join('')}
              </div>
            </details>`;
        }
    
        function renderClaims(data) {
          const body = document.getElementById('claimsBody');
          const openBody = document.getElementById('openGroundBody');
          const checked = document.getElementById('claimsChecked');
    
          checked.textContent = data.lastChecked
            ? `Checked ${fmtDateTime(data.lastChecked)}`
            : 'Not checked yet';
    
          body.innerHTML = data.claims.length
            ? `<div class="claim-grid">${data.claims.map(claimRow).join('')}</div>`
            : `<p class="form-hint">No tenures registered yet. Claims are picked up automatically from the
                 tenure numbers on your submitted projects.</p>`;
    
          // Open-ground alerts are a separate story from your own holdings.
          const openGround = (data.alerts || []).filter(a => a.kind === 'open_ground');
          openBody.innerHTML = openGround.length
            ? `<p class="section-label small">Ground That May Open Nearby</p>
               <p class="form-hint" style="margin:0 0 12px;">
                 Tenures next to ground you hold that are expiring within ${data.openGroundWindowDays} days.
                 If they lapse, the ground becomes available for staking.
               </p>
               <div class="open-ground-list">
                 ${openGround.map(a => `
                   <div class="open-ground-row">
                     <span class="mono">${esc(a.tenureNumber)}</span>
                     <span class="open-ground-date">expires ${esc(a.dueDate || 'unknown')}</span>
                     <a class="open-ground-link"
                        href="https://novaroc.novascotia.ca/novaroc/page/viewer/mineralSearch/searchForm.jsf"
                        target="_blank" rel="noopener noreferrer">Check in NovaROC<span class="sr-only"> (opens in a new tab)</span></a>
                   </div>`).join('')}
               </div>`
            : '';
    
          renderClaimAlerts(data.opportunityAlerts || [], data.opportunityMatches || []);
        }
    
        function renderClaimAlerts(alerts, matches) {
          const target = document.getElementById('claimAlertsBody');
          const statusOptions = [
            ['PEND_EXPIRY', 'Pending expiry'],
            ['EXPIRED', 'Expired'],
            ['TERMINATED', 'Terminated'],
            ['CANCELLED', 'Cancelled'],
            ['PEND_CANCEL', 'Pending cancel'],
          ];
          const alertCard = a => {
            const c = a.criteria || {};
            const statuses = (c.statuses || []).map(s => TENURE_STATUS_LABEL[s] || s).join(', ') || 'Any open-ground status';
            const range = [
              c.maxExpiryDays != null ? `within ${c.maxExpiryDays} days` : '',
              c.minAreaHa != null ? `min ${c.minAreaHa} ha` : '',
              c.maxAreaHa != null ? `max ${c.maxAreaHa} ha` : '',
              c.tenureText ? `contains ${c.tenureText}` : '',
            ].filter(Boolean).join(' · ');
            return `
              <article class="claim-alert-card ${a.paused ? 'is-paused' : 'is-active'}">
                <div class="claim-alert-card-main">
                  <div class="claim-alert-title-row">
                    <strong>${esc(a.name)}</strong>
                    <span class="claim-alert-state">${a.paused ? 'Paused' : 'Active'}</span>
                  </div>
                  <p>${esc(statuses)}${range ? ` · ${esc(range)}` : ''}</p>
                  <span class="claim-alert-channel">${esc(a.channel || 'both')}</span>
                </div>
                <div class="claim-alert-actions">
                  <button type="button" class="secondary-btn claim-alert-toggle" data-id="${esc(a.id)}" data-paused="${a.paused ? '0' : '1'}">${a.paused ? 'Resume' : 'Pause'}</button>
                  <button type="button" class="text-danger-btn claim-alert-delete" data-id="${esc(a.id)}">Delete</button>
                </div>
              </article>`;
          };
          const matchRows = matches.slice(0, 5).map(m => `
            <div class="claim-match-row">
              <span class="mono">${esc(m.tenureNumber)}</span>
              <span>${esc((m.detail || {}).alertName || 'Opportunity alert')}</span>
              <span>${esc((m.detail || {}).expiry ? `expires ${(m.detail || {}).expiry}` : 'date unknown')}</span>
            </div>`).join('');
          target.innerHTML = `
            <section class="claim-alert-panel">
              <div class="claim-alert-head">
                <div>
                  <p class="section-label small">Claim Opportunity Alerts</p>
                  <h2>Watch ground before it opens</h2>
                </div>
                <span>${alerts.filter(a => !a.paused).length} active</span>
              </div>
              <div class="claim-alert-layout">
                <form id="claimAlertForm" class="claim-alert-form">
                  <div class="field">
                    <label for="caName">Alert name</label>
                    <input id="caName" name="name" maxlength="80" placeholder="Gold Belt open ground" />
                  </div>
                  <div class="claim-alert-fields">
                    <div class="field">
                      <label for="caMaxDays">Expiry window</label>
                      <input id="caMaxDays" name="maxExpiryDays" type="number" min="0" max="365" value="90" />
                    </div>
                    <div class="field">
                      <label for="caChannel">Notify by</label>
                      <select id="caChannel" name="channel">
                        <option value="both">In-app and email</option>
                        <option value="inapp">In-app only</option>
                        <option value="email">Email only</option>
                      </select>
                    </div>
                    <div class="field">
                      <label for="caMinArea">Min area ha</label>
                      <input id="caMinArea" name="minAreaHa" type="number" min="0" step="0.1" />
                    </div>
                    <div class="field">
                      <label for="caMaxArea">Max area ha</label>
                      <input id="caMaxArea" name="maxAreaHa" type="number" min="0" step="0.1" />
                    </div>
                    <div class="field full">
                      <label for="caTenureText">Tenure number contains</label>
                      <input id="caTenureText" name="tenureText" maxlength="80" placeholder="Optional" />
                    </div>
                  </div>
                  <fieldset class="claim-status-picker">
                    <legend>Matching status</legend>
                    ${statusOptions.map(([value, label]) => `
                      <label><input type="checkbox" name="statuses" value="${esc(value)}" /> <span>${esc(label)}</span></label>
                    `).join('')}
                  </fieldset>
                  <button type="submit" class="submit-btn">Save Alert</button>
                </form>
                <div class="claim-alert-side">
                  <div class="claim-alert-list" id="claimAlertList">
                    ${alerts.length ? alerts.map(alertCard).join('') : '<p class="claim-alert-empty">No opportunity alerts saved yet.</p>'}
                  </div>
                  ${matchRows ? `<div class="claim-match-box"><p class="section-label small">Recent Matches</p>${matchRows}</div>` : ''}
                </div>
              </div>
            </section>`;
    
          document.getElementById('claimAlertForm').addEventListener('submit', saveClaimAlert);
          target.querySelectorAll('.claim-alert-toggle').forEach(btn => {
            btn.addEventListener('click', () => updateClaimAlertPause(btn, alerts));
          });
          target.querySelectorAll('.claim-alert-delete').forEach(btn => {
            btn.addEventListener('click', () => deleteClaimAlert(btn.dataset.id));
          });
        }
    
        async function saveClaimAlert(ev) {
          ev.preventDefault();
          const form = ev.currentTarget;
          const statuses = [...form.querySelectorAll('input[name="statuses"]:checked')].map(el => el.value);
          const payload = {
            name: form.elements.name.value,
            channel: form.elements.channel.value,
            criteria: {
              statuses,
              maxExpiryDays: form.elements.maxExpiryDays.value,
              minAreaHa: form.elements.minAreaHa.value,
              maxAreaHa: form.elements.maxAreaHa.value,
              tenureText: form.elements.tenureText.value,
            },
          };
          try {
            await api('/api/claim-alerts', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            showToast('Opportunity alert saved.', 'success');
            form.reset();
            loadClaims();
          } catch (e) {
            showToast(e.message, 'error');
          }
        }
    
        async function updateClaimAlertPause(btn, alerts) {
          const alert = alerts.find(a => String(a.id) === String(btn.dataset.id));
          if (!alert) return;
          try {
            await api(`/api/claim-alerts/${encodeURIComponent(alert.id)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...alert, paused: btn.dataset.paused === '1' }),
            });
            showToast(btn.dataset.paused === '1' ? 'Alert paused.' : 'Alert resumed.', 'success');
            loadClaims();
          } catch (e) {
            showToast(e.message, 'error');
          }
        }
    
        async function deleteClaimAlert(id) {
          if (!confirm('Delete this opportunity alert?')) return;
          try {
            await api(`/api/claim-alerts/${encodeURIComponent(id)}`, { method: 'DELETE' });
            showToast('Alert deleted.', 'success');
            loadClaims();
          } catch (e) {
            showToast(e.message, 'error');
          }
        }
    
        async function loadClaims() {
          try {
            renderClaims(await api('/api/claims'));
          } catch (e) {
            document.getElementById('claimsBody').innerHTML =
              `<p class="form-hint">Could not load your claims. ${esc(e.message)}</p>`;
          }
        }
    
        async function loadProfile() {
          try {
            fillProfileForm(await NSPA.api('/api/profile'));
          } catch {
            document.getElementById('profileSection').innerHTML =
              '<p class="section-label">My Profile</p><p class="form-hint">Could not load your profile.</p>';
          }
        }
        loadProfile();
    
        function membershipBadge(m) {
          if (m.isMember) return '<span class="status-badge status-approved">Active member</span>';
          if (m.membershipStatus === 'inactive') return '<span class="status-badge status-pending">Membership lapsed</span>';
          return '<span class="status-badge status-none">Registered</span>';
        }
    
        function renderAccount(me) {
          const m = me.member;
          const expiry = m.isMember && m.membershipExpiry
            ? `<p class="dash-line">Membership valid through <strong>${fmtDate(m.membershipExpiry)}</strong>.</p>` : '';
          const joinBtn = m.isMember
            ? `<button type="button" class="secondary-btn" id="cancelMembershipBtn">Cancel Membership</button>`
            : `<a class="submit-btn" href="/membership.html">Become a Member</a>`;
    
          accountBody.innerHTML = `
            <p class="section-label">Account</p>
            <div class="dash-grid">
              <div><span class="dash-key">Name</span><span class="dash-val">${esc(m.firstName)} ${esc(m.lastName)}</span></div>
              <div><span class="dash-key">Member ID</span><span class="dash-val mono">${esc(m.memberId)}</span></div>
              <div><span class="dash-key">Email</span><span class="dash-val">${esc(m.email)}</span></div>
              <div><span class="dash-key">Membership</span><span class="dash-val">${membershipBadge(m)}</span></div>
            </div>
            ${expiry}
            <div class="dash-actions">
              ${joinBtn}
              <button type="button" class="text-danger-btn" id="deactivateBtn">Deactivate account</button>
            </div>`;
    
          const cancelBtn = document.getElementById('cancelMembershipBtn');
          if (cancelBtn) cancelBtn.addEventListener('click', cancelMembership);
          document.getElementById('deactivateBtn').addEventListener('click', deactivateAccount);
        }
    
        async function cancelMembership() {
          if (!confirm('Cancel your membership? You will keep your account and project history, but lose member access until you re-join.')) return;
          try {
            await api('/api/membership/cancel', { method: 'POST' });
            showToast('Membership cancelled.', 'success');
            setTimeout(() => { window.location.href = '/membership.html'; }, 800);
          } catch (e) { showToast(e.message, 'error'); }
        }
    
        async function deactivateAccount() {
          if (!confirm('Deactivate your account? Your member ID is reserved and your projects are kept — you can restore everything by signing up again with the same email.')) return;
          try {
            await api('/api/account/deactivate', { method: 'POST' });
            const me = await api('/api/me').catch(() => ({}));
            window.location.href = me.wixMemberLoginUrl || '/signup.html';
          } catch (e) { showToast(e.message, 'error'); }
        }
    
        function statusBadge(status) {
          const s = String(status || 'Pending');
          const cls = s.toLowerCase();
          return `<span class="status-badge status-${esc(cls)}">${esc(s)}</span>`;
        }
    
        const fmtSize = bytes => {
          const n = Number(bytes) || 0;
          if (n < 1024) return `${n} B`;
          if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
          return `${(n / (1024 * 1024)).toFixed(1)} MB`;
        };
    
        function documentsBlock(p) {
          const docs = p.documents || [];
          if (!docs.length) return '';
          return `
            <div class="doc-list">
              <p class="doc-list-label">Documents</p>
              ${docs.map(d => `
                <div class="doc-item">
                  <a class="doc-download" href="/api/projects/${encodeURIComponent(p.id)}/documents/${encodeURIComponent(d.id)}/download" download>${esc(d.title || d.fileName)}</a>
                  <span class="doc-item-meta">${esc(d.fileName)} · ${fmtSize(d.size)}</span>
                  <button type="button" class="text-danger-btn doc-delete-btn" data-project="${esc(p.id)}" data-doc="${esc(d.id)}" data-name="${esc(d.title || d.fileName)}">Remove</button>
                </div>`).join('')}
            </div>`;
        }
    
        /* ── Review outcome ───────────────────────────────────────────────────
           When reviewers send a project back, the member needs to see why, who
           said it, and be able to act on it without leaving the dashboard. */
    
        // Submitted → Under Review → Rejected → Resubmitted, with the stages that
        // actually happened marked done and the current one highlighted.
        const REVIEW_STAGES = ['Submitted', 'Under Review', 'Rejected', 'Resubmitted'];
    
        function reviewTimeline(p) {
          const seen = new Set(['Submitted']);
          for (const entry of p.timeline || []) {
            const m = /Status changed to ([A-Za-z ]+)/.exec(entry.summary || '');
            if (m) seen.add(m[1].trim());
            if (entry.type === 'project_approved') seen.add('Approved');
            if (entry.type === 'project_resubmitted') seen.add('Resubmitted');
          }
          seen.add(p.status);
    
          const stages = REVIEW_STAGES.filter(s => seen.has(s) || s === 'Submitted' || s === 'Under Review');
          return `
            <ol class="review-track" aria-label="Review progress">
              ${stages.map(stage => {
                const reached = seen.has(stage);
                const current = stage === p.status;
                const cls = current ? 'current' : reached ? 'done' : 'todo';
                return `<li class="review-step ${cls}">
                  <span class="review-dot" aria-hidden="true"></span>
                  <span class="review-step-label">${esc(stage)}</span>
                  ${current ? '<span class="sr-only">(current stage)</span>' : ''}
                </li>`;
              }).join('')}
            </ol>`;
        }
    
        function reviewBlock(p) {
          const needsAttention = ['Rejected', 'Revisions Requested'].includes(p.status);
          if (!needsAttention && !p.reviewNote) return '';
    
          const heading = p.status === 'Rejected' ? 'Why this was rejected' : 'Changes requested';
          const byLine = [
            p.reviewedBy ? `Reviewed by ${esc(p.reviewedBy)}` : '',
            p.reviewedAt ? esc(fmtDate(p.reviewedAt)) : '',
          ].filter(Boolean).join(' · ');
    
          return `
            <div class="review-callout ${p.status === 'Rejected' ? 'rejected' : 'revisions'}">
              <p class="review-callout-title">${esc(heading)}</p>
              ${p.reviewNote
                ? `<p class="review-callout-note">${esc(p.reviewNote)}</p>`
                : '<p class="review-callout-note muted">No reason was recorded. Contact the NSPA team for details.</p>'}
              ${byLine ? `<p class="review-callout-by">${byLine}</p>` : ''}
              ${p.canResubmit
                ? `<button type="button" class="submit-btn resubmit-open-btn" data-id="${esc(p.id)}">Edit &amp; Resubmit</button>`
                : ''}
            </div>`;
        }
    
        function resubmitForm(p) {
          if (!p.canResubmit) return '';
          return `
            <form class="resubmit-form" data-id="${esc(p.id)}" hidden>
              <p class="section-label small">Update your project</p>
              <div class="grid-2">
                <div class="field">
                  <label for="rs-title-${esc(p.id)}">Project name</label>
                  <input type="text" id="rs-title-${esc(p.id)}" name="project" value="${esc(p.title || '')}" />
                </div>
                <div class="field">
                  <label for="rs-operator-${esc(p.id)}">Operator</label>
                  <input type="text" id="rs-operator-${esc(p.id)}" name="operator" value="${esc(p.operator || '')}" />
                </div>
                <div class="field full">
                  <label for="rs-desc-${esc(p.id)}">Description</label>
                  <textarea id="rs-desc-${esc(p.id)}" name="description">${esc(p.description || '')}</textarea>
                </div>
                <div class="field full">
                  <label for="rs-estimate-${esc(p.id)}">Resource estimate</label>
                  <textarea id="rs-estimate-${esc(p.id)}" name="resourceEstimate">${esc(p.resourceEstimate || '')}</textarea>
                </div>
                <div class="field">
                  <label for="rs-source-${esc(p.id)}">Resource source</label>
                  <input type="text" id="rs-source-${esc(p.id)}" name="resourceSource" value="${esc(p.resourceSource || '')}" />
                </div>
                <div class="field">
                  <label for="rs-website-${esc(p.id)}">Website</label>
                  <input type="text" id="rs-website-${esc(p.id)}" name="website" value="${esc(p.website || '')}" />
                </div>
              </div>
              <div class="dash-actions">
                <button type="submit" class="submit-btn">Resubmit for Review</button>
                <button type="button" class="secondary-btn resubmit-cancel-btn">Cancel</button>
              </div>
              <p class="form-hint">Tenure numbers and documents are unchanged. To edit those, use the project form.</p>
            </form>`;
        }
    
        function projectDetail(p) {
          const rows = [
            ['Operator', p.operator],
            ['Tenure numbers', p.tenures],
            ['Commodities', p.commodities],
            ['Deposit types', p.depositTypes],
            ['Project stage', p.projectStage],
            ['Resource estimate', p.resourceEstimate],
            ['Resource source', p.resourceSource],
            ['Website', p.website],
          ].filter(([, v]) => v);
          const detailRows = rows.map(([k, v]) =>
            `<div class="dash-detail-row"><span class="dash-key">${esc(k)}</span><span class="dash-val">${esc(v)}</span></div>`).join('');
          const body = reviewTimeline(p) + reviewBlock(p) + resubmitForm(p) + detailRows + documentsBlock(p);
          return `<div class="project-detail">${body ||
            '<p class="form-hint">No further details recorded.</p>'}</div>`;
        }
    
        function renderProjects(projects) {
          if (!projects.length) {
            projectsBody.innerHTML = `<p class="membership-lead">You haven't submitted any projects yet.</p>
              <a class="submit-btn" href="/index.html">Submit your first project</a>`;
            return;
          }
          projectsBody.innerHTML = projects.map(p => `
            <div class="project-item">
              <button type="button" class="project-row" data-id="${esc(p.id)}">
                <span class="project-main">
                  <span class="project-title">${esc(p.title) || 'Untitled project'}</span>
                  <span class="project-date">Submitted ${fmtDate(p.createdAt)} · ${esc(p.id)}</span>
                </span>
                ${statusBadge(p.status)}
              </button>
              ${projectDetail(p)}
            </div>`).join('');
    
          projectsBody.querySelectorAll('.project-row').forEach(row => {
            row.addEventListener('click', () => row.closest('.project-item').classList.toggle('open'));
          });
    
          projectsBody.querySelectorAll('.doc-delete-btn').forEach(btn => {
            btn.addEventListener('click', () => removeDocument(btn));
          });
    
          // Open / close the resubmit form
          projectsBody.querySelectorAll('.resubmit-open-btn').forEach(btn => {
            btn.addEventListener('click', () => {
              const form = projectsBody.querySelector(`.resubmit-form[data-id="${CSS.escape(btn.dataset.id)}"]`);
              if (!form) return;
              form.hidden = false;
              btn.hidden = true;
              form.querySelector('input, textarea')?.focus();
            });
          });
          projectsBody.querySelectorAll('.resubmit-cancel-btn').forEach(btn => {
            btn.addEventListener('click', () => {
              const form = btn.closest('.resubmit-form');
              form.hidden = true;
              const open = projectsBody.querySelector(`.resubmit-open-btn[data-id="${CSS.escape(form.dataset.id)}"]`);
              if (open) { open.hidden = false; open.focus(); }
            });
          });
          projectsBody.querySelectorAll('.resubmit-form').forEach(form => {
            form.addEventListener('submit', ev => resubmitProject(ev, form));
          });
        }
    
        async function resubmitProject(ev, form) {
          ev.preventDefault();
          const submitBtn = form.querySelector('button[type=submit]');
          submitBtn.disabled = true;
          submitBtn.textContent = 'Resubmitting…';
          try {
            const payload = { resubmit: true };
            form.querySelectorAll('[name]').forEach(el => { payload[el.name] = el.value; });
            await api(`/api/projects/${encodeURIComponent(form.dataset.id)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            showToast('Project resubmitted for review.', 'success');
            const { projects } = await api('/api/my/projects');
            renderProjects(projects);
          } catch (e) {
            showToast(e.message, 'error');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Resubmit for Review';
          }
        }
    
        async function removeDocument(btn) {
          if (!confirm(`Remove "${btn.dataset.name}" from this project? The file will be deleted.`)) return;
          btn.disabled = true;
          try {
            await api(`/api/projects/${encodeURIComponent(btn.dataset.project)}/documents/${encodeURIComponent(btn.dataset.doc)}`, { method: 'DELETE' });
            showToast('Document removed.', 'success');
            const { projects } = await api('/api/my/projects');
            const openIds = new Set([...projectsBody.querySelectorAll('.project-item.open .project-row')].map(r => r.dataset.id));
            renderProjects(projects);
            projectsBody.querySelectorAll('.project-row').forEach(row => {
              if (openIds.has(row.dataset.id)) row.closest('.project-item').classList.add('open');
            });
          } catch (e) {
            btn.disabled = false;
            showToast(e.message, 'error');
          }
        }
    
        async function load() {
          try {
            const me = await api('/api/me');
            if (!me.authenticated) { window.location.href = me.wixMemberLoginUrl || '/signup.html'; return; }
            renderAccount(me);
          } catch (e) {
            accountBody.innerHTML = '<p class="section-label">Account</p><p class="form-hint">Could not load your account.</p>';
          }
          try {
            const { projects } = await api('/api/my/projects');
            renderProjects(projects);
          } catch (e) {
            projectsBody.innerHTML = '<p class="form-hint">Could not load your projects.</p>';
          }
        }
    
        load();
  })();
}

/* member */
if (location.pathname === '/member.html') {
  (() => {
    (async function () {
        const { esc, api, fmtDate } = NSPA;
        const body = document.getElementById('memberBody');
        const main = document.getElementById('main');
        const memberId = new URLSearchParams(location.search).get('id');
    
        if (!memberId) {
          body.innerHTML = '<p class="membership-lead">No member specified.</p>';
          main.setAttribute('aria-busy', 'false');
          return;
        }
    
        let member;
        try {
          ({ member } = await api(`/api/network/members/${encodeURIComponent(memberId)}`));
        } catch (e) {
          body.innerHTML = `<p class="membership-lead">${esc(e.message)}</p>
            <p class="form-hint">They may have left the directory, or their membership may have lapsed.</p>`;
          main.setAttribute('aria-busy', 'false');
          return;
        }
    
        const name = `${member.firstName || ''} ${member.lastName || ''}`.trim() || 'NSPA Member';
        document.title = `${name} · NSPA`;
        const p = member.profile || {};
        const socials = p.socials || {};
    
        const avatar = p.hasAvatar
          ? `<img class="member-profile-avatar" src="/api/members/${encodeURIComponent(member.memberId)}/avatar" alt="" />`
          : `<span class="member-profile-avatar initial" aria-hidden="true">${esc(name.slice(0, 1).toUpperCase())}</span>`;
    
        const phoneHref = String(member.phone || '').replace(/[^\d+]/g, '');
        const contactSubject = encodeURIComponent(`NSPA member connection with ${name}`);
    
        const facts = [
          ['Company', p.company && esc(p.company)],
          ['Role', p.role && esc(p.role)],
          ['Location', p.location && esc(p.location)],
          ['Member ID', `<span class="mono">${esc(member.memberId)}</span>`],
          ['Member since', member.memberSince ? esc(fmtDate(member.memberSince)) : ''],
          ['Email', member.email
            ? `<a href="mailto:${esc(member.email)}?subject=${contactSubject}">${esc(member.email)}</a>` : ''],
          ['Phone', member.phone ? `<a href="tel:${esc(phoneHref)}">${esc(member.phone)}</a>` : ''],
        ].filter(([, v]) => v);
    
        const SOCIAL_LABELS = { website: 'Website', linkedin: 'LinkedIn', facebook: 'Facebook', x: 'X' };
        const socialLinks = Object.entries(SOCIAL_LABELS)
          .filter(([key]) => socials[key])
          .map(([key, label]) =>
            `<a href="${esc(socials[key])}" target="_blank" rel="noopener noreferrer">${esc(label)}<span class="sr-only"> (opens in a new tab)</span></a>`)
          .join('');
    
        const tags = list => (list || []).length
          ? `<div class="network-tags">${list.map(v => `<span>${esc(v)}</span>`).join('')}</div>`
          : '<p class="form-hint">Not listed.</p>';
    
        const projectRows = (member.projects || []).map(project => `
          <a class="member-project-row" href="/project.html?id=${encodeURIComponent(project.id)}">
            <span class="member-project-main">
              <span class="member-project-title">${esc(project.title || 'Untitled project')}</span>
              <span class="member-project-meta">${esc([project.operator, project.projectStage].filter(Boolean).join(' · '))}</span>
            </span>
            <span class="status-badge status-${esc(String(project.status || 'pending').toLowerCase().replace(/[^a-z]+/g, '-'))}">${esc(project.status || 'Pending')}</span>
          </a>`).join('');
    
        body.innerHTML = `
          <header class="page-header">
            <div class="member-profile-head">
              ${avatar}
              <div>
                <p class="eyebrow">Member Profile</p>
                <h1>${esc(name)}</h1>
                ${p.role || p.company
                  ? `<p class="subtitle">${esc([p.role, p.company].filter(Boolean).join(' · '))}</p>` : ''}
              </div>
            </div>
            ${socialLinks ? `<div class="member-socials">${socialLinks}</div>` : ''}
          </header>
    
          ${p.bio ? `
          <div class="stack-card">
            <div class="form-section">
              <p class="section-label">About</p>
              <p class="member-profile-bio">${esc(p.bio)}</p>
            </div>
          </div>` : ''}
    
          <div class="stack-card">
            <div class="form-section">
              <p class="section-label">Details</p>
              <dl class="project-facts">
                ${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}
              </dl>
            </div>
          </div>
    
          ${(p.expertise || []).length ? `
          <div class="stack-card">
            <div class="form-section">
              <p class="section-label">Areas of Expertise</p>
              ${tags(p.expertise)}
            </div>
          </div>` : ''}
    
          <div class="stack-card">
            <div class="form-section">
              <p class="section-label">Projects</p>
              ${projectRows || '<p class="form-hint">No projects shared.</p>'}
            </div>
          </div>
    
          ${(member.commodities || []).length || (member.tenureNumbers || []).length ? `
          <div class="stack-card">
            <div class="form-section">
              <p class="section-label">Interests</p>
              <div class="member-interest-grid">
                <div>
                  <span class="dash-key">Commodities &amp; deposit types</span>
                  ${tags([...(member.commodities || []), ...(member.depositTypes || [])])}
                </div>
                <div>
                  <span class="dash-key">Tenure numbers</span>
                  ${tags(member.tenureNumbers)}
                </div>
              </div>
            </div>
          </div>` : ''}`;
    
        main.setAttribute('aria-busy', 'false');
      })();
  })();
}

/* network */
if (location.pathname === '/network.html') {
  (() => {
    const { esc, api, showToast } = NSPA;
        const body = document.getElementById('networkBody');
        const count = document.getElementById('memberCount');
        const joinBody = document.getElementById('networkJoinBody');
        const search = document.getElementById('networkSearch');
        const commodityFilter = document.getElementById('commodityFilter');
        const projectFilter = document.getElementById('projectFilter');
        const tenureFilter = document.getElementById('tenureFilter');
        const depositFilter = document.getElementById('depositFilter');
        let members = [];
        let joined = false;
    
        const normalizeFilter = value => String(value || '').trim().toLowerCase();
    
        function uniqueSorted(values) {
          return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
        }
    
        function setSelectOptions(select, values, allLabel) {
          const current = select.value;
          const options = uniqueSorted(values);
          select.innerHTML = `<option value="">${esc(allLabel)}</option>` +
            options.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join('');
          if (options.includes(current)) select.value = current;
        }
    
        function renderFilters() {
          setSelectOptions(commodityFilter, members.flatMap(member => [
            ...(member.commodities || []),
            ...(member.projects || []).flatMap(project => project.commodities || []),
          ]), 'All commodities');
          setSelectOptions(projectFilter, members.flatMap(member =>
            (member.projects || []).map(project => project.title)
          ), 'All projects');
          setSelectOptions(tenureFilter, members.flatMap(member => [
            ...(member.tenureNumbers || []),
            ...(member.projects || []).flatMap(project => project.tenures || []),
          ]), 'All tenures');
          setSelectOptions(depositFilter, members.flatMap(member => [
            ...(member.depositTypes || []),
            ...(member.projects || []).flatMap(project => project.depositTypes || []),
          ]), 'All deposit types');
        }
    
        /* Compact directory card: identity, role/company/location, a short bio,
           and a View Profile button. Everything else lives on the profile page. */
        function renderMember(member) {
          const name = `${member.firstName || ''} ${member.lastName || ''}`.trim() || 'NSPA Member';
          const p = member.profile || {};
          const roleLine = [p.role, p.company].filter(Boolean).join(' · ');
          const avatar = p.hasAvatar
            ? `<img class="member-card-avatar" src="/api/members/${encodeURIComponent(member.memberId)}/avatar"
                   alt="" loading="lazy" />`
            : `<span class="member-card-avatar member-card-initial" aria-hidden="true">${esc(name.slice(0, 1).toUpperCase())}</span>`;
    
          return `
            <article class="member-card">
              ${avatar}
              <div class="member-card-body">
                <h2>${esc(name)}
                  ${member.isCurrentUser ? '<span class="status-badge status-submitted">You</span>' : ''}
                </h2>
                ${roleLine ? `<p class="member-card-role">${esc(roleLine)}</p>` : ''}
                ${p.location ? `<p class="member-card-location">${esc(p.location)}</p>` : ''}
                ${p.bio ? `<p class="member-card-bio">${esc(p.bio)}</p>` : ''}
              </div>
              <a class="secondary-btn member-card-view" href="/member.html?id=${encodeURIComponent(member.memberId)}">
                View Profile
              </a>
            </article>`;
        }
    
        function matches(member, term) {
          if (!term) return true;
          const p = member.profile || {};
          return [
            member.memberId, member.firstName, member.lastName, member.email, member.phone,
            p.company, p.role, p.location, p.bio, ...(p.expertise || []),
            ...(member.tenureNumbers || []),
            ...(member.commodities || []),
            ...(member.depositTypes || []),
            ...(member.projects || []).flatMap(project => [
              project.title, project.operator, ...(project.tenures || []),
              ...(project.commodities || []), ...(project.depositTypes || []),
            ]),
            `${member.firstName || ''} ${member.lastName || ''}`,
          ].some(value => String(value || '').toLowerCase().includes(term));
        }
    
        function hasSelectedValue(values, selected) {
          if (!selected) return true;
          const selectedNorm = normalizeFilter(selected);
          return values.some(value => normalizeFilter(value) === selectedNorm);
        }
    
        function matchesFilters(member) {
          return (
            hasSelectedValue([
              ...(member.commodities || []),
              ...(member.projects || []).flatMap(project => project.commodities || []),
            ], commodityFilter.value) &&
            hasSelectedValue((member.projects || []).map(project => project.title), projectFilter.value) &&
            hasSelectedValue([
              ...(member.tenureNumbers || []),
              ...(member.projects || []).flatMap(project => project.tenures || []),
            ], tenureFilter.value) &&
            hasSelectedValue([
              ...(member.depositTypes || []),
              ...(member.projects || []).flatMap(project => project.depositTypes || []),
            ], depositFilter.value)
          );
        }
    
        /* Joining/leaving happens here; editing what you share happens in the
           dashboard, alongside the rest of your profile. */
        function renderJoinPanel() {
          if (joined) {
            joinBody.innerHTML = `
              <p class="section-label">Your Network Profile</p>
              <p class="membership-lead">You are listed in the member directory. Your card shows the profile you've set up in your dashboard.</p>
              <div class="network-actions">
                <a class="submit-btn" href="/dashboard.html">Edit Profile &amp; Visibility</a>
                <button type="button" class="secondary-btn" id="leaveNetworkBtn">Leave Network</button>
              </div>`;
            document.getElementById('leaveNetworkBtn').addEventListener('click', leaveNetwork);
            return;
          }
    
          joinBody.innerHTML = `
            <p class="section-label">Your Network Profile</p>
            <p class="membership-lead">Join the network to be listed for other active members. Your card uses the profile from your dashboard, and you control what's shared there.</p>
            <div class="network-actions">
              <button type="button" class="submit-btn" id="joinNetworkBtn">Join Network</button>
              <a class="secondary-btn" href="/dashboard.html">Set Up Profile First</a>
            </div>`;
          document.getElementById('joinNetworkBtn').addEventListener('click', joinNetwork);
        }
    
        function render() {
          const term = search.value.trim().toLowerCase();
          const filtered = members.filter(member => matches(member, term) && matchesFilters(member));
          renderJoinPanel();
          count.textContent = `${filtered.length} of ${members.length} member${members.length === 1 ? '' : 's'}`;
    
          if (!members.length) {
            body.innerHTML = '<p class="membership-lead">No members have joined the network yet.</p>';
            return;
          }
          if (!filtered.length) {
            body.innerHTML = '<p class="membership-lead">No members match that search.</p>';
            return;
          }
          body.innerHTML = filtered.map(renderMember).join('');
        }
    
        async function joinNetwork() {
          const btn = document.getElementById('joinNetworkBtn');
          btn.disabled = true;
          btn.textContent = 'Joining…';
          try {
            await api('/api/network/join', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            });
            showToast("You're now listed in the network.", 'success');
            await load();
          } catch (error) {
            showToast(error.message || 'Could not join the network.', 'error');
            btn.disabled = false;
            btn.textContent = 'Join Network';
          }
        }
    
        async function leaveNetwork() {
          const btn = document.getElementById('leaveNetworkBtn');
          btn.disabled = true;
          btn.textContent = 'Leaving…';
          try {
            await api('/api/network/leave', { method: 'POST' });
            showToast('You are no longer listed in the network.', 'success');
            await load();
          } catch (error) {
            showToast(error.message || 'Could not leave the network.', 'error');
            btn.disabled = false;
            btn.textContent = 'Leave Network';
          }
        }
    
        async function load() {
          try {
            const data = await api('/api/network/members');
            joined = !!data.joined;
            members = data.members || [];
            renderFilters();
            render();
          } catch (error) {
            count.textContent = 'Unavailable';
            joinBody.innerHTML = '<p class="section-label">Your Network Profile</p><p class="form-hint">Could not load your network status.</p>';
            body.innerHTML = '<p class="form-hint">Could not load the member network.</p>';
          }
        }
    
        search.addEventListener('input', NSPA.debounce(render, 150));
        [commodityFilter, projectFilter, tenureFilter, depositFilter].forEach(select => {
          select.addEventListener('change', render);
        });
        load();
  })();
}

/* notifications */
if (location.pathname === '/notifications.html') {
  (() => {
    const { esc, api, showToast, fmtRelative, notificationsChanged } = NSPA;
        const body = document.getElementById('notificationsBody');
        const pager = document.getElementById('pager');
        const loadMoreBtn = document.getElementById('loadMoreBtn');
        const readAllBtn = document.getElementById('readAllBtn');
        const unreadPill = document.getElementById('unreadPill');
    
        const PAGE_SIZE = 30;
        let offset = 0;
        let loaded = [];
        let total = 0;
    
        const TYPE_META = {
          project_approved:    { icon: '✓', cls: 'approved' },
          project_rejected:    { icon: '✕', cls: 'rejected' },
          revision_requested:  { icon: '!', cls: 'revision' },
          membership_expiring: { icon: '◷', cls: 'expiring' },
          membership_expired:  { icon: '◷', cls: 'expired' },
        };
    
        function row(n) {
          const meta = TYPE_META[n.type] || { icon: '•', cls: 'default' };
          const unread = !n.readAt;
          const action = n.link
            ? `<a class="notif-action" href="${esc(n.link)}">View</a>`
            : '';
          return `
            <li class="notif-item${unread ? ' unread' : ''}" data-id="${esc(n.id)}">
              <span class="notif-icon notif-${meta.cls}" aria-hidden="true">${meta.icon}</span>
              <div class="notif-main">
                <p class="notif-title">
                  ${unread ? '<span class="notif-dot" aria-label="Unread"></span>' : ''}
                  ${esc(n.title)}
                </p>
                ${n.body ? `<p class="notif-body">${esc(n.body)}</p>` : ''}
                <p class="notif-meta">
                  <time datetime="${esc(n.createdAt)}">${esc(fmtRelative(n.createdAt))}</time>
                  ${action}
                </p>
              </div>
              <div class="notif-actions">
                ${unread ? `<button type="button" class="secondary-btn notif-read-btn" data-id="${esc(n.id)}">Mark read</button>` : ''}
                <button type="button" class="text-danger-btn notif-delete-btn" data-id="${esc(n.id)}"
                        aria-label="Delete notification: ${esc(n.title)}">Delete</button>
              </div>
            </li>`;
        }
    
        function render() {
          const unread = loaded.filter(n => !n.readAt).length;
          unreadPill.textContent = `${unread} unread`;
          unreadPill.hidden = unread === 0;
          readAllBtn.hidden = unread === 0;
    
          if (!loaded.length) {
            body.innerHTML = '<p class="membership-lead">You have no notifications yet.</p>';
            pager.hidden = true;
            return;
          }
    
          body.innerHTML = `<ul class="notif-list">${loaded.map(row).join('')}</ul>`;
          pager.hidden = loaded.length >= total;
    
          body.querySelectorAll('.notif-read-btn').forEach(b =>
            b.addEventListener('click', () => markRead(b.dataset.id))
          );
          body.querySelectorAll('.notif-delete-btn').forEach(b =>
            b.addEventListener('click', () => remove(b.dataset.id))
          );
        }
    
        async function load() {
          loadMoreBtn.disabled = true;
          try {
            const data = await api(`/api/notifications?limit=${PAGE_SIZE}&offset=${offset}`);
            loaded = loaded.concat(data.items);
            offset += data.items.length;
            total = data.total;
            render();
          } catch (e) {
            body.innerHTML = `<p class="form-hint">Could not load notifications. ${esc(e.message)}</p>`;
          } finally {
            body.setAttribute('aria-busy', 'false');
            loadMoreBtn.disabled = false;
          }
        }
    
        async function markRead(id) {
          try {
            await api(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
            const item = loaded.find(n => String(n.id) === String(id));
            if (item) item.readAt = new Date().toISOString();
            render();
            notificationsChanged();
          } catch (e) { showToast(e.message, 'error'); }
        }
    
        async function remove(id) {
          try {
            await api(`/api/notifications/${encodeURIComponent(id)}`, { method: 'DELETE' });
            loaded = loaded.filter(n => String(n.id) !== String(id));
            total = Math.max(0, total - 1);
            offset = Math.max(0, offset - 1);
            render();
            notificationsChanged();
            showToast('Notification deleted.', 'success');
          } catch (e) { showToast(e.message, 'error'); }
        }
    
        readAllBtn.addEventListener('click', async () => {
          readAllBtn.disabled = true;
          try {
            await api('/api/notifications/read-all', { method: 'POST' });
            const stamp = new Date().toISOString();
            loaded.forEach(n => { if (!n.readAt) n.readAt = stamp; });
            render();
            notificationsChanged();
            showToast('All notifications marked read.', 'success');
          } catch (e) {
            showToast(e.message, 'error');
          } finally {
            readAllBtn.disabled = false;
          }
        });
    
        loadMoreBtn.addEventListener('click', load);
        load();
  })();
}

/* saved */
if (location.pathname === '/saved.html') {
  (() => {
    const { esc, api, showToast, fmtDate, statusBadge } = NSPA;
        const body = document.getElementById('savedBody');
    
        function chips(values, label) {
          if (!values || !values.length) return '';
          return `<span class="chip-row" role="list" aria-label="${esc(label)}">${values
            .map(v => `<span class="chip" role="listitem">${esc(v)}</span>`).join('')}</span>`;
        }
    
        function card(p) {
          const docs = p.documentCount
            ? `<span class="saved-docs">${p.documentCount} document${p.documentCount === 1 ? '' : 's'}</span>`
            : '';
          return `
            <article class="saved-card" data-project="${esc(p.id)}">
              <div class="saved-card-head">
                <div>
                  <h2 class="saved-title">${esc(p.title || 'Untitled project')}</h2>
                  <p class="saved-sub">
                    ${p.operator ? esc(p.operator) + ' · ' : ''}<span class="mono">${esc(p.id)}</span>
                    · Saved ${esc(fmtDate(p.savedAt))}
                  </p>
                </div>
                ${statusBadge(p.status)}
              </div>
              ${chips(p.commodities, 'Commodities')}
              ${chips(p.tenures, 'Tenure numbers')}
              <div class="saved-card-foot">
                ${docs}
                <button type="button" class="text-danger-btn unsave-btn" data-project="${esc(p.id)}"
                        aria-label="Remove ${esc(p.title || p.id)} from saved projects">Remove</button>
              </div>
            </article>`;
        }
    
        function render(projects) {
          if (!projects.length) {
            body.innerHTML = `
              <p class="membership-lead">You haven't saved any projects yet.</p>
              <p class="form-hint">Use the bookmark button on the project map or activity feed to save projects here.</p>`;
            return;
          }
          body.innerHTML = `<div class="saved-grid">${projects.map(card).join('')}</div>`;
          body.querySelectorAll('.unsave-btn').forEach(btn =>
            btn.addEventListener('click', () => unsave(btn))
          );
        }
    
        async function unsave(btn) {
          btn.disabled = true;
          try {
            await api(`/api/favorites/${encodeURIComponent(btn.dataset.project)}`, { method: 'DELETE' });
            const card = btn.closest('.saved-card');
            card.remove();
            showToast('Removed from saved projects.', 'success');
            if (!body.querySelectorAll('.saved-card').length) render([]);
          } catch (e) {
            btn.disabled = false;
            showToast(e.message, 'error');
          }
        }
    
        (async () => {
          try {
            const { projects } = await api('/api/favorites');
            render(projects);
          } catch (e) {
            body.innerHTML = `<p class="form-hint">Could not load your saved projects. ${esc(e.message)}</p>`;
          } finally {
            body.setAttribute('aria-busy', 'false');
          }
        })();
  })();
}

/* search */
if (location.pathname === '/search.html') {
  (() => {
    const { esc, api, debounce } = NSPA;
        const input = document.getElementById('q');
        const results = document.getElementById('results');
    
        const GROUP_ICONS = {
          projects: '◆', members: '☺', companies: '▣',
          tenures: '#', commodities: '◈', counties: '⬡',
        };
    
        function render(data) {
          if (!data.groups.length) {
            results.innerHTML = `<p class="membership-lead">No matches for “${esc(data.query)}”.</p>`;
            return;
          }
          results.innerHTML = data.groups.map(g => `
            <section class="search-group" aria-label="${esc(g.label)}">
              <p class="search-group-label">
                <span aria-hidden="true">${GROUP_ICONS[g.type] || '•'}</span>
                ${esc(g.label)} <span class="search-group-count">${g.items.length}</span>
              </p>
              <ul class="search-list">
                ${g.items.map(i => `
                  <li>
                    <a class="search-result" href="${esc(i.href)}">
                      <span class="search-result-label">${esc(i.label)}</span>
                      ${i.detail ? `<span class="search-result-detail">${esc(i.detail)}</span>` : ''}
                    </a>
                  </li>`).join('')}
              </ul>
            </section>`).join('');
        }
    
        const run = debounce(async () => {
          const q = input.value.trim();
          // Keep the URL shareable and back-button friendly.
          history.replaceState(null, '', q ? `?q=${encodeURIComponent(q)}` : location.pathname);
    
          if (q.length < 2) {
            results.innerHTML = '<p class="form-hint">Start typing to search.</p>';
            return;
          }
          results.setAttribute('aria-busy', 'true');
          try {
            render(await api(`/api/search?q=${encodeURIComponent(q)}`));
          } catch (e) {
            results.innerHTML = `<p class="form-hint">Search failed. ${esc(e.message)}</p>`;
          } finally {
            results.setAttribute('aria-busy', 'false');
          }
        }, 250);
    
        input.addEventListener('input', run);
    
        // Support /search.html?q=… so results can be linked to directly.
        const initial = new URLSearchParams(location.search).get('q');
        if (initial) { input.value = initial; run(); }
  })();
}

/* claims */
if (location.pathname === '/claims.html') {
  (() => {
    const { esc, api, showToast, fmtDateTime } = NSPA;
    
        const URGENCY_LABEL = {
          expired: 'Expired',
          critical: 'Expires soon',
          warning: 'Watch',
          ok: 'Good standing',
          unknown: 'Not yet checked',
        };
    
        const TENURE_STATUS_LABEL = {
          GOOD_STAND: 'Good standing',
          APPL_RNWL: 'Renewal applied for',
          PEND_EXPIRY: 'Pending expiry',
          EXPIRED: 'Expired',
          TERMINATED: 'Terminated',
          CANCELLED: 'Cancelled',
          PEND_CANCEL: 'Pending cancel',
        };
    
        const countdown = days => {
          if (days == null) return '-';
          if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`;
          if (days === 0) return 'today';
          return `in ${days} day${days === 1 ? '' : 's'}`;
        };
    
        function renderStats(data) {
          const openGround = (data.alerts || []).filter(a => a.kind === 'open_ground');
          const activeAlerts = (data.opportunityAlerts || []).filter(a => !a.paused);
          document.getElementById('claimStats').innerHTML = `
            <div><span>Claims</span><strong>${data.claims.length}</strong></div>
            <div><span>Open-ground notices</span><strong>${openGround.length}</strong></div>
            <div><span>Active alerts</span><strong>${activeAlerts.length}</strong></div>
            <div><span>Last checked</span><strong>${data.lastChecked ? esc(fmtDateTime(data.lastChecked)) : 'Not checked'}</strong></div>`;
        }
    
        function claimRow(c) {
          const status = TENURE_STATUS_LABEL[c.status] || c.status || 'Unknown';
          const annivRow = c.anniversary && c.anniversary !== c.expiry
            ? `<div><span class="dash-key">Anniversary</span><span class="dash-val">${esc(c.anniversary)} · ${esc(countdown(c.anniversaryDays))}</span></div>`
            : '';
          return `
            <article class="claim-card claim-${esc(c.urgency)}">
              <div class="claim-card-head">
                <span class="claim-number mono">${esc(c.tenureNumber)}</span>
                <span class="claim-urgency">${esc(URGENCY_LABEL[c.urgency] || '')}</span>
              </div>
              <div class="claim-facts">
                <div><span class="dash-key">Status</span><span class="dash-val">${esc(status)}</span></div>
                <div><span class="dash-key">Expires</span><span class="dash-val">${esc(c.expiry || '-')} · ${esc(countdown(c.expiryDays))}</span></div>
                ${annivRow}
                ${c.areaHa != null ? `<div><span class="dash-key">Area</span><span class="dash-val">${esc(c.areaHa)} ha</span></div>` : ''}
                ${c.projectTitle ? `<div><span class="dash-key">Project</span><span class="dash-val"><a href="/project.html?id=${encodeURIComponent(c.projectId)}">${esc(c.projectTitle)}</a></span></div>` : ''}
              </div>
              ${c.missing ? '<p class="claim-missing">NovaROC no longer returns this tenure.</p>' : ''}
              ${neighbourBlock(c)}
            </article>`;
        }
    
        function neighbourBlock(c) {
          const list = c.neighbours || [];
          if (!list.length) return '';
          const members = list.filter(n => n.memberId);
          const others = list.filter(n => !n.memberId);
          const chip = n => n.memberId
            ? `<a class="neighbour-chip is-member" href="/member.html?id=${encodeURIComponent(n.memberId)}"><span class="mono">${esc(n.tenureNumber)}</span> ${esc(n.memberName)}</a>`
            : `<span class="neighbour-chip"><span class="mono">${esc(n.tenureNumber)}</span></span>`;
          return `
            <details class="claim-neighbours">
              <summary>Adjacent ground · ${list.length} tenure${list.length === 1 ? '' : 's'}${members.length ? ` <span class="neighbour-member-count">${members.length} NSPA member${members.length === 1 ? '' : 's'}</span>` : ''}</summary>
              <div class="neighbour-chips">${members.map(chip).join('')}${others.map(chip).join('')}</div>
            </details>`;
        }
    
        function renderClaims(data) {
          const checked = document.getElementById('claimsChecked');
          checked.textContent = data.lastChecked ? `Checked ${fmtDateTime(data.lastChecked)}` : 'Not checked yet';
          document.getElementById('claimsBody').innerHTML = data.claims.length
            ? `<div class="claim-grid">${data.claims.map(claimRow).join('')}</div>`
            : '<p class="form-hint">No tenures registered yet. Claims are picked up from tenure numbers on submitted projects.</p>';
        }
    
        function renderOpenGround(data) {
          const openGround = (data.alerts || []).filter(a => a.kind === 'open_ground');
          document.getElementById('openGroundBody').innerHTML = `
            <p class="section-label">Ground That May Open Nearby</p>
            <p class="form-hint" style="margin:0 0 12px;">Tenures next to your ground that are expiring within ${data.openGroundWindowDays} days.</p>
            ${openGround.length
              ? `<div class="open-ground-list">${openGround.map(a => `
                  <div class="open-ground-row">
                    <span class="mono">${esc(a.tenureNumber)}</span>
                    <span class="open-ground-date">expires ${esc(a.dueDate || 'unknown')}</span>
                    <a class="open-ground-link" href="https://novaroc.novascotia.ca/novaroc/page/viewer/mineralSearch/searchForm.jsf" target="_blank" rel="noopener noreferrer">Check in NovaROC</a>
                  </div>`).join('')}</div>`
              : '<p class="claim-alert-empty">No nearby open-ground notices right now.</p>'}`;
        }
    
        function renderClaimAlerts(alerts, matches) {
          const target = document.getElementById('claimAlertsBody');
          const statusOptions = [
            ['PEND_EXPIRY', 'Pending expiry'],
            ['EXPIRED', 'Expired'],
            ['TERMINATED', 'Terminated'],
            ['CANCELLED', 'Cancelled'],
            ['PEND_CANCEL', 'Pending cancel'],
          ];
          const alertCard = a => {
            const c = a.criteria || {};
            const statuses = (c.statuses || []).map(s => TENURE_STATUS_LABEL[s] || s).join(', ') || 'Any open-ground status';
            const range = [
              c.maxExpiryDays != null ? `within ${c.maxExpiryDays} days` : '',
              c.minAreaHa != null ? `min ${c.minAreaHa} ha` : '',
              c.maxAreaHa != null ? `max ${c.maxAreaHa} ha` : '',
              c.tenureText ? `contains ${c.tenureText}` : '',
            ].filter(Boolean).join(' · ');
            return `
              <article class="claim-alert-card ${a.paused ? 'is-paused' : 'is-active'}">
                <div class="claim-alert-card-main">
                  <div class="claim-alert-title-row"><strong>${esc(a.name)}</strong><span class="claim-alert-state">${a.paused ? 'Paused' : 'Active'}</span></div>
                  <p>${esc(statuses)}${range ? ` · ${esc(range)}` : ''}</p>
                  <span class="claim-alert-channel">${esc(a.channel || 'both')}</span>
                </div>
                <div class="claim-alert-actions">
                  <button type="button" class="secondary-btn claim-alert-toggle" data-id="${esc(a.id)}" data-paused="${a.paused ? '0' : '1'}">${a.paused ? 'Resume' : 'Pause'}</button>
                  <button type="button" class="text-danger-btn claim-alert-delete" data-id="${esc(a.id)}">Delete</button>
                </div>
              </article>`;
          };
          const sortedMatches = matches.slice().sort((a, b) =>
            Number(((b.detail || {}).advisory || {}).rankScore || 0) - Number(((a.detail || {}).advisory || {}).rankScore || 0)
          );
          const matchRows = sortedMatches.slice(0, 5).map(m => {
            const d = m.detail || {};
            const ai = d.advisory || {};
            const flag = ai.reviewFlag === 'worth_reviewing' ? 'Worth reviewing'
              : ai.reviewFlag === 'routine_watch' ? 'Routine watch'
              : 'Low priority';
            return `
              <article class="claim-opportunity-card ${esc(ai.reviewFlag || 'routine_watch')}">
                <div class="claim-opportunity-top">
                  <span class="mono">${esc(m.tenureNumber)}</span>
                  <span class="claim-opportunity-rank">${esc(ai.rankScore || '-')} / 100</span>
                </div>
                <div class="claim-opportunity-main">
                  <strong>${esc(flag)}</strong>
                  <p>${esc(ai.plainEnglish || `${d.alertName || 'Opportunity alert'} matched this tenure.`)}</p>
                </div>
                <div class="claim-opportunity-facts">
                  <span>${esc(d.alertName || 'Opportunity alert')}</span>
                  <span>${esc(d.status || 'status unknown')}</span>
                  <span>${esc(d.expiry ? `expires ${d.expiry}` : 'date unknown')}</span>
                  ${d.areaHa != null ? `<span>${esc(d.areaHa)} ha</span>` : ''}
                </div>
                ${Array.isArray(ai.whyMatches) && ai.whyMatches.length
                  ? `<ul class="claim-opportunity-why">${ai.whyMatches.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`
                  : ''}
                ${ai.nearbyContext ? `<p class="claim-opportunity-context">${esc(ai.nearbyContext)}</p>` : ''}
                <p class="claim-opportunity-note">${esc(ai.reviewReason || 'AI is advisory only. Confirm details in NovaROC before acting.')}</p>
                <a class="secondary-btn" href="https://novaroc.novascotia.ca/novaroc/page/viewer/mineralSearch/searchForm.jsf" target="_blank" rel="noopener noreferrer">Check in NovaROC</a>
              </article>`;
          }).join('');
    
          target.innerHTML = `
            <section class="claim-alert-panel compact">
              <div class="claim-alert-head">
                <div>
                  <p class="section-label small">Claim Opportunity Alerts</p>
                  <h2>Watch ground before it opens</h2>
                </div>
                <span>${alerts.filter(a => !a.paused).length} active</span>
              </div>
              <div class="claim-alert-layout">
                <form id="claimAlertForm" class="claim-alert-form">
                  <div class="field claim-alert-name-field">
                    <label for="caName">Alert name</label>
                    <input id="caName" class="claim-alert-input" name="name" maxlength="80" placeholder="Gold Belt open ground" />
                  </div>
                  <div class="claim-alert-fields">
                    <div class="field"><label for="caMaxDays">Expiry window</label><input id="caMaxDays" name="maxExpiryDays" type="number" min="0" max="365" value="90" /></div>
                    <div class="field claim-alert-channel-field">
                      <span class="field-label">Notify by</span>
                      <div class="claim-channel-options" role="radiogroup" aria-label="Notification delivery method">
                        <label><input type="radio" name="channel" value="both" checked /> <span>In-app + email</span></label>
                        <label><input type="radio" name="channel" value="inapp" /> <span>In-app only</span></label>
                        <label><input type="radio" name="channel" value="email" /> <span>Email only</span></label>
                      </div>
                    </div>
                    <div class="field"><label for="caMinArea">Min area ha</label><input id="caMinArea" name="minAreaHa" type="number" min="0" step="0.1" /></div>
                    <div class="field"><label for="caMaxArea">Max area ha</label><input id="caMaxArea" name="maxAreaHa" type="number" min="0" step="0.1" /></div>
                    <div class="field full claim-alert-tenure-field">
                      <label for="caTenureText">Tenure number contains</label>
                      <input id="caTenureText" class="claim-alert-input" name="tenureText" maxlength="80" placeholder="Optional, e.g. 563" />
                    </div>
                  </div>
                  <fieldset class="claim-status-picker">
                    <legend>Matching status</legend>
                    ${statusOptions.map(([value, label]) => `<label><input type="checkbox" name="statuses" value="${esc(value)}" /> <span>${esc(label)}</span></label>`).join('')}
                  </fieldset>
                  <button type="submit" class="submit-btn">Save Alert</button>
                </form>
                <div class="claim-alert-side">
                  <div class="claim-alert-list">${alerts.length ? alerts.map(alertCard).join('') : '<p class="claim-alert-empty">No opportunity alerts saved yet.</p>'}</div>
                  ${matchRows ? `<div class="claim-match-box"><p class="section-label small">Ranked Matches</p>${matchRows}</div>` : ''}
                </div>
              </div>
            </section>`;
    
          document.getElementById('claimAlertForm').addEventListener('submit', saveClaimAlert);
          target.querySelectorAll('.claim-alert-toggle').forEach(btn => btn.addEventListener('click', () => updateClaimAlertPause(btn, alerts)));
          target.querySelectorAll('.claim-alert-delete').forEach(btn => btn.addEventListener('click', () => deleteClaimAlert(btn.dataset.id)));
        }
    
        async function saveClaimAlert(ev) {
          ev.preventDefault();
          const form = ev.currentTarget;
          const payload = {
            name: form.elements.name.value,
            channel: form.querySelector('input[name="channel"]:checked').value,
            criteria: {
              statuses: [...form.querySelectorAll('input[name="statuses"]:checked')].map(el => el.value),
              maxExpiryDays: form.elements.maxExpiryDays.value,
              minAreaHa: form.elements.minAreaHa.value,
              maxAreaHa: form.elements.maxAreaHa.value,
              tenureText: form.elements.tenureText.value,
            },
          };
          try {
            await api('/api/claim-alerts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            showToast('Opportunity alert saved.', 'success');
            form.reset();
            loadClaims();
          } catch (e) { showToast(e.message, 'error'); }
        }
    
        async function updateClaimAlertPause(btn, alerts) {
          const alert = alerts.find(a => String(a.id) === String(btn.dataset.id));
          if (!alert) return;
          try {
            await api(`/api/claim-alerts/${encodeURIComponent(alert.id)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...alert, paused: btn.dataset.paused === '1' }),
            });
            showToast(btn.dataset.paused === '1' ? 'Alert paused.' : 'Alert resumed.', 'success');
            loadClaims();
          } catch (e) { showToast(e.message, 'error'); }
        }
    
        async function deleteClaimAlert(id) {
          if (!confirm('Delete this opportunity alert?')) return;
          try {
            await api(`/api/claim-alerts/${encodeURIComponent(id)}`, { method: 'DELETE' });
            showToast('Alert deleted.', 'success');
            loadClaims();
          } catch (e) { showToast(e.message, 'error'); }
        }
    
        async function loadClaims() {
          try {
            const data = await api('/api/claims');
            renderStats(data);
            renderClaims(data);
            renderOpenGround(data);
            renderClaimAlerts(data.opportunityAlerts || [], data.opportunityMatches || []);
          } catch (e) {
            document.getElementById('claimsBody').innerHTML = `<p class="form-hint">Could not load claims. ${esc(e.message)}</p>`;
          }
        }
    
        loadClaims();
  })();
}
