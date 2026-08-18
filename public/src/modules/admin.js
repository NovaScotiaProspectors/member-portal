const { esc, api, showToast, fmtDateTime } = NSPA;
    const statsEl = document.getElementById('adminStats');
    const membersBody = document.getElementById('membersBody');
    const projectsBody = document.getElementById('projectsBody');
    const systemStatus = document.getElementById('systemStatus');
    const refreshOverviewBtn = document.getElementById('refreshOverviewBtn');
    const refreshMembersBtn = document.getElementById('refreshMembersBtn');
    const refreshProjectsBtn = document.getElementById('refreshProjectsBtn');
    const memberSearch = document.getElementById('memberSearch');
    const memberStatusFilter = document.getElementById('memberStatusFilter');
    const memberNetworkFilter = document.getElementById('memberNetworkFilter');
    const projectSearch = document.getElementById('projectSearch');
    const projectStatusFilter = document.getElementById('projectStatusFilter');
    const projectVisibilityFilter = document.getElementById('projectVisibilityFilter');
    const adminCreateProjectForm = document.getElementById('adminCreateProjectForm');
    const adminProjectMember = document.getElementById('adminProjectMember');
    const adminProjectStatus = document.getElementById('adminProjectStatus');
    const adminProjectName = document.getElementById('adminProjectName');
    const adminProjectOperator = document.getElementById('adminProjectOperator');
    const adminProjectTenures = document.getElementById('adminProjectTenures');
    const adminProjectCommodities = document.getElementById('adminProjectCommodities');
    const adminProjectDepositTypes = document.getElementById('adminProjectDepositTypes');
    const adminProjectDescription = document.getElementById('adminProjectDescription');
    const adminProjectDataRoom = document.getElementById('adminProjectDataRoom');

    const PROJECT_STATUSES = ['Pending', 'Submitted', 'Under Review', 'Approved', 'Revisions Requested', 'Rejected', 'Resubmitted'];
    let allMembers = [];
    let allProjects = [];

    projectStatusFilter.innerHTML += PROJECT_STATUSES.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    adminProjectStatus.innerHTML = PROJECT_STATUSES.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    adminProjectStatus.value = 'Pending';

    function fmtDate(iso) {
      if (!iso) return '-';
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? esc(iso) : d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
    }

    function statusBadge(status) {
      const s = status || 'pending_payment';
      const label = s === 'active' ? 'Member' : s === 'inactive' ? 'Lapsed' : 'Awaiting payment';
      const cssStatus = s === 'pending_payment' ? 'pending' : s;
      return `<span class="status-badge status-${esc(cssStatus)}">${label}</span>`;
    }

    function projectStatusSelect(p) {
      const cur = p.status || 'Pending';
      return `<select class="status-select" data-id="${esc(p.id)}" aria-label="Status for ${esc(p.title || p.id)}">
        ${PROJECT_STATUSES.map(s => `<option${s === cur ? ' selected' : ''}>${s}</option>`).join('')}
      </select>`;
    }

    function memberActions(u) {
      const inactive = (u.accountStatus || 'active') === 'deactivated';
      if (inactive) {
        return `<div class="admin-action-group">
          <button type="button" class="secondary-btn admin-mini-btn member-action-btn" data-id="${esc(u.memberId)}" data-action="restore">Restore</button>
        </div>`;
      }
      return `<div class="admin-action-group">
        ${u.membershipStatus === 'active'
          ? `<button type="button" class="secondary-btn admin-mini-btn member-action-btn" data-id="${esc(u.memberId)}" data-action="lapse">Mark Lapsed</button>`
          : `<button type="button" class="secondary-btn admin-mini-btn member-action-btn" data-id="${esc(u.memberId)}" data-action="activate">Activate</button>`}
        <button type="button" class="text-danger-btn admin-mini-danger member-action-btn" data-id="${esc(u.memberId)}" data-action="deactivate">Deactivate</button>
      </div>`;
    }

    function projectActions(p) {
      return `<div class="admin-action-group">
        <button type="button" class="secondary-btn admin-mini-btn project-edit-btn" data-id="${esc(p.id)}">Edit</button>
        <button type="button" class="secondary-btn admin-mini-btn project-archive-btn" data-id="${esc(p.id)}" data-archived="${p.archived ? 'true' : 'false'}">
          ${p.archived ? 'Restore' : 'Archive'}
        </button>
        <button type="button" class="text-danger-btn admin-mini-danger project-delete-btn" data-id="${esc(p.id)}" data-title="${esc(p.title || p.id)}">Delete</button>
      </div>`;
    }

    /* Administrators may edit every field on any project, including ownership
       and the administrative ones. The server enforces this independently —
       this form is the convenience, PUT /api/projects/:id is the rule. */
    function projectEditRow(p) {
      const field = (name, label, value, type = 'text') => `
        <div class="field">
          <label for="ap-${name}-${esc(p.id)}">${esc(label)}</label>
          <input type="${type}" id="ap-${name}-${esc(p.id)}" name="${name}" value="${esc(value || '')}" />
        </div>`;

      return `
        <tr class="admin-edit-row" data-edit-for="${esc(p.id)}" hidden>
          <td colspan="6">
            <form class="admin-project-form" data-id="${esc(p.id)}">
              <p class="section-label small">Edit ${esc(p.title || p.id)}</p>
              <div class="grid-2">
                ${field('project', 'Project name', p.title)}
                ${field('operator', 'Operator', p.operator)}
                <div class="field full">
                  <label for="ap-description-${esc(p.id)}">Description</label>
                  <textarea id="ap-description-${esc(p.id)}" name="description">${esc(p.description || '')}</textarea>
                </div>
                ${field('commodities', 'Commodities', p.commodities)}
                ${field('depositTypes', 'Deposit types', p.depositTypes)}
                ${field('projectStage', 'Project stage', p.projectStage)}
                ${field('resourceSource', 'Resource source', p.resourceSource)}
                <div class="field full">
                  <label for="ap-resourceEstimate-${esc(p.id)}">Resource estimate</label>
                  <textarea id="ap-resourceEstimate-${esc(p.id)}" name="resourceEstimate">${esc(p.resourceEstimate || '')}</textarea>
                </div>
                ${field('website', 'Website', p.website, 'url')}
                ${field('dataRoomUrl', 'Data Room (Google Drive link)', p.dataRoomUrl, 'url')}

                <div class="field full"><p class="section-label small">Administrative</p></div>
                ${field('memberId', 'Owner (member ID)', p.memberId)}
                <div class="field">
                  <label for="ap-status-${esc(p.id)}">Status</label>
                  <select id="ap-status-${esc(p.id)}" name="status">
                    ${PROJECT_STATUSES.map(st =>
                      `<option value="${esc(st)}"${st === p.status ? ' selected' : ''}>${esc(st)}</option>`).join('')}
                  </select>
                </div>
                <div class="field">
                  <label for="ap-archived-${esc(p.id)}">Archived</label>
                  <select id="ap-archived-${esc(p.id)}" name="archived">
                    <option value="false"${p.archived ? '' : ' selected'}>Visible</option>
                    <option value="true"${p.archived ? ' selected' : ''}>Archived</option>
                  </select>
                </div>
                <div class="field full">
                  <label for="ap-reviewNote-${esc(p.id)}">Internal review note</label>
                  <textarea id="ap-reviewNote-${esc(p.id)}" name="reviewNote">${esc(p.reviewNote || '')}</textarea>
                </div>
              </div>
              <div class="admin-action-group">
                <button type="submit" class="submit-btn">Save Changes</button>
                <button type="button" class="secondary-btn project-edit-cancel">Cancel</button>
              </div>
            </form>
          </td>
        </tr>`;
    }

    async function saveProjectEdits(ev, form) {
      ev.preventDefault();
      const submitBtn = form.querySelector('button[type=submit]');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving…';
      try {
        const payload = {};
        form.querySelectorAll('[name]').forEach(el => { payload[el.name] = el.value; });
        await api(`/api/projects/${encodeURIComponent(form.dataset.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        showToast('Project updated.', 'success');
        await loadProjects();
      } catch (e) {
        showToast(e.message, 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Save Changes';
      }
    }

    async function loadOverview() {
      refreshOverviewBtn.disabled = true;
      try {
        const data = await api('/api/admin/overview');
        const pending = data.projects.statuses.Pending || 0;
        statsEl.innerHTML = `
          <div class="admin-stat"><span class="admin-stat-label">Accounts</span><span class="admin-stat-num">${data.members.total}</span></div>
          <div class="admin-stat success"><span class="admin-stat-label">Active members</span><span class="admin-stat-num">${data.members.active}</span></div>
          <div class="admin-stat"><span class="admin-stat-label">Network profiles</span><span class="admin-stat-num">${data.members.network}</span></div>
          <div class="admin-stat"><span class="admin-stat-label">Projects</span><span class="admin-stat-num">${data.projects.total}</span></div>
          <div class="admin-stat warning"><span class="admin-stat-label">Pending review</span><span class="admin-stat-num">${pending}</span></div>
          <div class="admin-stat danger"><span class="admin-stat-label">Archived</span><span class="admin-stat-num">${data.projects.archived}</span></div>`;
        systemStatus.textContent = `Payments ${data.paymentsEnabled ? 'ready' : 'not configured'} · Email ${data.mail && data.mail.configured ? 'configured' : 'off'}`;
      } catch (e) {
        statsEl.innerHTML = '<div class="admin-empty">Could not load overview.</div>';
      } finally {
        refreshOverviewBtn.disabled = false;
      }
    }

    async function loadMembers() {
      refreshMembersBtn.disabled = true;
      try {
        const data = await api('/api/admin/members');
        allMembers = data.users || [];
        populateProjectMemberSelect();
        renderMembers();
      } catch (e) {
        membersBody.innerHTML = '<tr><td colspan="6" class="admin-empty">Could not load members.</td></tr>';
      } finally {
        refreshMembersBtn.disabled = false;
      }
    }

    function populateProjectMemberSelect() {
      const current = adminProjectMember.value;
      const users = allMembers
        .filter(u => (u.accountStatus || 'active') !== 'deactivated')
        .sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`));
      adminProjectMember.innerHTML = '<option value="">Choose member</option>' + users.map(u => {
        const name = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || u.memberId;
        return `<option value="${esc(u.memberId)}">${esc(name)} · ${esc(u.memberId)}</option>`;
      }).join('');
      if (current) adminProjectMember.value = current;
    }

    function renderMembers() {
      const q = memberSearch.value.trim().toLowerCase();
      const membership = memberStatusFilter.value;
      const network = memberNetworkFilter.value;
      const users = allMembers.filter(u => {
        const haystack = [u.memberId, u.firstName, u.lastName, u.email, u.phone].join(' ').toLowerCase();
        return (!q || haystack.includes(q)) &&
          (!membership || (u.membershipStatus || 'pending_payment') === membership) &&
          (!network || (u.networkStatus || 'out') === network);
      });
      if (!users.length) {
          membersBody.innerHTML = `<tr><td colspan="6" class="admin-empty">${allMembers.length ? 'No members match the filters.' : 'No accounts yet.'}</td></tr>`;
          return;
        }
        membersBody.innerHTML = users.map(u => `
          <tr>
            <td><strong>${esc(u.firstName)} ${esc(u.lastName)}</strong><br><span class="project-date">${esc(u.memberId)}</span></td>
            <td class="mono">${esc(u.email)}<br>${esc(u.phone) || '-'}</td>
            <td>${statusBadge(u.membershipStatus)}<br><span class="project-date">${fmtDate(u.membershipExpiry)}</span><br><span class="project-date">Student: ${esc((u.studentVerification && u.studentVerification.status) || 'none')}</span></td>
            <td>${(u.networkStatus || 'out') === 'joined' ? '<span class="status-badge status-active">Joined</span>' : '<span class="status-badge status-none">Out</span>'}</td>
            <td>${(u.accountStatus || 'active') === 'deactivated' ? '<span class="status-badge status-inactive">Deactivated</span>' : '<span class="status-badge status-active">Active</span>'}</td>
            <td>${memberActions(u)}</td>
          </tr>`).join('');
        membersBody.querySelectorAll('.member-action-btn').forEach(btn => btn.addEventListener('click', () => updateMember(btn)));
    }

    async function updateMember(btn) {
      const action = btn.dataset.action;
      if (action === 'deactivate' && !confirm('Deactivate this account?')) return;
      btn.disabled = true;
      try {
        await api(`/api/admin/members/${encodeURIComponent(btn.dataset.id)}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        showToast('Member updated.', 'success');
        await Promise.all([loadMembers(), loadOverview()]);
      } catch (e) {
        showToast(e.message, 'error');
        btn.disabled = false;
      }
    }

    async function updateProjectStatus(sel) {
      sel.disabled = true;
      try {
        await api('/api/admin/project-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: sel.dataset.id, status: sel.value }),
        });
        showToast('Project status updated.', 'success');
        await loadOverview();
      } catch (e) {
        showToast(e.message, 'error');
      } finally {
        sel.disabled = false;
      }
    }

    async function archiveProject(btn) {
      btn.disabled = true;
      const archived = btn.dataset.archived !== 'true';
      try {
        await api(`/api/admin/projects/${encodeURIComponent(btn.dataset.id)}/archive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archived }),
        });
        showToast(archived ? 'Project archived.' : 'Project restored.', 'success');
        await Promise.all([loadProjects(), loadOverview()]);
      } catch (e) {
        showToast(e.message, 'error');
        btn.disabled = false;
      }
    }

    async function deleteProject(btn) {
      const id = btn.dataset.id;
      const title = btn.dataset.title || id;
      const confirmId = prompt(`Permanently delete "${title}"? Type ${id} to confirm.`);
      if (confirmId !== id) return;
      btn.disabled = true;
      try {
        await api(`/api/admin/projects/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: id }),
        });
        showToast('Project deleted.', 'success');
        await Promise.all([loadProjects(), loadOverview()]);
      } catch (e) {
        showToast(e.message, 'error');
        btn.disabled = false;
      }
    }

    async function loadProjects() {
      refreshProjectsBtn.disabled = true;
      try {
        const { projects } = await api('/api/admin/projects');
        allProjects = projects || [];
        renderProjects();
      } catch (e) {
        projectsBody.innerHTML = '<tr><td colspan="6" class="admin-empty">Could not load projects.</td></tr>';
      } finally {
        refreshProjectsBtn.disabled = false;
      }
    }

    function renderProjects() {
      const q = projectSearch.value.trim().toLowerCase();
      const status = projectStatusFilter.value;
      const visibility = projectVisibilityFilter.value;
      const projects = allProjects.filter(p => {
        const haystack = [p.id, p.title, p.operator, p.memberId, p.firstName, p.lastName, p.tenures, p.commodities, p.depositTypes].join(' ').toLowerCase();
        return (!q || haystack.includes(q)) &&
          (!status || (p.status || 'Pending') === status) &&
          (!visibility || (visibility === 'archived' ? p.archived : !p.archived));
      });
      if (!projects.length) {
          projectsBody.innerHTML = `<tr><td colspan="6" class="admin-empty">${allProjects.length ? 'No projects match the filters.' : 'No projects yet.'}</td></tr>`;
          return;
        }
        projectsBody.innerHTML = projects.map(p => `
          <tr>
            <td>
              <strong>${esc(p.title) || '-'}</strong><br>
              <span class="project-date">${esc(p.id)}</span>
              ${p.dataRoomUrl
                ? `<br><a class="data-room-link" href="${esc(p.dataRoomUrl)}" target="_blank"
                         rel="noopener noreferrer external">Open Data Room<span class="sr-only"> (opens in a new tab)</span></a>`
                : ''}
            </td>
            <td class="mono">${esc(p.memberId) || '-'}</td>
            <td>${fmtDate(p.createdAt)}</td>
            <td>${projectStatusSelect(p)}</td>
            <td>${p.archived ? '<span class="status-badge status-inactive">Archived</span>' : '<span class="status-badge status-active">Visible</span>'}</td>
            <td>${projectActions(p)}</td>
          </tr>
          ${projectEditRow(p)}`).join('');
        projectsBody.querySelectorAll('.project-edit-btn').forEach(btn => btn.addEventListener('click', () => {
          const row = projectsBody.querySelector(`.admin-edit-row[data-edit-for="${CSS.escape(btn.dataset.id)}"]`);
          if (!row) return;
          row.hidden = !row.hidden;
          if (!row.hidden) row.querySelector('input, textarea, select')?.focus();
        }));
        projectsBody.querySelectorAll('.project-edit-cancel').forEach(btn => btn.addEventListener('click', () => {
          const row = btn.closest('.admin-edit-row');
          if (row) row.hidden = true;
        }));
        projectsBody.querySelectorAll('.admin-project-form').forEach(form =>
          form.addEventListener('submit', ev => saveProjectEdits(ev, form)));
        projectsBody.querySelectorAll('.status-select').forEach(sel => sel.addEventListener('change', () => updateProjectStatus(sel)));
        projectsBody.querySelectorAll('.project-archive-btn').forEach(btn => btn.addEventListener('click', () => archiveProject(btn)));
        projectsBody.querySelectorAll('.project-delete-btn').forEach(btn => btn.addEventListener('click', () => deleteProject(btn)));
    }

    adminCreateProjectForm.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = adminCreateProjectForm.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        await api('/api/admin/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            memberId: adminProjectMember.value,
            project: adminProjectName.value,
            operator: adminProjectOperator.value,
            tenureNumbers: adminProjectTenures.value,
            status: adminProjectStatus.value,
            commodities: adminProjectCommodities.value,
            depositTypes: adminProjectDepositTypes.value,
            description: adminProjectDescription.value,
            dataRoomUrl: adminProjectDataRoom ? adminProjectDataRoom.value : '',
          }),
        });
        showToast('Project created and assigned.', 'success');
        adminCreateProjectForm.reset();
        adminProjectStatus.value = 'Pending';
        await Promise.all([loadProjects(), loadOverview()]);
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById('claimWatchBtn').addEventListener('click', async e => {
      e.target.disabled = true;
      try {
        const result = await api('/api/admin/claims/run-watch', { method: 'POST' });
        showToast(`Claim watch complete: ${result.alerts || 0} alert(s).`, 'success');
        await loadOverview();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        e.target.disabled = false;
      }
    });

    document.getElementById('mailTestBtn').addEventListener('click', async e => {
      const to = prompt('Send test email to:', '');
      if (!to) return;
      e.target.disabled = true;
      try {
        await api('/api/admin/mail/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to }),
        });
        showToast('Test email sent.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        e.target.disabled = false;
      }
    });

    refreshOverviewBtn.addEventListener('click', loadOverview);
    refreshMembersBtn.addEventListener('click', loadMembers);
    refreshProjectsBtn.addEventListener('click', loadProjects);
    [memberSearch, memberStatusFilter, memberNetworkFilter].forEach(el => el.addEventListener('input', renderMembers));
    [projectSearch, projectStatusFilter, projectVisibilityFilter].forEach(el => el.addEventListener('input', renderProjects));

    /* ── Backups ─────────────────────────────────────────────────────────
       Render backup status, download links, and manual backup actions. */
    const backupList = document.getElementById('backupList');
    const backupStatus = document.getElementById('backupStatus');

    const fmtBytes = b => b >= 1048576
      ? (b / 1048576).toFixed(1) + ' MB'
      : Math.round(b / 1024) + ' KB';

    function renderBackups(data) {
      const last = data.last;
      backupStatus.textContent = last
        ? `Last backup ${fmtDateTime(last.finishedAt || last.takenAt)}` +
          (last.emailed ? ' · emailed' : last.emailNote ? ` · not emailed (${last.emailNote})` : '')
        : 'No backup taken yet';

      if (!data.emailConfigured) {
        backupStatus.textContent += ' · email not configured';
      }

      if (!data.backups.length) {
        backupList.innerHTML = `<div class="empty-state">
          <span class="empty-state-icon" aria-hidden="true">⤓</span>
          <p class="empty-state-title">No backups yet</p>
          <p class="empty-state-text">One runs automatically each night, or take one now.</p>
        </div>`;
        return;
      }

      backupList.innerHTML = `
        <div class="doc-list">
          ${data.backups.map(b => `
            <div class="doc-item">
              <a class="doc-download" href="/api/admin/backups/${encodeURIComponent(b.name)}" download>
                ${esc(b.name.includes('-full-') ? 'Full backup (with documents)' : 'Backup')}
              </a>
              <span class="doc-item-meta">${esc(fmtDateTime(b.takenAt))} · ${esc(fmtBytes(b.bytes))}</span>
            </div>`).join('')}
        </div>`;
    }

    async function loadBackups() {
      try {
        renderBackups(await api('/api/admin/backups'));
      } catch (e) {
        backupList.innerHTML = `<p class="form-hint">Could not load backups. ${esc(e.message)}</p>`;
      }
    }

    async function takeBackup(kind, btn) {
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = 'Backing up…';
      try {
        const r = await api('/api/admin/backups/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind }),
        });
        showToast(
          r.emailed ? 'Backup created and emailed.' :
          `Backup created${r.emailNote ? ' — ' + r.emailNote : ''}.`,
          'success'
        );
        await loadBackups();
      } catch (e) {
        showToast(e.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    }

    document.getElementById('backupNowBtn')
      .addEventListener('click', e => takeBackup('core', e.target));
    document.getElementById('backupFullBtn')
      .addEventListener('click', e => takeBackup('full', e.target));

    loadOverview();
    loadMembers();
    loadProjects();
    loadBackups();
