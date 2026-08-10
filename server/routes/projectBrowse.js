function registerProjectBrowseRoutes(app, ctx) {
  const {
    requireMemberApi, portal, listProjects, readSubmissions, publicDocument,
    RESUBMITTABLE_STATUSES, visibleProjectRecords, isAdmin, listUsers, isActiveMember,
    parseNetworkVisibility, networkProjectSummary, applyNetworkVisibility, publicProfile,
    updateMembership, invalidateSessionUser, serializeNetworkVisibility, cleanNetworkVisibility,
    DEFAULT_NETWORK_VISIBILITY,
  } = ctx;

  // A member's own projects (members only; history is retained in storage and
  // reappears when a lapsed member re-joins).
  app.get('/api/my/projects', requireMemberApi, async (req, res) => {
    try {
      const projects = await listProjects(req.user.memberId);
      const submissions = await readSubmissions();
      const documentsById = new Map(
        submissions.map(s => [s.id, Array.isArray(s.documents) ? s.documents.map(publicDocument) : []])
      );
      res.json({
        projects: await Promise.all(projects.map(async p => ({
          ...p,
          documents: documentsById.get(p.id) || [],
          // Members rework a project from the dashboard, so it needs to know
          // whether this one is currently editable.
          canResubmit: RESUBMITTABLE_STATUSES.includes(p.status),
          timeline: await portal.listProjectTimeline(p.id),
        }))),
      });
    } catch (error) {
      console.error('my projects:', error.message);
      res.status(500).json({ error: 'Could not load your projects.' });
    }
  });
  
  // All visible projects with their tenure geometry, for the project map.
  // Polygons live in submissions.json (captured at submission time); the current
  // status lives in projects.xlsx, so the two are joined here by project id.
  // Public map data: only approved projects from active members are included.
  app.get('/api/projects/map', async (req, res) => {
    try {
      // Same record builder as the detail page and search, so derived fields
      // (county, geometry types, centre) remain consistent across surfaces.
      const projects = await visibleProjectRecords(req.user, { includeGeometry: true });
      res.json({ projects });
    } catch (error) {
      console.error('projects map:', error.message);
      res.status(500).json({ error: 'Could not load the project map.' });
    }
  });
  
  // Filter options for the map and search UIs, derived from what's actually
  // visible to this viewer so the dropdowns never offer an empty result.
  app.get('/api/projects/filters', async (req, res) => {
    try {
      const records = await visibleProjectRecords(req.user);
      const collect = pick => [...new Set(records.flatMap(pick).filter(Boolean))].sort();
  
      res.json({
        commodities: collect(r => r.commodities),
        counties: collect(r => r.counties),
        depositTypes: collect(r => r.depositTypes),
        operators: collect(r => (r.operator ? [r.operator] : [])),
        owners: collect(r => (r.owner ? [r.owner] : [])),
        statuses: collect(r => (r.status ? [r.status] : [])),
        stages: collect(r => (r.projectStage ? [r.projectStage] : [])),
        tenureNumbers: collect(r => r.tenureNumbers),
        media: [
          { value: 'photos', label: 'Has photos' },
          { value: 'documents', label: 'Has files' },
          { value: 'resource', label: 'Has resource estimate' },
        ],
        years: collect(r => (r.year ? [r.year] : [])).reverse(),
        total: records.length,
      });
    } catch (error) {
      console.error('project filters:', error.message);
      res.status(500).json({ error: 'Could not load filter options.' });
    }
  });
  
  /* ── Global search ──────────────────────────────────────────────────────────
   * Searches projects, members, companies, commodities, counties and tenure
   * numbers in one pass. Every project result goes through the same visibility
   * rules as the map, and member results are limited to those who have opted
   * into the member network.
   * ──────────────────────────────────────────────────────────────────────────── */
  
  // Mounted outside the '/api/projects' prefix, so it needs its own gate.
  app.get('/api/search', requireMemberApi, async (req, res) => {
    try {
      const query = String(req.query.q || '').trim().toLowerCase();
      if (query.length < 2) {
        return res.json({ query, groups: [], total: 0 });
      }
  
      const records = await visibleProjectRecords(req.user);
      const hit = value => String(value || '').toLowerCase().includes(query);
  
      /* Projects — matched on name, company, member, county, tenure or commodity. */
      const projects = records
        .filter(p =>
          hit(p.title) || hit(p.operator) || hit(p.owner) || hit(p.description) ||
          p.counties.some(hit) || p.commodities.some(hit) ||
          p.depositTypes.some(hit) || p.tenureNumbers.some(hit)
        )
        .slice(0, 25)
        .map(p => ({
          id: p.id,
          label: p.title,
          detail: [p.operator, p.county, p.status].filter(Boolean).join(' · '),
          href: `/project.html?id=${encodeURIComponent(p.id)}`,
        }));
  
      /* Companies and commodities/counties come from the visible project set, so
         a facet never leads to an empty result page. */
      const facet = (values, type, hrefFor) =>
        [...new Set(values.filter(v => v && hit(v)))]
          .sort()
          .slice(0, 15)
          .map(v => ({
            id: v,
            label: v,
            detail: `${records.filter(r => hrefFor.match(r, v)).length} project(s)`,
            href: hrefFor.href(v),
          }));
  
      const companies = facet(records.map(r => r.operator), 'company', {
        match: (r, v) => r.operator === v,
        href: v => `/map.html#operator=${encodeURIComponent(v)}`,
      });
      const commodities = facet(records.flatMap(r => r.commodities), 'commodity', {
        match: (r, v) => r.commodities.includes(v),
        href: v => `/map.html#commodity=${encodeURIComponent(v)}`,
      });
      const counties = facet(records.flatMap(r => r.counties), 'county', {
        match: (r, v) => r.counties.includes(v),
        href: v => `/map.html#county=${encodeURIComponent(v)}`,
      });
  
      /* Tenure numbers resolve straight to their project. */
      const tenures = records
        .flatMap(r => r.tenureNumbers.map(t => ({ tenure: t, project: r })))
        .filter(x => hit(x.tenure))
        .slice(0, 15)
        .map(x => ({
          id: x.tenure,
          label: x.tenure,
          detail: `on ${x.project.title}`,
          href: `/project.html?id=${encodeURIComponent(x.project.id)}`,
        }));
  
      /* Members — only those who joined the network, respecting their own
         visibility preferences. */
      const users = await listUsers();
      const members = users
        .filter(u =>
          isActiveMember(u) &&
          (u.accountStatus || 'active') !== 'deactivated' &&
          (u.networkStatus || 'out') === 'joined' &&
          (hit(u.firstName) || hit(u.lastName) || hit(`${u.firstName} ${u.lastName}`))
        )
        .slice(0, 15)
        .map(u => ({
          id: u.memberId,
          label: [u.firstName, u.lastName].filter(Boolean).join(' '),
          detail: `Member ${u.memberId}`,
          href: '/network.html',
        }));
  
      const groups = [
        { type: 'projects', label: 'Projects', items: projects },
        { type: 'members', label: 'Members', items: members },
        { type: 'companies', label: 'Companies', items: companies },
        { type: 'tenures', label: 'Tenure numbers', items: tenures },
        { type: 'commodities', label: 'Commodities', items: commodities },
        { type: 'counties', label: 'Counties', items: counties },
      ].filter(g => g.items.length);
  
      res.json({ query, groups, total: groups.reduce((n, g) => n + g.items.length, 0) });
    } catch (error) {
      console.error('search:', error.message);
      res.status(500).json({ error: 'Could not run the search.' });
    }
  });
  
  // A single project, with geometry, documents and photos. Defined after
  // /api/projects/map and /api/projects/filters so those literal paths win.
  app.get('/api/projects/:id', requireMemberApi, async (req, res) => {
    try {
      const records = await visibleProjectRecords(req.user, { includeGeometry: true });
      const project = records.find(p => p.id === req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found.' });
  
      res.json({
        project,
        timeline: await portal.listProjectTimeline(project.id),
        canEdit: !!(isAdmin(req.user) || project.ownedByViewer),
      });
    } catch (error) {
      console.error('project detail:', error.message);
      res.status(500).json({ error: 'Could not load the project.' });
    }
  });
  
  app.get('/api/network/members', requireMemberApi, async (req, res) => {
    try {
      const users = await listUsers();
      const allProjects = await listProjects();
      const projectsByMember = new Map();
  
      for (const project of allProjects) {
        if (!project.memberId) continue;
        if (!projectsByMember.has(project.memberId)) projectsByMember.set(project.memberId, []);
        projectsByMember.get(project.memberId).push(project);
      }
  
      const currentUserJoined = (req.user.networkStatus || 'out') === 'joined';
      const currentUserVisibility = parseNetworkVisibility(req.user.networkVisibility);
      const members = users
        .filter(user =>
          isActiveMember(user) &&
          (user.accountStatus || 'active') !== 'deactivated' &&
          (user.networkStatus || 'out') === 'joined'
        )
        .map(user => {
          const projectSummary = networkProjectSummary(projectsByMember.get(user.memberId) || []);
          return applyNetworkVisibility({
            memberId: user.memberId,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            phone: user.phone,
            memberSince: user.memberSince,
            isCurrentUser: user.memberId === req.user.memberId,
            profile: publicProfile(user.profile),
            ...projectSummary,
          }, user.networkVisibility);
        })
        .sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`));
  
      res.json({ joined: currentUserJoined, visibility: currentUserVisibility, members });
    } catch (error) {
      console.error('network members:', error.message);
      res.status(500).json({ error: 'Could not load members.' });
    }
  });
  
  app.post('/api/network/join', requireMemberApi, async (req, res) => {
    try {
      const visibility = req.body && req.body.visibility
        ? serializeNetworkVisibility(req.body.visibility)
        : serializeNetworkVisibility(req.user.networkVisibility || DEFAULT_NETWORK_VISIBILITY);
      await updateMembership(req.user.email, { networkStatus: 'joined', networkVisibility: visibility });
      invalidateSessionUser(req.user.email);
      res.json({ ok: true });
    } catch (error) {
      console.error('network join:', error.message);
      res.status(500).json({ error: 'Could not join the network.' });
    }
  });
  
  app.post('/api/network/preferences', requireMemberApi, async (req, res) => {
    try {
      const visibility = cleanNetworkVisibility(req.body && req.body.visibility);
      await updateMembership(req.user.email, { networkVisibility: serializeNetworkVisibility(visibility) });
      invalidateSessionUser(req.user.email);
      res.json({ ok: true, visibility });
    } catch (error) {
      console.error('network preferences:', error.message);
      res.status(500).json({ error: 'Could not save network preferences.' });
    }
  });
  
  app.post('/api/network/leave', requireMemberApi, async (req, res) => {
    try {
      await updateMembership(req.user.email, { networkStatus: 'out' });
      invalidateSessionUser(req.user.email);
      res.json({ ok: true });
    } catch (error) {
      console.error('network leave:', error.message);
      res.status(500).json({ error: 'Could not leave the network.' });
    }
  });
}

module.exports = { registerProjectBrowseRoutes };
