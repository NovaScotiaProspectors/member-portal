const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { registerPageRoutes } = require('./routes/pages');
const { registerTenureRoutes } = require('./routes/tenure');
const { normalizeTenure, fetchTenureGeoJSON } = require('./services/novaRoc');
const { createMineralOccurrenceService } = require('./services/mineralOccurrences');
const { registerMineralOccurrenceRoutes } = require('./routes/mineralOccurrences');
const { createMetalPriceService } = require('./services/metalPrices');
const { registerPriceRoutes } = require('./routes/prices');
const { createBackupService } = require('./services/backups');
const { registerBackupRoutes } = require('./routes/backups');
const { registerContentRoutes } = require('./routes/content');
const { registerPortalRoutes } = require('./routes/portal');
const { registerProjectBrowseRoutes } = require('./routes/projectBrowse');
const { registerAuthRoutes } = require('./routes/auth');
const { registerClaimRoutes } = require('./routes/claims');
const { registerOptionRoutes } = require('./routes/options');
const { registerProfileRoutes } = require('./routes/profile');
const { registerMembershipRoutes } = require('./routes/membership');
const { registerAdminRoutes } = require('./routes/admin');
const { clampInt } = require('./utils/numbers');

const ROOT_DIR = path.resolve(__dirname, '..');

loadEnvFile(path.join(ROOT_DIR, '.env'));

const portal = require('./db');
const geo = require('./geo');
const claimwatch = require('./claimwatch');
const backup = require('./backup');
const supabase = require('./supabase');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const SRC_DIR = path.join(PUBLIC_DIR, 'src');
const PAGES_DIR = path.join(SRC_DIR, 'pages');
const MODULES_DIR = path.join(SRC_DIR, 'modules');
const STYLES_DIR = path.join(SRC_DIR, 'styles');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, 'data'));
const REFERENCE_DIR = path.join(ROOT_DIR, 'data', 'reference');
const DATA_DRIVER = supabase.dataDriver();
const USE_SUPABASE = DATA_DRIVER === 'supabase';
const mineralOccurrences = createMineralOccurrenceService({ geojsonPath: path.join(REFERENCE_DIR, 'mineral-occurrences.geojson') });

const tempPathFor = target => `${target}.${process.pid}.tmp`;

async function writeWorkbookAtomic(wb, target) {
  const tmp = tempPathFor(target);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await wb.xlsx.writeFile(tmp);
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
}

async function writeFileAtomic(target, contents) {
  const tmp = tempPathFor(target);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(tmp, contents);
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
}

// ── Auth / payments config (put secrets in .env) ──────────────────────────
const SESSION_SECRET         = process.env.SESSION_SECRET         || 'test-session';

/* Validate production security and URL configuration during startup. */
if (IS_PRODUCTION) {
  const problems = [];
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'test-session') {
    problems.push('SESSION_SECRET must be set to a long random value (sessions can be forged without it)');
  }
  if (!process.env.APP_BASE_URL) {
    problems.push('APP_BASE_URL must be set to the public site URL (email links break without it)');
  }
  if (DATA_DRIVER === 'supabase' && !supabase.isConfigured()) {
    problems.push('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set when DATA_DRIVER=supabase');
  }
  if (problems.length) {
    console.error('Refusing to start in production:');
    problems.forEach(p => console.error(`  • ${p}`));
    process.exit(1);
  }
}
const ZEFFY_STUDENT_URL      = process.env.ZEFFY_STUDENT_URL      || '';
const ZEFFY_REGULAR_URL      = process.env.ZEFFY_REGULAR_URL      || '';
const APP_BASE_URL           = process.env.APP_BASE_URL           || `http://localhost:${PORT}`;
const WIX_SITE_URL           = process.env.WIX_SITE_URL           || '';
const WIX_MEMBER_LOGIN_URL   = process.env.WIX_MEMBER_LOGIN_URL   || '';
const OPENAI_API_KEY         = process.env.OPENAI_API_KEY         || '';
const OPENAI_MODEL           = process.env.OPENAI_MODEL           || 'gpt-5.6-luna';
const STUDENT_EMAIL_DOMAINS  = (process.env.STUDENT_EMAIL_DOMAINS || '')
  .split(',')
  .map(d => d.trim().toLowerCase().replace(/^@/, ''))
  .filter(Boolean);
// Comma-separated staff emails allowed into the admin view.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

/* Behind a hosting proxy, TLS is terminated at the edge and the app is spoken
   to over plain HTTP. Trusting the first hop makes req.secure and req.ip
   reflect the original request, which secure cookies depend on. */
if (IS_PRODUCTION) app.set('trust proxy', 1);

app.use(cookieParser(SESSION_SECRET));

app.use(express.json({ limit: '50mb' })); // raised limit for multiple GeoJSON payloads
app.use(attachUser);

// Member-only APIs (the project-form data). Metal prices are public so guests
// can browse them without an account.
app.use(['/api/tenure', '/api/commodities', '/api/deposit-types'], requireMemberApi);

// Portal features (notifications, favourites, events, resources, activity feed)
// are member benefits. Admin-only management lives under /api/admin/*.
app.use(
  ['/api/notifications', '/api/favorites', '/api/events', '/api/resources', '/api/activity'],
  requireMemberApi
);

registerPageRoutes(app, {
  publicDir: PUBLIC_DIR,
  pagesDir: PAGES_DIR,
  modulesDir: MODULES_DIR,
  stylesDir: STYLES_DIR,
  useSupabase: USE_SUPABASE,
  dataDriver: DATA_DRIVER,
  dataDir: DATA_DIR,
  supabase,
  requireMemberPage,
  requireAdminPage,
});

function parseAdminTenureNumbers(value) {
  return String(value || '')
    .split(/[\s,;]+/)
    .map(normalizeTenure)
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index)
    .slice(0, 25);
}

function loadEnvFile(filePath) {
  let text;
  try {
    text = require('fs').readFileSync(filePath, 'utf8');
  } catch {
    return;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (!key || process.env[key] !== undefined) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

registerTenureRoutes(app);

const PROJECTS_XLSX = path.join(DATA_DIR, 'projects.xlsx');
const PROJECT_HEADERS = [
  'Project ID',
  'Timestamp',
  'Member ID',
  'First Name',
  'Last Name',
  'Email',
  'Phone',
  'Project Name',
  'Operator',
  'Tenure Numbers',
  'Commodities',
  'Deposit Types',
  'Project Stage',
  'Resource Estimate',
  'Resource Source',
  'Website',
  'Status',
  'Documents',
  'Review Note',
  'Reviewed By',
  'Reviewed At',
  'Archived',
];
const PROJECT_ID_COL = 1;
const PROJECT_STATUS_COL = 17;
const PROJECT_DOCUMENTS_COL = 18;
const PROJECT_REVIEW_NOTE_COL = 19;
const PROJECT_REVIEWED_BY_COL = 20;
const PROJECT_REVIEWED_AT_COL = 21;
const PROJECT_ARCHIVED_COL = 22;

async function getProjectsSheet() {
  const wb = new ExcelJS.Workbook();
  try {
    await fs.access(PROJECTS_XLSX);
    await wb.xlsx.readFile(PROJECTS_XLSX);
  } catch {
    /* no file yet — fresh workbook */
  }

  let ws = wb.getWorksheet('Projects');
  if (!ws) {
    ws = wb.addWorksheet('Projects');
  }
  ensureProjectsSheetSchema(ws);
  return { wb, ws };
}

function ensureProjectsSheetSchema(ws) {
  const headerRow = ws.getRow(1);
  PROJECT_HEADERS.forEach((header, i) => {
    headerRow.getCell(i + 1).value = header;
    headerRow.getCell(i + 1).font = { bold: true };
  });

  for (let rowNumber = 2; rowNumber <= ws.rowCount; rowNumber++) {
    const row = ws.getRow(rowNumber);
    if (!cellText(row.getCell(PROJECT_ID_COL))) {
      row.getCell(PROJECT_ID_COL).value = nextProjectId(ws);
    }
    const mid = cellText(row.getCell(3));
    if (mid && /[^0-9]/.test(mid)) row.getCell(3).value = toNumericId(mid); // migrate NSPA- links
    if (!cellText(row.getCell(PROJECT_STATUS_COL))) {
      row.getCell(PROJECT_STATUS_COL).value = 'Pending';
    }
  }

  ws.columns = [
    { key: 'projectId', width: 16 },
    { key: 'timestamp', width: 24 },
    { key: 'memberId', width: 16 },
    { key: 'firstName', width: 18 },
    { key: 'lastName', width: 18 },
    { key: 'email', width: 28 },
    { key: 'phone', width: 20 },
    { key: 'projectName', width: 26 },
    { key: 'operator', width: 26 },
    { key: 'tenureNumbers', width: 34 },
    { key: 'commodities', width: 34 },
    { key: 'depositTypes', width: 34 },
    { key: 'projectStage', width: 18 },
    { key: 'resourceEstimate', width: 42 },
    { key: 'resourceSource', width: 28 },
    { key: 'website', width: 32 },
    { key: 'status', width: 14 },
    { key: 'documents', width: 44 },
    { key: 'reviewNote', width: 52 },
    { key: 'reviewedBy', width: 24 },
    { key: 'reviewedAt', width: 24 },
    { key: 'archived', width: 12 },
  ];
}

function nextProjectId(ws) {
  let max = 0;
  for (let rowNumber = 2; rowNumber <= ws.rowCount; rowNumber++) {
    const raw = cellText(ws.getRow(rowNumber).getCell(PROJECT_ID_COL));
    const match = raw.match(/^PRJ-(\d+)$/i);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `PRJ-${String(max + 1).padStart(5, '0')}`;
}

function listText(value) {
  if (!Array.isArray(value)) return value ? String(value) : '';
  return value.map(item => {
    if (item && typeof item === 'object') return item.tenureNumber || item.label || item.value || '';
    return String(item || '');
  }).filter(Boolean).join(', ');
}

async function appendProjectToSheet(submission) {
  if (USE_SUPABASE) return appendProjectToSupabase(submission);

  const { wb, ws } = await getProjectsSheet();
  const projectId = nextProjectId(ws);

  ws.addRow([
    projectId,
    submission.createdAt,
    submission.memberId || submission.memberID || '',
    submission.firstName || '',
    submission.lastName || '',
    submission.email || '',
    submission.phone || '',
    submission.project || '',
    submission.operator || '',
    listText(submission.tenures),
    listText(submission.commodities),
    listText(submission.depositTypes),
    submission.projectStage || '',
    submission.resourceEstimate || '',
    submission.resourceSource || '',
    submission.website || '',
    submission.status || 'Pending',
    documentsCellText(submission.documents),
  ]);

  await fs.mkdir(path.dirname(PROJECTS_XLSX), { recursive: true });
  await writeWorkbookAtomic(wb, PROJECTS_XLSX);
  invalidateProjectsCache();
  return projectId;
}

function supabaseProjectToRow(project) {
  return {
    id: project.id || '',
    createdAt: project.created_at || '',
    memberId: project.member_id || '',
    firstName: project.first_name || '',
    lastName: project.last_name || '',
    email: project.email || '',
    phone: project.phone || '',
    title: project.title || '',
    operator: project.operator || '',
    tenures: project.tenures_text || '',
    commodities: project.commodities_text || '',
    depositTypes: project.deposit_types_text || '',
    projectStage: project.project_stage || '',
    resourceEstimate: project.resource_estimate || '',
    resourceSource: project.resource_source || '',
    website: project.website || '',
    status: project.status || 'Pending',
    reviewNote: project.review_note || '',
    reviewedBy: project.reviewed_by || '',
    reviewedAt: project.reviewed_at || '',
    archived: !!project.archived,
  };
}

function submissionToProjectRow(submission, id = submission.id) {
  return {
    id,
    created_at: submission.createdAt || new Date().toISOString(),
    member_id: submission.memberId || submission.memberID || '',
    first_name: submission.firstName || '',
    last_name: submission.lastName || '',
    email: submission.email || '',
    phone: submission.phone || '',
    title: submission.project || submission.title || '',
    operator: submission.operator || '',
    tenures_text: listText(submission.tenures),
    commodities_text: listText(submission.commodities),
    deposit_types_text: listText(submission.depositTypes),
    project_stage: submission.projectStage || '',
    resource_estimate: submission.resourceEstimate || '',
    resource_source: submission.resourceSource || '',
    website: submission.website || '',
    status: submission.status || 'Pending',
    documents_text: documentsCellText(submission.documents),
    archived: false,
  };
}

async function nextSupabaseProjectId() {
  const rows = await supabase.select('projects', 'select=id&order=id.desc&limit=1');
  const current = rows && rows[0] && String(rows[0].id || '').match(/^PRJ-(\d+)$/i);
  const next = current ? Number(current[1]) + 1 : 1;
  return `PRJ-${String(next).padStart(5, '0')}`;
}

async function appendProjectToSupabase(submission) {
  const projectId = await nextSupabaseProjectId();
  await supabase.insert('projects', submissionToProjectRow(submission, projectId), {
    upsert: true,
    onConflict: 'id',
  });
  invalidateProjectsCache();
  return projectId;
}

/* ── Additional documents: upload storage + validation ──────────────────── */

const SUBMISSIONS_PATH = path.join(DATA_DIR, 'submissions.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DOCUMENT_ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.jpg', '.jpeg', '.png'];
const DOCUMENT_MAX_MB = Number(process.env.DOCUMENT_MAX_MB || 25);
const DOCUMENT_MAX_SIZE = DOCUMENT_MAX_MB * 1024 * 1024;
const DOCUMENT_MAX_COUNT = 10;

let submissionsWriteChain = Promise.resolve();

// submissions.json carries the tenure polygons, so it is by far the largest
// file here and the map endpoint re-parses it on every request. Same
// short-TTL cache treatment as the project sheet.
const SUBMISSIONS_CACHE_TTL = 20 * 1000;
let submissionsCache = null;

async function readSubmissions() {
  if (submissionsCache && Date.now() - submissionsCache.at < SUBMISSIONS_CACHE_TTL) {
    return submissionsCache.rows;
  }
  if (USE_SUPABASE) {
    const rows = await supabase.select('project_submissions', 'select=id,payload,created_at&order=created_at.desc');
    const submissions = rows.map(row => ({ id: row.id, ...(row.payload || {}) }));
    submissionsCache = { rows: submissions, at: Date.now() };
    return submissions;
  }
  let rows;
  try {
    rows = JSON.parse(await fs.readFile(SUBMISSIONS_PATH, 'utf8'));
  } catch {
    rows = [];
  }
  submissionsCache = { rows, at: Date.now() };
  return rows;
}

async function writeSubmissions(submissions) {
  if (USE_SUPABASE) {
    const rows = submissions.map(submission => ({
      id: submission.id,
      payload: submission,
      created_at: submission.createdAt || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
    if (rows.length) {
      await supabase.insert('project_submissions', rows, { upsert: true, onConflict: 'id' });
    }
    submissionsCache = { rows: submissions, at: Date.now() };
    return;
  }
  try {
    await fs.mkdir(path.dirname(SUBMISSIONS_PATH), { recursive: true });
    await writeFileAtomic(SUBMISSIONS_PATH, JSON.stringify(submissions, null, 2));
    submissionsCache = { rows: submissions, at: Date.now() };
  } catch (error) {
    // Reset cache after a failed write because callers may mutate the array.
    submissionsCache = null;
    throw error;
  }
}

// Files land in a temp dir on disk (not memory) and are moved into local
// storage or uploaded to Supabase once the project ID is issued.
// Multer removes its own temp files when a request errors mid-upload.
const UPLOAD_TMP_DIR = path.join(UPLOADS_DIR, '.tmp');

const documentUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      require('fs').mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
      cb(null, UPLOAD_TMP_DIR);
    },
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`),
  }),
  limits: { fileSize: DOCUMENT_MAX_SIZE, files: DOCUMENT_MAX_COUNT },
});

function discardUploadedFiles(files) {
  for (const file of files || []) {
    if (file && file.path) fs.unlink(file.path).catch(() => {});
  }
}

function describeUploadError(err) {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return `Each document must be ${DOCUMENT_MAX_SIZE / (1024 * 1024)} MB or smaller.`;
  }
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
    return `You can upload at most ${DOCUMENT_MAX_COUNT} documents per project.`;
  }
  return 'Could not process the uploaded documents.';
}

function documentValidationError(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!DOCUMENT_ALLOWED_EXTENSIONS.includes(ext)) {
    return `"${file.originalname}" is not an accepted file type. Accepted formats: PDF, DOC, DOCX, XLS, XLSX, CSV, JPG, PNG.`;
  }
  if (file.size === 0) {
    return `"${file.originalname}" is empty.`;
  }
  return null;
}

function safeDocumentFileName(name) {
  const base = path.basename(String(name || 'document'));
  const cleaned = base.replace(/[^\w.\- ]+/g, '_').slice(-120);
  return cleaned || 'document';
}

// Accepts either a plain JSON submission (no documents) or multipart/form-data
// with a `payload` JSON field, `documents` files, and a `documentTitles` JSON
// array aligned with the files.
function parseProjectSubmission(req, res, next) {
  if (!req.is('multipart/form-data')) {
    req.projectPayload = req.body || {};
    req.documentFiles = [];
    req.documentTitles = [];
    return next();
  }

  documentUpload.array('documents', DOCUMENT_MAX_COUNT)(req, res, err => {
    if (err) return res.status(400).json({ error: describeUploadError(err) });

    try {
      req.projectPayload = req.body.payload ? JSON.parse(req.body.payload) : {};
    } catch {
      discardUploadedFiles(req.files);
      return res.status(400).json({ error: 'Invalid project payload.' });
    }

    try {
      const titles = req.body.documentTitles ? JSON.parse(req.body.documentTitles) : [];
      req.documentTitles = Array.isArray(titles) ? titles.map(t => String(t || '').trim().slice(0, 200)) : [];
    } catch {
      req.documentTitles = [];
    }

    req.documentFiles = req.files || [];
    const invalid = req.documentFiles.map(documentValidationError).find(Boolean);
    if (invalid) {
      discardUploadedFiles(req.documentFiles);
      return res.status(400).json({ error: invalid });
    }

    next();
  });
}

// Build the metadata records up front (before the project ID exists) so the
// spreadsheet row can include them; the temp files are moved into place after
// the ID has been issued.
function buildDocumentRecords(files, titles) {
  return files.map((file, i) => ({
    meta: {
      id: crypto.randomBytes(8).toString('hex'),
      fileName: file.originalname || 'document',
      title: titles[i] || '',
      size: file.size,
      mimeType: file.mimetype || '',
      storedName: '',
      uploadedAt: new Date().toISOString(),
    },
    tempPath: file.path,
  })).map(record => {
    record.meta.storedName = `${record.meta.id}__${safeDocumentFileName(record.meta.fileName)}`;
    return record;
  });
}

async function writeDocumentFiles(projectId, records) {
  if (!records.length) return;
  if (USE_SUPABASE) {
    for (const record of records) {
      await supabase.uploadFile(
        `projects/${projectId}/${record.meta.storedName}`,
        record.tempPath,
        record.meta.mimeType || 'application/octet-stream'
      );
      await fs.unlink(record.tempPath).catch(() => {});
    }
    return;
  }
  const dir = path.join(UPLOADS_DIR, projectId);
  await fs.mkdir(dir, { recursive: true });
  for (const record of records) {
    await fs.rename(record.tempPath, path.join(dir, record.meta.storedName));
  }
}

function documentsCellText(documents) {
  return (documents || [])
    .map(d => (d.title ? `${d.fileName} (${d.title})` : d.fileName))
    .join(', ');
}

// What the client is allowed to see about a stored document.
function publicDocument(doc) {
  return {
    id: doc.id,
    fileName: doc.fileName,
    title: doc.title || '',
    size: doc.size,
    uploadedAt: doc.uploadedAt,
  };
}

async function doSetProjectDocumentsCell(projectId, text) {
  if (USE_SUPABASE) {
    const updated = await supabase.update('projects', supabase.eq('id', projectId), { documents_text: text });
    invalidateProjectsCache();
    return !!(updated && updated.length);
  }

  const { wb, ws } = await getProjectsSheet();
  let updated = false;
  ws.eachRow((row, n) => {
    if (n === 1 || updated) return;
    if (cellText(row.getCell(PROJECT_ID_COL)) === projectId) {
      row.getCell(PROJECT_DOCUMENTS_COL).value = text;
      updated = true;
    }
  });
  if (updated) {
    await writeWorkbookAtomic(wb, PROJECTS_XLSX);
    invalidateProjectsCache();
  }
  return updated;
}

function setProjectDocumentsCell(projectId, text) {
  const run = projectsWriteChain.catch(() => {}).then(() => doSetProjectDocumentsCell(projectId, text));
  projectsWriteChain = run.catch(() => {});
  return run;
}

async function saveProjectSubmission({ owner, actor, payload, documentRecords = [], status = 'Pending', activityType = 'project_submitted' }) {
  const submission = {
    id: '',
    createdAt: new Date().toISOString(),
    ...payload,
    firstName: owner.firstName || '',
    lastName: owner.lastName || '',
    email: owner.email || '',
    phone: owner.phone || '',
    memberId: owner.memberId,
    status,
    documents: documentRecords.map(record => record.meta),
  };

  submission.id = await appendProjectToSheet(submission);
  await writeDocumentFiles(submission.id, documentRecords);

  const submissions = await readSubmissions();
  submissions.push(submission);
  await writeSubmissions(submissions);

  const title = submission.project || submission.title || 'Untitled project';
  const who = memberDisplayName(actor);
  safely('activity submitted', async () => {
    await portal.recordActivity({
      type: activityType,
      actorMemberId: actor && actor.memberId,
      actorName: who,
      projectId: submission.id,
      projectTitle: title,
      summary: activityType === 'admin_project_created'
        ? `${who} created "${title}" for ${memberDisplayName(owner)}`
        : `${who} submitted "${title}"`,
    });
    if (documentRecords.length) {
      await portal.recordActivity({
        type: 'documents_added',
        actorMemberId: actor && actor.memberId,
        actorName: who,
        projectId: submission.id,
        projectTitle: title,
        summary: `${documentRecords.length} document${documentRecords.length === 1 ? '' : 's'} added to "${title}"`,
      });
    }
  });

  notifyAdjacentHolders(submission)
    .catch(error => console.warn('adjacency notify:', error.message));

  return submission;
}

app.post('/api/projects', requireMemberApi, parseProjectSubmission, async (req, res) => {
  const doSubmit = async () => {
    // payload.tenures is an array of { tenureNumber, geojson }.
    // Attribute the project to the signed-in member (authoritative) with an
    // initial "Pending" status; the form fields carry the rest.
    const documentRecords = buildDocumentRecords(req.documentFiles, req.documentTitles);
    const submission = await saveProjectSubmission({
      owner: req.user,
      actor: req.user,
      payload: req.projectPayload,
      documentRecords,
    });

    res.status(201).json({ ok: true, id: submission.id });
  };

  const run = submissionsWriteChain.catch(() => {}).then(doSubmit);
  submissionsWriteChain = run.catch(() => {});

  try {
    await run;
  } catch (error) {
    console.error(error);
    discardUploadedFiles(req.documentFiles); // any temp files not yet moved into place
    if (!res.headersSent) res.status(500).json({ error: 'Could not save project submission.' });
  }
});

/* ── Edit and resubmit a rejected project ───────────────────────────────── */

// Fields the owner may change when reworking a project. Tenures, ownership and
// status are deliberately excluded — geometry is confirmed on the form, and
// status is the reviewers' to set.
const EDITABLE_PROJECT_FIELDS = [
  'project', 'operator', 'description', 'commodities', 'depositTypes',
  'projectStage', 'resourceEstimate', 'resourceSource', 'website',
];

app.put('/api/projects/:id', requireMemberApi, async (req, res) => {
  const run = submissionsWriteChain.catch(() => {}).then(async () => {
    const submissions = await readSubmissions();
    const submission = submissions.find(s => s.id === req.params.id);
    if (!submission) return res.status(404).json({ error: 'Project not found.' });

    const owns = submission.memberId === req.user.memberId;
    if (!owns && !isAdmin(req.user)) {
      return res.status(403).json({ error: 'You can only edit your own projects.' });
    }

    const rows = await listProjects();
    const row = rows.find(p => p.id === submission.id);
    const status = row ? row.status : 'Pending';
    const resubmit = !!req.body.resubmit;

    // Members may only rework a project the reviewers sent back.
    if (owns && !isAdmin(req.user) && !RESUBMITTABLE_STATUSES.includes(status)) {
      return res.status(409).json({
        error: `This project is "${status}" and can't be edited right now.`,
      });
    }

    for (const field of EDITABLE_PROJECT_FIELDS) {
      if (req.body[field] === undefined) continue;
      submission[field] = Array.isArray(req.body[field])
        ? req.body[field].map(v => clampText(v, 120)).filter(Boolean)
        : clampText(req.body[field], 4000);
    }
    submission.updatedAt = new Date().toISOString();

    await writeSubmissions(submissions);
    await syncProjectRow(submission);

    if (resubmit) {
      await setProjectStatus(submission.id, 'Resubmitted', {
        note: '',
        reviewer: '',
        at: new Date().toISOString(),
      });
      safely('activity resubmit', () =>
        portal.recordActivity({
          type: 'project_resubmitted',
          actorName: memberDisplayName(req.user),
          projectId: submission.id,
          projectTitle: submission.project || submission.id,
          summary: `Project "${submission.project || submission.id}" was updated and resubmitted for review`,
        })
      );
    } else {
      safely('activity edit', () =>
        portal.recordActivity({
          type: 'project_status_changed',
          actorName: memberDisplayName(req.user),
          projectId: submission.id,
          projectTitle: submission.project || submission.id,
          summary: 'Project details were updated',
        })
      );
    }

    res.json({ ok: true, resubmitted: resubmit });
  });

  submissionsWriteChain = run.catch(() => {});
  try {
    await run;
  } catch (error) {
    console.error('project update:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not save your changes.' });
  }
});

// Mirror edited fields back into projects.xlsx so the sheet stays the record.
async function doSyncProjectRow(submission) {
  if (USE_SUPABASE) {
    const updated = await supabase.update('projects', supabase.eq('id', submission.id), {
      title: submission.project || '',
      operator: submission.operator || '',
      commodities_text: listText(submission.commodities),
      deposit_types_text: listText(submission.depositTypes),
      project_stage: submission.projectStage || '',
      resource_estimate: submission.resourceEstimate || '',
      resource_source: submission.resourceSource || '',
      website: submission.website || '',
    });
    invalidateProjectsCache();
    return !!(updated && updated.length);
  }

  const { wb, ws } = await getProjectsSheet();
  let updated = false;
  ws.eachRow((row, n) => {
    if (n === 1 || updated) return;
    if (cellText(row.getCell(PROJECT_ID_COL)) !== submission.id) return;
    row.getCell(8).value = submission.project || '';
    row.getCell(9).value = submission.operator || '';
    row.getCell(11).value = listText(submission.commodities);
    row.getCell(12).value = listText(submission.depositTypes);
    row.getCell(13).value = submission.projectStage || '';
    row.getCell(14).value = submission.resourceEstimate || '';
    row.getCell(15).value = submission.resourceSource || '';
    row.getCell(16).value = submission.website || '';
    updated = true;
  });
  if (updated) {
    await writeWorkbookAtomic(wb, PROJECTS_XLSX);
    invalidateProjectsCache();
  }
  return updated;
}

function syncProjectRow(submission) {
  const run = projectsWriteChain.catch(() => {}).then(() => doSyncProjectRow(submission));
  projectsWriteChain = run.catch(() => {});
  return run;
}

async function findSubmissionDocument(projectId, docId) {
  const submissions = await readSubmissions();
  const submission = submissions.find(s => s.id === projectId) || null;
  const document = submission && Array.isArray(submission.documents)
    ? submission.documents.find(d => d.id === docId) || null
    : null;
  return { submissions, submission, document };
}

function canAccessSubmission(user, submission) {
  return submission.memberId === user.memberId || isAdmin(user);
}

// Download a project document (owner or admin). Member-gated by the
// '/api/projects' mount of requireMemberApi above.
app.get('/api/projects/:id/documents/:docId/download', requireMemberApi, async (req, res) => {
  try {
    const { submission, document } = await findSubmissionDocument(req.params.id, req.params.docId);
    if (!submission || !document) return res.status(404).json({ error: 'Document not found.' });
    if (!canAccessSubmission(req.user, submission)) {
      return res.status(403).json({ error: 'You can only access documents on your own projects.' });
    }

    if (USE_SUPABASE) {
      const data = await supabase.downloadObject(`projects/${submission.id}/${document.storedName}`);
      res.setHeader('Content-Type', document.mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${safeDocumentFileName(document.fileName || 'document')}"`);
      return res.send(data);
    }

    const filePath = path.resolve(UPLOADS_DIR, submission.id, document.storedName);
    if (!filePath.startsWith(UPLOADS_DIR + path.sep)) {
      return res.status(400).json({ error: 'Invalid document path.' });
    }

    res.download(filePath, document.fileName || 'document', err => {
      if (err && !res.headersSent) {
        res.status(404).json({ error: 'The document file is missing on the server.' });
      }
    });
  } catch (error) {
    console.error('document download:', error.message);
    res.status(500).json({ error: 'Could not download the document.' });
  }
});

// Inline image view, for the project gallery. The /download route sets
// Content-Disposition: attachment, which stops a browser rendering it in an
// <img>, so images get their own route.
//
// Inline rendering is limited to safe image types with explicit Content-Type
// and nosniff headers.
const INLINE_IMAGE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

app.get('/api/projects/:id/documents/:docId/view', requireMemberApi, async (req, res) => {
  try {
    const { submission, document } = await findSubmissionDocument(req.params.id, req.params.docId);
    if (!submission || !document) return res.status(404).json({ error: 'Document not found.' });
    if (!canAccessSubmission(req.user, submission)) {
      return res.status(403).json({ error: 'You can only access documents on your own projects.' });
    }

    const contentType = INLINE_IMAGE_TYPES[path.extname(document.fileName || '').toLowerCase()];
    if (!contentType) {
      return res.status(415).json({ error: 'Only images can be viewed inline.' });
    }

    if (USE_SUPABASE) {
      const data = await supabase.downloadObject(`projects/${submission.id}/${document.storedName}`);
      res.type(contentType);
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.send(data);
    }

    const filePath = path.resolve(UPLOADS_DIR, submission.id, document.storedName);
    if (!filePath.startsWith(UPLOADS_DIR + path.sep)) {
      return res.status(400).json({ error: 'Invalid document path.' });
    }

    res.type(contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.sendFile(filePath, err => {
      if (err && !res.headersSent) {
        res.status(404).json({ error: 'The image is missing on the server.' });
      }
    });
  } catch (error) {
    console.error('document view:', error.message);
    res.status(500).json({ error: 'Could not load the image.' });
  }
});

// Remove a document from a project (owner or admin). Deletes the stored file
// and the metadata, and refreshes the project document summary.
app.delete('/api/projects/:id/documents/:docId', requireMemberApi, async (req, res) => {
  const doDelete = async () => {
    const { submissions, submission, document } = await findSubmissionDocument(req.params.id, req.params.docId);
    if (!submission || !document) {
      return res.status(404).json({ error: 'Document not found.' });
    }
    if (!canAccessSubmission(req.user, submission)) {
      return res.status(403).json({ error: 'You can only remove documents from your own projects.' });
    }

    submission.documents = submission.documents.filter(d => d.id !== document.id);
    await writeSubmissions(submissions);

    if (USE_SUPABASE) {
      await supabase.deleteObject(`projects/${submission.id}/${document.storedName}`).catch(e => {
        console.warn('document delete object:', e.message);
      });
    } else {
      try {
        await fs.unlink(path.join(UPLOADS_DIR, submission.id, document.storedName));
      } catch (e) {
        if (e.code !== 'ENOENT') console.warn('document unlink:', e.message);
      }
    }

    await setProjectDocumentsCell(submission.id, documentsCellText(submission.documents));
    res.json({ ok: true, documents: submission.documents.map(publicDocument) });
  };

  const run = submissionsWriteChain.catch(() => {}).then(doDelete);
  submissionsWriteChain = run.catch(() => {});

  try {
    await run;
  } catch (error) {
    console.error('document delete:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not remove the document.' });
  }
});

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 10);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Commodities + Deposit Types — pulled live from the Google Sheet so the form
 * always reflects the latest sheet contents. The sheet must be shared as
 * "Anyone with the link can view" (or published to the web) for this to work.
 * ──────────────────────────────────────────────────────────────────────────── */

const SHEET_ID = process.env.NS_SHEET_ID || '1nKEhsUuQp2EkbPqtKopVd1YMe9tB7ACw';
const COMMODITIES_TAB = 'Commodities';
const DEPOSIT_TAB = 'Parent-Sub Deposit Types';
const SHEET_TTL_MS = 5 * 60 * 1000; // re-fetch at most every 5 minutes

// Minimal RFC-4180-ish CSV parser (handles quoted fields with commas/newlines).
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// Fetch a tab's rows as CSV via the gviz endpoint, which lets us request a tab
// by name — so the form keeps working even if tabs are reordered or recreated.
async function fetchTabRows(tabName) {
  const url =
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
    `?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Could not load tab "${tabName}" (HTTP ${res.status}). ` +
      'Make sure the sheet is shared as "Anyone with the link can view".'
    );
  }
  return parseCSV(await res.text());
}

async function loadCommodities() {
  const rows = await fetchTabRows(COMMODITIES_TAB);
  const list = [];
  for (const row of rows) {
    const value = (row[0] || '').trim();
    if (!value) continue;
    if (/^commodit(y|ies)$/i.test(value)) continue; // skip an optional header
    list.push(value);
  }
  return list;
}

async function loadDepositTypes() {
  const rows = await fetchTabRows(DEPOSIT_TAB);
  const groups = [];
  let current = null;
  let headerSkipped = false;

  for (const row of rows) {
    const parent = (row[0] || '').trim();
    const subtype = (row[1] || '').trim();

    if (!headerSkipped) {
      headerSkipped = true;
      if (/parent/i.test(parent) || /subtype/i.test(subtype)) continue; // header row
    }

    if (parent) {
      current = { parent, subtypes: [] };
      groups.push(current);
    }
    if (subtype && current) {
      current.subtypes.push({ value: slugify(subtype), label: subtype });
    }
  }

  // A parent category with no subtypes (e.g. "Unclassified / Undetermined
  // Deposit Type") becomes the standalone option shown beneath the dropdown.
  const realGroups = [];
  let undetermined = null;
  for (const g of groups) {
    if (g.subtypes.length === 0) {
      undetermined = { value: slugify(g.parent), label: g.parent };
    } else {
      realGroups.push(g);
    }
  }

  return { groups: realGroups, undetermined };
}

// Wrap an async loader with a TTL cache + in-flight de-duplication.
function withCache(loader, ttl) {
  let value = null;
  let time = 0;
  let pending = null;
  return async () => {
    if (value && Date.now() - time < ttl) return value;
    if (pending) return pending;
    pending = loader()
      .then(v => { value = v; time = Date.now(); pending = null; return v; })
      .catch(err => { pending = null; throw err; });
    return pending;
  };
}

const getCommodities = withCache(loadCommodities, SHEET_TTL_MS);
const getDepositTypes = withCache(loadDepositTypes, SHEET_TTL_MS);

registerOptionRoutes(app, { getCommodities, getDepositTypes });
registerMineralOccurrenceRoutes(app, { mineralOccurrences });

/* ────────────────────────────────────────────────────────────────────────────
 * Sign-up — user records stored in Supabase or appended to data/users.xlsx.
 * Passwords are hashed with scrypt; plaintext is never stored.
 * ──────────────────────────────────────────────────────────────────────────── */

const USERS_XLSX = path.join(DATA_DIR, 'users.xlsx');
const USER_HEADERS = [
  'Member ID', 'Timestamp', 'First Name', 'Last Name', 'Email', 'Phone', 'Password Hash',
  'Payment Customer ID', 'Payment Reference ID', 'Membership Status', 'Member Since', 'Account Status',
  'Membership Expiry', 'Network Status', 'Network Visibility', 'Profile',
];
const MEMBER_ID_COL = 1;
const EMAIL_COL = 5;
const PASSWORD_HASH_COL = 7;
const PAYMENT_CUSTOMER_COL = 8;
const SUBSCRIPTION_COL = 9;
const MEMBERSHIP_STATUS_COL = 10;
const MEMBER_SINCE_COL = 11;
const ACCOUNT_STATUS_COL = 12;
const MEMBERSHIP_EXPIRY_COL = 13;
const NETWORK_STATUS_COL = 14;
const NETWORK_VISIBILITY_COL = 15;
const PROFILE_COL = 16;

const DEFAULT_NETWORK_VISIBILITY = {
  email: true,
  phone: false,
  projects: true,
  tenures: true,
  commodities: true,
};

/* ── Member profile (stored as one JSON column in users.xlsx) ───────────── */

const PROFILE_SOCIAL_KEYS = ['website', 'linkedin', 'facebook', 'x'];
const DEFAULT_PROFILE = {
  bio: '',
  company: '',
  role: '',
  location: '',
  avatar: '',       // stored file name under data/uploads/avatars/
  socials: { website: '', linkedin: '', facebook: '', x: '' },
  expertise: [],
};

const clampText = (value, max) => String(value == null ? '' : value).trim().slice(0, max);

function parseProfile(value) {
  let parsed = {};
  try {
    parsed = value ? (typeof value === 'object' ? value : JSON.parse(String(value))) : {};
  } catch {
    parsed = {};
  }
  return cleanProfile(parsed, { keepAvatar: true });
}

// Normalises any input into a safe profile shape. Avatar is managed only by
// the upload endpoint, so PUT bodies can never point it at an arbitrary file.
function cleanProfile(input, { keepAvatar = false } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const socials = src.socials && typeof src.socials === 'object' ? src.socials : {};
  return {
    bio: clampText(src.bio, 600),
    company: clampText(src.company, 80),
    role: clampText(src.role, 80),
    location: clampText(src.location, 80),
    avatar: keepAvatar ? clampText(src.avatar, 160) : '',
    socials: Object.fromEntries(PROFILE_SOCIAL_KEYS.map(k => [k, clampText(socials[k], 200)])),
    expertise: (Array.isArray(src.expertise) ? src.expertise : [])
      .map(item => clampText(item, 40))
      .filter(Boolean)
      .slice(0, 10),
  };
}

function serializeProfile(profile) {
  return JSON.stringify(parseProfile(profile));
}

// The card-sized subset shown in the directory.
function publicProfile(profile) {
  const p = parseProfile(profile);
  return {
    bio: p.bio,
    company: p.company,
    role: p.role,
    location: p.location,
    expertise: p.expertise,
    socials: p.socials,
    hasAvatar: !!p.avatar,
  };
}

// All memberships expire on 31 December. New members who enrol on or after
// 1 July get the remainder of the current year at no additional cost — their
// payment is applied to the following membership year, so they expire on
// 31 December of NEXT year (e.g. joining 16 July 2026 runs through
// 31 December 2027). Renewals always expire 31 December of the current year.
function membershipExpiryDate({ newMember = false } = {}) {
  const now = new Date();
  let year = now.getFullYear();
  if (newMember && now.getMonth() >= 6) year += 1; // months are 0-based: 6 = July
  return new Date(Date.UTC(year, 11, 31, 23, 59, 59)).toISOString();
}

// Numbers-only member ID (5-digit, zero-padded). Extracts digits from any
// legacy value (e.g. "NSPA-00007" -> "00007") so old IDs migrate cleanly.
function toNumericId(raw) {
  const m = String(raw || '').match(/(\d+)/);
  return m ? String(Number(m[1])).padStart(5, '0') : '';
}

let usersWriteChain = Promise.resolve();

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  const [, salt, expectedHex] = parts;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);

  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function cellText(cell) {
  let value = cell && cell.value;
  if (value && typeof value === 'object' && 'text' in value) value = value.text;
  return value == null ? '' : String(value);
}

function parseNetworkVisibility(value) {
  let parsed = {};
  if (value && typeof value === 'object') {
    parsed = value;
  } else {
    try {
      parsed = value ? JSON.parse(String(value)) : {};
    } catch {
      parsed = {};
    }
  }

  return Object.fromEntries(
    Object.entries(DEFAULT_NETWORK_VISIBILITY).map(([key, fallback]) => [
      key,
      parsed[key] === undefined ? fallback : !!parsed[key],
    ])
  );
}

function cleanNetworkVisibility(value) {
  const parsed = parseNetworkVisibility(value || {});
  return Object.fromEntries(Object.keys(DEFAULT_NETWORK_VISIBILITY).map(key => [key, !!parsed[key]]));
}

function serializeNetworkVisibility(value) {
  return JSON.stringify(cleanNetworkVisibility(value));
}

async function getUsersSheet() {
  const wb = new ExcelJS.Workbook();
  try {
    await fs.access(USERS_XLSX);
    await wb.xlsx.readFile(USERS_XLSX);
  } catch {
    /* no file yet — fresh workbook */
  }

  let ws = wb.getWorksheet('Users');
  if (!ws) {
    ws = wb.addWorksheet('Users');
    ws.addRow(USER_HEADERS).font = { bold: true };
  }
  ensureUserSheetSchema(ws);
  return { wb, ws };
}

function ensureUserSheetSchema(ws) {
  const headerValues = ws.getRow(1).values.slice(1).map(String);
  if (headerValues[0] !== 'Member ID') {
    ws.spliceColumns(1, 0, []);
  }

  const headerRow = ws.getRow(1);
  USER_HEADERS.forEach((header, i) => {
    headerRow.getCell(i + 1).value = header;
    headerRow.getCell(i + 1).font = { bold: true };
  });

  for (let rowNumber = 2; rowNumber <= ws.rowCount; rowNumber++) {
    const row = ws.getRow(rowNumber);
    const rawId = cellText(row.getCell(MEMBER_ID_COL));
    if (!rawId) {
      row.getCell(MEMBER_ID_COL).value = nextMemberId(ws);
    } else if (/[^0-9]/.test(rawId)) {
      // Migrate legacy prefixed IDs (e.g. NSPA-00007) to numbers only.
      row.getCell(MEMBER_ID_COL).value = toNumericId(rawId);
    }
    if (!cellText(row.getCell(ACCOUNT_STATUS_COL))) {
      row.getCell(ACCOUNT_STATUS_COL).value = 'active';
    }
    // Existing active members expire on 31 December too.
    if (cellText(row.getCell(MEMBERSHIP_STATUS_COL)) === 'active' && !cellText(row.getCell(MEMBERSHIP_EXPIRY_COL))) {
      row.getCell(MEMBERSHIP_EXPIRY_COL).value = membershipExpiryDate();
    }
  }

  ws.columns = [
    { key: 'memberId', width: 16 },
    { key: 'timestamp', width: 24 },
    { key: 'firstName', width: 18 },
    { key: 'lastName', width: 18 },
    { key: 'email', width: 28 },
    { key: 'phone', width: 20 },
    { key: 'passwordHash', width: 76 },
    { key: 'paymentCustomerId', width: 22 },
    { key: 'subscriptionId', width: 26 },
    { key: 'membershipStatus', width: 18 },
    { key: 'memberSince', width: 24 },
    { key: 'accountStatus', width: 16 },
    { key: 'membershipExpiry', width: 24 },
    { key: 'networkStatus', width: 18 },
    { key: 'networkVisibility', width: 44 },
    { key: 'profile', width: 60 },
  ];
}

// Scans every row (including deactivated accounts) so numeric IDs are unique
// and never reassigned to a different person.
function nextMemberId(ws) {
  let max = 0;
  for (let rowNumber = 2; rowNumber <= ws.rowCount; rowNumber++) {
    const raw = cellText(ws.getRow(rowNumber).getCell(MEMBER_ID_COL));
    const match = raw.match(/(\d+)/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return String(max + 1).padStart(5, '0');
}

function emailExists(ws, email) {
  const lower = email.toLowerCase();
  let found = false;
  ws.eachRow((row, n) => {
    if (n === 1) return; // header
    const v = cellText(row.getCell(EMAIL_COL));
    if (v.toLowerCase() === lower) found = true;
  });
  return found;
}

async function findUserByEmail(email) {
  if (USE_SUPABASE) return findUserByEmailSupabase(email);

  const { ws } = await getUsersSheet();
  const lower = email.toLowerCase();
  let match = null;

  ws.eachRow((row, n) => {
    if (n === 1 || match) return;
    const rowEmail = cellText(row.getCell(EMAIL_COL));
    if (rowEmail.toLowerCase() !== lower) return;

    match = {
      memberId: cellText(row.getCell(MEMBER_ID_COL)),
      firstName: cellText(row.getCell(3)),
      lastName: cellText(row.getCell(4)),
      email: rowEmail,
      phone: cellText(row.getCell(6)),
      passwordHash: cellText(row.getCell(PASSWORD_HASH_COL)),
      paymentCustomerId: cellText(row.getCell(PAYMENT_CUSTOMER_COL)),
      subscriptionId: cellText(row.getCell(SUBSCRIPTION_COL)),
      membershipStatus: cellText(row.getCell(MEMBERSHIP_STATUS_COL)) || 'none',
      memberSince: cellText(row.getCell(MEMBER_SINCE_COL)),
      accountStatus: cellText(row.getCell(ACCOUNT_STATUS_COL)) || 'active',
      membershipExpiry: cellText(row.getCell(MEMBERSHIP_EXPIRY_COL)),
      networkStatus: cellText(row.getCell(NETWORK_STATUS_COL)) || 'out',
      networkVisibility: parseNetworkVisibility(cellText(row.getCell(NETWORK_VISIBILITY_COL))),
      profile: parseProfile(cellText(row.getCell(PROFILE_COL))),
    };
  });

  return match;
}

function supabaseMemberToUser(member) {
  if (!member) return null;
  return {
    memberId: member.member_id || '',
    createdAt: member.created_at || '',
    firstName: member.first_name || '',
    lastName: member.last_name || '',
    email: member.email || '',
    phone: member.phone || '',
    passwordHash: member.password_hash || '',
    paymentCustomerId: member.payment_customer_id || '',
    subscriptionId: member.subscription_id || '',
    membershipStatus: member.membership_status || 'none',
    memberSince: member.member_since || '',
    accountStatus: member.account_status || 'active',
    membershipExpiry: member.membership_expiry || '',
    networkStatus: member.network_status || 'out',
    networkVisibility: parseNetworkVisibility(member.network_visibility),
    profile: parseProfile(member.profile),
  };
}

async function findUserByEmailSupabase(email) {
  const lower = String(email || '').toLowerCase();
  const rows = await supabase.select('members', `${supabase.eq('email_lc', lower)}&limit=1`);
  return supabaseMemberToUser(rows[0]);
}

async function nextSupabaseMemberId() {
  const rows = await supabase.select('members', 'select=member_id&order=member_id.desc&limit=1');
  return String(Number((rows[0] && rows[0].member_id) || 0) + 1).padStart(5, '0');
}

async function doAppendUser(user) {
  if (USE_SUPABASE) {
    const existing = await findUserByEmailSupabase(user.email);
    if (existing) {
      const err = new Error('An account with that email already exists.');
      err.code = 'DUP';
      throw err;
    }
    const memberId = await nextSupabaseMemberId();
    await supabase.insert('members', {
      member_id: memberId,
      created_at: new Date().toISOString(),
      first_name: user.firstName,
      last_name: user.lastName,
      email: user.email,
      email_lc: String(user.email || '').toLowerCase(),
      phone: user.phone,
      password_hash: hashPassword(user.password),
      payment_customer_id: '',
      subscription_id: '',
      membership_status: 'none',
      member_since: null,
      account_status: 'active',
      membership_expiry: null,
      network_status: 'out',
      network_visibility: cleanNetworkVisibility(DEFAULT_NETWORK_VISIBILITY),
      profile: parseProfile(DEFAULT_PROFILE),
    });
    invalidateMemberStates();
    return memberId;
  }

  const { wb, ws } = await getUsersSheet();
  if (emailExists(ws, user.email)) {
    const err = new Error('An account with that email already exists.');
    err.code = 'DUP';
    throw err;
  }
  const memberId = nextMemberId(ws);
  invalidateMemberStates();
  ws.addRow([
    memberId,
    new Date().toISOString(),
    user.firstName,
    user.lastName,
    user.email,
    user.phone,
    hashPassword(user.password),
    '',        // Payment Customer ID
    '',        // Payment Reference ID
    'none',    // Membership Status
    '',        // Member Since
    'active',  // Account Status
    '',        // Membership Expiry
    'out',     // Network Status
    serializeNetworkVisibility(DEFAULT_NETWORK_VISIBILITY),
    serializeProfile(DEFAULT_PROFILE),
  ]);
  await fs.mkdir(path.dirname(USERS_XLSX), { recursive: true });
  await writeWorkbookAtomic(wb, USERS_XLSX);
  return memberId;
}

// Serialise writes so concurrent sign-ups cannot corrupt the workbook,
// while keeping the chain alive even if one write fails.
function appendUser(user) {
  const run = usersWriteChain.catch(() => {}).then(() => doAppendUser(user));
  usersWriteChain = run.catch(() => {});
  return run;
}

registerAuthRoutes(app, {
  findUserByEmail,
  updateMembership,
  hashPassword,
  appendUser,
  invalidateSessionUser,
  setSession,
  clearSession,
  verifyPassword,
  isActiveMember,
  publicMember,
  isAdmin,
  requireAuth,
  serializeNetworkVisibility,
  DEFAULT_NETWORK_VISIBILITY,
  ZEFFY_STUDENT_URL,
  ZEFFY_REGULAR_URL,
  WIX_SITE_URL,
  WIX_MEMBER_LOGIN_URL,
  APP_BASE_URL,
});


/* ────────────────────────────────────────────────────────────────────────────
 * Sessions, access control, and membership.
 * ──────────────────────────────────────────────────────────────────────────── */

const SESSION_COOKIE = 'nspa_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

function setSession(res, email) {
  res.cookie(SESSION_COOKIE, String(email).toLowerCase(), {
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE,
    // HTTPS-only in production. This depends on `trust proxy` because TLS is
    // terminated by the hosting platform before requests reach Express.
    secure: IS_PRODUCTION,
  });
}

function clearSession(res) {
  // Must mirror the options used in setSession, or the browser keeps the
  // cookie and "Log out" silently does nothing in production.
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION,
  });
}

// Short TTL cache to avoid reading the workbook on every request.
const sessionUserCache = new Map();
const SESSION_USER_TTL = 15 * 1000;

async function loadSessionUser(email) {
  const key = String(email).toLowerCase();
  const cached = sessionUserCache.get(key);
  if (cached && Date.now() - cached.at < SESSION_USER_TTL) return cached.user;
  const user = await findUserByEmail(key);
  sessionUserCache.set(key, { user, at: Date.now() });
  return user;
}

function invalidateSessionUser(email) {
  if (email) sessionUserCache.delete(String(email).toLowerCase());
  else sessionUserCache.clear();
}

async function attachUser(req, res, next) {
  try {
    const email = req.signedCookies && req.signedCookies[SESSION_COOKIE];
    req.user = email ? await loadSessionUser(email) : null;
    if (req.user && (req.user.accountStatus || 'active') === 'deactivated') req.user = null;
  } catch (error) {
    console.error('attachUser:', error.message);
    req.user = null;
  }
  next();
}

function isActiveMember(user) {
  if (!user || user.membershipStatus !== 'active') return false;
  if (user.membershipExpiry) {
    const exp = new Date(user.membershipExpiry);
    if (!Number.isNaN(exp.getTime()) && Date.now() > exp.getTime()) return false; // expired 31 Dec
  }
  return true;
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in to continue.', auth: 'signin' });
  next();
}

function requireMemberApi(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in to continue.', auth: 'signin' });
  if (!isActiveMember(req.user)) return res.status(403).json({ error: 'An active membership is required.', auth: 'membership' });
  next();
}

function requireMemberPage(req, res, next) {
  if (!req.user) return res.redirect(WIX_MEMBER_LOGIN_URL || '/signup.html');
  if (!isActiveMember(req.user)) return res.redirect('/membership.html');
  next();
}

async function publicMember(user) {
  if (!user) return null;
  const studentVerification = user.memberId ? await portal.getStudentVerification(user.memberId) : null;
  return {
    memberId: user.memberId,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phone: user.phone,
    membershipStatus: user.membershipStatus || 'none',
    isMember: isActiveMember(user),
    memberSince: user.memberSince || null,
    membershipExpiry: user.membershipExpiry || null,
    studentVerification: publicStudentVerification(studentVerification),
  };
}

function publicStudentVerification(record) {
  if (!record) return { status: 'none', schoolEmail: '', institution: '', verifiedAt: null };
  return {
    status: record.status || 'none',
    schoolEmail: record.schoolEmail || '',
    institution: record.institution || '',
    verifiedAt: record.verifiedAt || null,
  };
}


/* ── Projects: member history + status tracking ─────────────────────────── */

const PROJECT_STATUSES = [
  'Pending', 'Submitted', 'Under Review', 'Approved', 'Revisions Requested', 'Rejected', 'Resubmitted',
];
// Statuses the owner may edit and resubmit from.
const RESUBMITTABLE_STATUSES = ['Rejected', 'Revisions Requested'];
let projectsWriteChain = Promise.resolve();

function projectRowToObj(row) {
  return {
    id: cellText(row.getCell(1)),
    createdAt: cellText(row.getCell(2)),
    memberId: cellText(row.getCell(3)),
    firstName: cellText(row.getCell(4)),
    lastName: cellText(row.getCell(5)),
    email: cellText(row.getCell(6)),
    phone: cellText(row.getCell(7)),
    title: cellText(row.getCell(8)),
    operator: cellText(row.getCell(9)),
    tenures: cellText(row.getCell(10)),
    commodities: cellText(row.getCell(11)),
    depositTypes: cellText(row.getCell(12)),
    projectStage: cellText(row.getCell(13)),
    resourceEstimate: cellText(row.getCell(14)),
    resourceSource: cellText(row.getCell(15)),
    website: cellText(row.getCell(16)),
    status: cellText(row.getCell(PROJECT_STATUS_COL)) || 'Pending',
    reviewNote: cellText(row.getCell(PROJECT_REVIEW_NOTE_COL)),
    reviewedBy: cellText(row.getCell(PROJECT_REVIEWED_BY_COL)),
    reviewedAt: cellText(row.getCell(PROJECT_REVIEWED_AT_COL)),
    // Archived projects stay in the sheet but disappear from member views.
    archived: cellText(row.getCell(PROJECT_ARCHIVED_COL)).toLowerCase() === 'yes',
  };
}

/* Reading the project list means parsing the whole workbook, which several
 * endpoints do per request (dashboard, map, favourites, network). Cache the
 * parsed rows for a short window and drop the entry whenever a write lands, so
 * readers never see stale data. */
const PROJECTS_CACHE_TTL = 20 * 1000;
let projectsCache = null;

function invalidateProjectsCache() {
  projectsCache = null;
}

async function loadAllProjects() {
  if (projectsCache && Date.now() - projectsCache.at < PROJECTS_CACHE_TTL) {
    return projectsCache.rows;
  }
  if (projectsCache && projectsCache.pending) return projectsCache.pending;

  const pending = (async () => {
    if (USE_SUPABASE) {
      const rows = await supabase.select('projects', 'select=*&order=created_at.desc');
      const out = rows.map(supabaseProjectToRow);
      projectsCache = { rows: out, at: Date.now() };
      return out;
    }

    const { ws } = await getProjectsSheet();
    const out = [];
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const obj = projectRowToObj(row);
      if (!obj.id) return;
      out.push(obj);
    });
    out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    projectsCache = { rows: out, at: Date.now() };
    return out;
  })();

  projectsCache = { pending, at: 0 }; // de-duplicate concurrent readers
  try {
    return await pending;
  } catch (error) {
    projectsCache = null;
    throw error;
  }
}

async function listProjects(filterMemberId) {
  const rows = await loadAllProjects();
  // Hand back a copy so a caller can never reorder the cached array.
  return filterMemberId ? rows.filter(p => p.memberId === filterMemberId) : rows.slice();
}

function splitListValue(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function uniqueList(values) {
  return [...new Set(values.filter(Boolean))];
}

function displayListLabel(value) {
  return String(value || '')
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(word => {
      if (!word) return '';
      if (word.length <= 3) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

function displayDepositTypes(value) {
  return splitListValue(value).map(displayListLabel);
}

function networkProjectSummary(projects) {
  return {
    projects: projects.map(project => ({
      id: project.id,
      title: project.title || 'Untitled project',
      operator: project.operator,
      status: project.status,
      tenures: splitListValue(project.tenures),
      commodities: splitListValue(project.commodities),
      depositTypes: displayDepositTypes(project.depositTypes),
      projectStage: project.projectStage,
    })),
    tenureNumbers: uniqueList(projects.flatMap(project => splitListValue(project.tenures))),
    commodities: uniqueList(projects.flatMap(project => splitListValue(project.commodities))),
    depositTypes: uniqueList(projects.flatMap(project => displayDepositTypes(project.depositTypes))),
  };
}

function applyNetworkVisibility(profile, visibility) {
  const visible = parseNetworkVisibility(JSON.stringify(visibility || {}));
  const projects = visible.projects
    ? profile.projects.map(project => ({
        ...project,
        tenures: visible.tenures ? project.tenures : [],
        commodities: visible.commodities ? project.commodities : [],
        depositTypes: visible.commodities ? project.depositTypes : [],
      }))
    : [];

  return {
    ...profile,
    visibility: visible,
    email: visible.email ? profile.email : '',
    phone: visible.phone ? profile.phone : '',
    projects,
    tenureNumbers: visible.tenures ? profile.tenureNumbers : [],
    commodities: visible.commodities ? profile.commodities : [],
    depositTypes: visible.commodities ? profile.depositTypes : [],
  };
}

async function doSetProjectStatus(projectId, status, review = null) {
  if (USE_SUPABASE) {
    const patch = { status };
    if (review) {
      patch.review_note = review.note || '';
      patch.reviewed_by = review.reviewer || '';
      patch.reviewed_at = review.at || new Date().toISOString();
    }
    const updated = await supabase.update('projects', supabase.eq('id', projectId), patch);
    invalidateProjectsCache();
    return !!(updated && updated.length);
  }

  const { wb, ws } = await getProjectsSheet();
  let updated = false;
  ws.eachRow((row, n) => {
    if (n === 1 || updated) return;
    if (cellText(row.getCell(PROJECT_ID_COL)) === projectId) {
      row.getCell(PROJECT_STATUS_COL).value = status;
      if (review) {
        // The note is the rejection reason / reviewer comments the member sees.
        row.getCell(PROJECT_REVIEW_NOTE_COL).value = review.note || '';
        row.getCell(PROJECT_REVIEWED_BY_COL).value = review.reviewer || '';
        row.getCell(PROJECT_REVIEWED_AT_COL).value = review.at || new Date().toISOString();
      }
      updated = true;
    }
  });
  if (updated) {
    await writeWorkbookAtomic(wb, PROJECTS_XLSX);
    invalidateProjectsCache();
  }
  return updated;
}

function setProjectStatus(projectId, status, review = null) {
  const run = projectsWriteChain.catch(() => {}).then(() => doSetProjectStatus(projectId, status, review));
  projectsWriteChain = run.catch(() => {});
  return run;
}

registerProjectBrowseRoutes(app, {
  requireMemberApi,
  portal,
  listProjects,
  readSubmissions,
  publicDocument,
  RESUBMITTABLE_STATUSES,
  visibleProjectRecords,
  isAdmin,
  listUsers,
  isActiveMember,
  parseNetworkVisibility,
  networkProjectSummary,
  applyNetworkVisibility,
  publicProfile,
  updateMembership,
  invalidateSessionUser,
  serializeNetworkVisibility,
  cleanNetworkVisibility,
  DEFAULT_NETWORK_VISIBILITY,
});


/* ────────────────────────────────────────────────────────────────────────────
 * Project visibility — membership synchronisation.
 *
 * A project is visible to other members only while BOTH are true:
 *   • its owner has an active membership and a live (not deactivated) account
 *   • the project has been approved
 *
 * Nothing is ever deleted: when a membership lapses the project simply stops
 * appearing in shared views, and it reappears automatically once the member
 * renews. Owners always see their own projects regardless of status, and
 * admins see everything.
 * ──────────────────────────────────────────────────────────────────────────── */

const PUBLIC_PROJECT_STATUS = 'Approved';

// memberId → membership state, cached briefly since the map/search endpoints
// need it for every project on every request.
const MEMBER_STATE_TTL = 20 * 1000;
let memberStateCache = null;

async function getMemberStates() {
  if (memberStateCache && Date.now() - memberStateCache.at < MEMBER_STATE_TTL) {
    return memberStateCache.map;
  }
  const users = await listUsers();
  const map = new Map();
  for (const user of users) {
    if (!user.memberId) continue;
    map.set(user.memberId, {
      memberId: user.memberId,
      name: [user.firstName, user.lastName].filter(Boolean).join(' '),
      active: isActiveMember(user) && (user.accountStatus || 'active') !== 'deactivated',
    });
  }
  memberStateCache = { map, at: Date.now() };
  return map;
}

function invalidateMemberStates() {
  memberStateCache = null;
}

function memberIsActive(memberStates, memberId) {
  const state = memberStates.get(String(memberId || ''));
  return !!(state && state.active);
}

// Is this project visible to members at large?
function isProjectShared(project, memberStates) {
  return (
    memberIsActive(memberStates, project.memberId) &&
    String(project.status || '') === PUBLIC_PROJECT_STATUS
  );
}

// Can this specific user see this project? Owners and admins bypass the
// sharing rules; everyone else sees only shared projects.
function canViewProject(user, project, memberStates) {
  if (!project) return false;
  if (user && (isAdmin(user) || project.memberId === user.memberId)) return true;
  return isProjectShared(project, memberStates);
}

// The set of projects a user may see, with a flag explaining why each is
// present so the UI can label a member's own unapproved or hidden work.
async function visibleProjectsFor(user) {
  const [projects, memberStates] = await Promise.all([listProjects(), getMemberStates()]);
  return projects
    .filter(p => canViewProject(user, p, memberStates))
    .map(p => ({
      ...p,
      shared: isProjectShared(p, memberStates),
      ownedByViewer: !!(user && p.memberId === user.memberId),
      ownerName: (memberStates.get(String(p.memberId)) || {}).name || '',
    }));
}


/* ── Project records: derived county, geometry summary, documents ───────── */

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png'];

function isImageDocument(doc) {
  return IMAGE_EXTENSIONS.includes(path.extname(doc.fileName || '').toLowerCase());
}

// County and geometry summaries are pure functions of the stored polygons, so
// they're memoised per project rather than recomputed on every request.
const derivedGeoCache = new Map();

function derivedGeoFor(submission) {
  const key = `${submission.id}:${(submission.tenures || []).length}`;
  const hit = derivedGeoCache.get(key);
  if (hit) return hit;

  const tenures = Array.isArray(submission.tenures) ? submission.tenures : [];
  const value = {
    counties: geo.countiesForTenures(tenures),
    summary: geo.summarizeTenures(tenures),
  };
  derivedGeoCache.set(key, value);
  return value;
}

/** The canonical shape of a project, shared by the map, search and detail page. */
function buildProjectRecord(submission, row, { includeGeometry = false } = {}) {
  const { counties, summary } = derivedGeoFor(submission);
  const documents = Array.isArray(submission.documents) ? submission.documents : [];
  const tenures = Array.isArray(submission.tenures) ? submission.tenures : [];

  const record = {
    id: submission.id,
    title: row.title || submission.project || 'Untitled project',
    description: submission.description || '',
    operator: row.operator || submission.operator || '',
    owner: row.ownerName || [submission.firstName, submission.lastName].filter(Boolean).join(' '),
    memberId: row.memberId || submission.memberId || '',
    status: row.status,
    shared: row.shared,
    ownedByViewer: row.ownedByViewer,
    projectStage: row.projectStage || submission.projectStage || '',
    commodities: Array.isArray(submission.commodities)
      ? submission.commodities
      : splitListValue(submission.commodities),
    depositTypes: (Array.isArray(submission.depositTypes)
      ? submission.depositTypes
      : splitListValue(submission.depositTypes)
    ).map(displayListLabel),
    counties,
    county: counties[0] || '',
    resourceEstimate: submission.resourceEstimate || '',
    resourceSource: submission.resourceSource || '',
    website: submission.website || '',
    createdAt: submission.createdAt,
    updatedAt: submission.updatedAt || submission.createdAt,
    year: String(submission.createdAt || '').slice(0, 4),
    // Review outcome — the rejection reason and reviewer comments.
    reviewNote: row.reviewNote || '',
    reviewedBy: row.reviewedBy || '',
    reviewedAt: row.reviewedAt || '',
    canResubmit: !!row.ownedByViewer && RESUBMITTABLE_STATUSES.includes(row.status),
    tenureNumbers: tenures.map(t => t && t.tenureNumber).filter(Boolean),
    documentCount: documents.filter(d => !isImageDocument(d)).length,
    photoCount: documents.filter(isImageDocument).length,
    hasDocuments: documents.some(d => !isImageDocument(d)),
    hasPhotos: documents.some(isImageDocument),
    hasResourceEstimate: !!String(submission.resourceEstimate || '').trim(),
    geometryTypes: summary ? summary.types : [],
    bbox: summary ? summary.bbox : null,
    center: summary ? summary.center : null,
  };

  if (includeGeometry) {
    record.tenures = tenures
      .filter(t => t && t.geojson)
      .map(t => ({ tenureNumber: t.tenureNumber, geojson: t.geojson }));
    record.documents = documents.filter(d => !isImageDocument(d)).map(publicDocument);
    record.photos = documents.filter(isImageDocument).map(publicDocument);
  }

  return record;
}

/** Every project the viewer may see, as full records. */
async function visibleProjectRecords(user, { includeGeometry = false } = {}) {
  const [submissions, visible] = await Promise.all([
    readSubmissions(),
    visibleProjectsFor(user),
  ]);
  const byId = new Map(submissions.map(s => [s.id, s]));

  return visible
    .filter(row => byId.has(row.id))
    .map(row => buildProjectRecord(byId.get(row.id), row, { includeGeometry }));
}



/* ── Optional outbound email ────────────────────────────────────────────────
 * Configured through SMTP_* in .env. When it isn't configured, every caller
 * silently falls back to the in-app notification, which is the channel members
 * actually rely on — so a missing mail server is never a broken feature.
 * ──────────────────────────────────────────────────────────────────────────── */

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_FROM = process.env.MAIL_FROM || 'NSPA <no-reply@prospectors.ns.ca>';

let mailer = null;
let mailStatus = { configured: false, verified: false, error: 'SMTP_HOST is not set' };

if (SMTP_HOST) {
  try {
    mailer = require('nodemailer').createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465, // 587 uses STARTTLS, which nodemailer negotiates
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    });
    mailStatus = { configured: true, verified: false, error: null };
  } catch (error) {
    mailStatus = { configured: false, verified: false, error: error.message };
    console.warn('mail: transport unavailable —', error.message);
  }
}

/**
 * Checks the credentials actually work. Without this a bad app password stays
 * invisible until a real alert silently fails to send.
 */
async function verifyMailer() {
  if (!mailer) return mailStatus;
  try {
    await mailer.verify();
    mailStatus = { configured: true, verified: true, error: null };
  } catch (error) {
    mailStatus = { configured: true, verified: false, error: error.message };
  }
  return mailStatus;
}

function sendMailIfConfigured({ to, subject, text, attachments }) {
  if (!mailer || !to) return false;
  mailer.sendMail({ from: MAIL_FROM, to, subject, text, attachments })
    .catch(error => console.warn('mail send:', error.message));
  return true;
}

/** Same, but reports whether delivery actually succeeded. */
async function sendMailAwaited({ to, subject, text, attachments }) {
  if (!mailer) return { sent: false, reason: 'SMTP is not configured' };
  if (!to) return { sent: false, reason: 'No recipient address' };
  try {
    await mailer.sendMail({ from: MAIL_FROM, to, subject, text, attachments });
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: error.message };
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Claim watch — expiry/anniversary reminders and open-ground alerts.
 * The engine lives in claimwatch.js; this wires it to members and delivery.
 * ──────────────────────────────────────────────────────────────────────────── */

const CLAIM_WATCH_INTERVAL_MS = 12 * 60 * 60 * 1000; // twice daily
const CLAIM_WATCH_START_DELAY_MS = 60 * 1000;        // let the server settle first

/**
 * Active members and the tenures they've registered, with a bounding box per
 * tenure for the open-ground search. Only active members are swept — there's
 * no point warning someone whose membership has already lapsed.
 */
async function listClaimHoldings() {
  const [submissions, memberStates, users] = await Promise.all([
    readSubmissions(),
    getMemberStates(),
    listUsers(),
  ]);
  const usersById = new Map(users.map(u => [u.memberId, u]));
  const byMember = new Map();

  for (const submission of submissions) {
    const memberId = String(submission.memberId || '');
    if (!memberIsActive(memberStates, memberId)) continue;

    for (const tenure of submission.tenures || []) {
      const number = String(tenure && tenure.tenureNumber || '').trim().toUpperCase();
      if (!number) continue;

      if (!byMember.has(memberId)) {
        const user = usersById.get(memberId);
        byMember.set(memberId, {
          memberId,
          email: user ? user.email : '',
          name: user ? [user.firstName, user.lastName].filter(Boolean).join(' ') : '',
          tenures: [],
        });
      }
      const holder = byMember.get(memberId);
      if (holder.tenures.some(t => t.tenureNumber === number)) continue;

      const summary = tenure.geojson ? geo.summarizeGeoJSON(tenure.geojson) : null;
      const tenureCounties = tenure.geojson ? geo.countiesForTenures([tenure]) : [];
      holder.tenures.push({
        tenureNumber: number,
        bbox: summary ? summary.bbox : null,
        projectId: submission.id,
        projectTitle: submission.project || submission.id,
        commodities: Array.isArray(submission.commodities) ? submission.commodities : splitListValue(submission.commodities),
        depositTypes: Array.isArray(submission.depositTypes) ? submission.depositTypes : splitListValue(submission.depositTypes),
        counties: tenureCounties,
      });
    }
  }

  return [...byMember.values()];
}

const CLAIM_ALERT_COPY = {
  anniversary: ({ tenureNumber, days, dueDate }) => ({
    type: 'claim_anniversary',
    title: days <= 0
      ? `Claim ${tenureNumber} reaches its anniversary today`
      : `Claim ${tenureNumber} anniversary in ${days} day${days === 1 ? '' : 's'}`,
    body: `Tenure ${tenureNumber} has a good-standing date of ${dueDate}. Required work must be filed before then or the claim can lapse.`,
  }),
  expiry: ({ tenureNumber, days, dueDate }) => ({
    type: 'claim_expiry',
    title: days <= 0
      ? `Claim ${tenureNumber} expires today`
      : `Claim ${tenureNumber} expires in ${days} day${days === 1 ? '' : 's'}`,
    body: `Tenure ${tenureNumber} expires on ${dueDate}. Renew it through NovaROC to keep the ground.`,
  }),
  status: ({ tenureNumber, record }) => ({
    type: 'claim_status',
    title: `Claim ${tenureNumber} status changed to ${record.status}`,
    body: `NovaROC now reports tenure ${tenureNumber} as "${record.status}". Check the claim in NovaROC if this is unexpected.`,
  }),
  open_ground: ({ tenureNumber, days, dueDate, record }) => ({
    type: 'open_ground',
    title: `Ground near you may open — tenure ${tenureNumber}`,
    body: days != null && days >= 0
      ? `Tenure ${tenureNumber}, next to ground you hold, expires on ${dueDate} (${days} day${days === 1 ? '' : 's'}). If it lapses the ground becomes available for staking.`
      : `Tenure ${tenureNumber}, next to ground you hold, is now "${record.status}" and may become available for staking.`,
  }),
};

function cleanClaimAlertCriteria(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const statuses = Array.isArray(src.statuses) ? src.statuses : [];
  const cleanStatuses = statuses
    .map(s => String(s || '').trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 8);
  const maxExpiryDays = Number(src.maxExpiryDays);
  const minAreaHa = Number(src.minAreaHa);
  const maxAreaHa = Number(src.maxAreaHa);
  return {
    statuses: [...new Set(cleanStatuses)],
    maxExpiryDays: Number.isFinite(maxExpiryDays) ? Math.max(0, Math.min(365, Math.round(maxExpiryDays))) : claimwatch.OPEN_GROUND_WINDOW_DAYS,
    minAreaHa: Number.isFinite(minAreaHa) && minAreaHa > 0 ? minAreaHa : null,
    maxAreaHa: Number.isFinite(maxAreaHa) && maxAreaHa > 0 ? maxAreaHa : null,
    tenureText: clampText(src.tenureText, 80).toUpperCase(),
  };
}

function cleanClaimAlertInput(input = {}, memberId) {
  const name = clampText(input.name || 'Open ground alert', 80) || 'Open ground alert';
  const channel = ['inapp', 'email', 'both'].includes(input.channel) ? input.channel : 'both';
  return {
    memberId,
    name,
    channel,
    frequency: 'daily',
    paused: !!input.paused,
    criteria: cleanClaimAlertCriteria(input.criteria || input),
  };
}

function claimAlertMatchesOpportunity(alert, payload) {
  const c = alert.criteria || {};
  const record = payload.record || {};
  const days = payload.days;
  if (c.statuses && c.statuses.length && !c.statuses.includes(String(record.status || '').toUpperCase())) return false;
  if (days != null && Number.isFinite(Number(c.maxExpiryDays)) && days > Number(c.maxExpiryDays)) return false;
  if (c.minAreaHa != null && record.areaHa != null && Number(record.areaHa) < Number(c.minAreaHa)) return false;
  if (c.maxAreaHa != null && record.areaHa != null && Number(record.areaHa) > Number(c.maxAreaHa)) return false;
  if (c.tenureText && !String(payload.tenureNumber || '').toUpperCase().includes(c.tenureText)) return false;
  return true;
}

function deterministicOpportunityAdvisory(alert, payload) {
  const record = payload.record || {};
  const days = payload.days;
  let rankScore = 45;
  if (days != null) rankScore += days <= 7 ? 35 : days <= 30 ? 25 : days <= 90 ? 12 : 0;
  if (['PEND_EXPIRY', 'EXPIRED', 'TERMINATED', 'CANCELLED', 'PEND_CANCEL'].includes(String(record.status || '').toUpperCase())) rankScore += 20;
  if (record.areaHa != null && Number(record.areaHa) >= 100) rankScore += 8;
  rankScore = Math.max(1, Math.min(100, Math.round(rankScore)));
  const adjacent = (payload.adjacentTo || [])[0] || {};
  const commodities = [...new Set((payload.adjacentTo || []).flatMap(t => t.commodities || []))].slice(0, 6);
  const depositTypes = [...new Set((payload.adjacentTo || []).flatMap(t => t.depositTypes || []))].slice(0, 6);
  const counties = [...new Set((payload.adjacentTo || []).flatMap(t => t.counties || []))].slice(0, 4);
  const reviewFlag = rankScore >= 75 ? 'worth_reviewing' : rankScore >= 55 ? 'routine_watch' : 'low_priority';
  const whyMatches = [
    alert.name ? `Matched saved alert "${alert.name}".` : 'Matched saved alert preferences.',
    days != null ? `Expiry is ${days < 0 ? `${Math.abs(days)} days past` : `within ${days} days`}.` : '',
    record.status ? `NovaROC status is ${record.status}.` : '',
    adjacent.projectTitle ? `Adjacent to your project ${adjacent.projectTitle}.` : '',
  ].filter(Boolean);
  return {
    aiAvailable: false,
    rankScore,
    reviewFlag,
    reviewReason: reviewFlag === 'worth_reviewing'
      ? 'Short expiry window or lapsing status makes this worth reviewing promptly.'
      : 'Review when convenient and confirm details in NovaROC.',
    plainEnglish: `Tenure ${payload.tenureNumber} matched ${alert.name}. Confirm the status, expiry, and map location in NovaROC before acting.`,
    whyMatches,
    nearbyContext: [
      commodities.length ? `Nearby commodities: ${commodities.join(', ')}` : '',
      depositTypes.length ? `Nearby deposit types: ${depositTypes.join(', ')}` : '',
      counties.length ? `Nearby county context: ${counties.join(', ')}` : '',
    ].filter(Boolean).join(' · '),
  };
}

function parseAiJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch {}
  return null;
}

async function generateOpportunityAdvisory(alert, payload) {
  const fallback = deterministicOpportunityAdvisory(alert, payload);
  if (!OPENAI_API_KEY) return fallback;

  const context = {
    savedAlert: { name: alert.name, criteria: alert.criteria },
    tenure: {
      number: payload.tenureNumber,
      status: payload.record.status || '',
      expiry: payload.dueDate || '',
      daysUntilExpiry: payload.days,
      areaHa: payload.record.areaHa == null ? null : payload.record.areaHa,
    },
    adjacentMemberProjects: (payload.adjacentTo || []).slice(0, 5).map(t => ({
      tenureNumber: t.tenureNumber,
      projectTitle: t.projectTitle,
      commodities: t.commodities || [],
      depositTypes: t.depositTypes || [],
      counties: t.counties || [],
    })),
  };

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: [
          {
            role: 'system',
            content:
              'You summarize mineral tenure alert matches for prospectors. ' +
              'You are advisory only: do not recommend staking, investing, or claiming certainty. ' +
              'Use only the provided facts. Return only compact JSON.',
          },
          {
            role: 'user',
            content:
              'Return JSON with keys: rankScore number 1-100, reviewFlag one of worth_reviewing/routine_watch/low_priority, ' +
              'plainEnglish string, whyMatches array of short strings, nearbyContext string, reviewReason string. ' +
              `Facts: ${JSON.stringify(context)}`,
          },
        ],
        max_output_tokens: 500,
      }),
    });
    if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);
    const data = await response.json();
    const text = data.output_text || (data.output || [])
      .flatMap(item => item.content || [])
      .map(part => part.text || part.output_text || '')
      .join('\n');
    const ai = parseAiJson(text);
    if (!ai) throw new Error('AI response was not JSON');
    return {
      ...fallback,
      aiAvailable: true,
      rankScore: Math.max(1, Math.min(100, Math.round(Number(ai.rankScore) || fallback.rankScore))),
      reviewFlag: ['worth_reviewing', 'routine_watch', 'low_priority'].includes(ai.reviewFlag) ? ai.reviewFlag : fallback.reviewFlag,
      plainEnglish: clampText(ai.plainEnglish || fallback.plainEnglish, 500),
      whyMatches: (Array.isArray(ai.whyMatches) ? ai.whyMatches : fallback.whyMatches).map(x => clampText(x, 160)).filter(Boolean).slice(0, 5),
      nearbyContext: clampText(ai.nearbyContext || fallback.nearbyContext, 500),
      reviewReason: clampText(ai.reviewReason || fallback.reviewReason, 300),
    };
  } catch (error) {
    console.warn('opportunity AI:', error.message);
    return { ...fallback, aiError: error.message };
  }
}

async function deliverOpportunityAlert(payload) {
  const alerts = (await portal.listActiveClaimAlerts())
    .filter(alert => alert.memberId === payload.holder.memberId)
    .filter(alert => claimAlertMatchesOpportunity(alert, payload));

  for (const alert of alerts) {
    const advisory = await generateOpportunityAdvisory(alert, payload);
    const fresh = await portal.recordAlertMatch({
      alertId: alert.id,
      memberId: alert.memberId,
      tenureNumber: payload.tenureNumber,
      reason: payload.kind,
      detail: {
        alertName: alert.name,
        status: payload.record.status || '',
        expiry: payload.dueDate || '',
        days: payload.days,
        areaHa: payload.record.areaHa == null ? null : payload.record.areaHa,
        adjacentTo: (payload.adjacentTo || []).map(t => ({
          tenureNumber: t.tenureNumber,
          projectTitle: t.projectTitle,
          commodities: t.commodities || [],
          depositTypes: t.depositTypes || [],
          counties: t.counties || [],
        })),
        advisory,
      },
    });
    if (!fresh) continue;

    const title = `Opportunity match: tenure ${payload.tenureNumber}`;
    const body = advisory.plainEnglish || (`${alert.name} matched tenure ${payload.tenureNumber}` +
      `${payload.dueDate ? `, expiring ${payload.dueDate}` : ''}` +
      `${payload.record.status ? ` with status ${payload.record.status}` : ''}.`);

    if (alert.channel !== 'email') {
      await portal.addNotification({
        memberId: alert.memberId,
        type: 'opportunity_match',
        title,
        body,
        link: '/claims.html',
        dedupeKey: `opportunity:${alert.id}:${payload.tenureNumber}:${payload.kind}`,
      });
    }

    if (alert.channel !== 'inapp') {
      sendMailIfConfigured({
        to: payload.holder.email,
        subject: title,
        text: `${body}\n\nView your alerts: ${APP_BASE_URL}/claims.html\n`,
      });
    }
  }
}

function deliverClaimAlert(payload) {
  const build = CLAIM_ALERT_COPY[payload.kind];
  if (!build) return;
  const copy = build(payload);

  safely('claim alert', () => portal.addNotification({
      memberId: payload.holder.memberId,
      type: copy.type,
      title: copy.title,
      body: copy.body,
      link: '/claims.html',
    }));

  // Email is best-effort and only when SMTP is configured; the in-app
  // notification above is always the reliable channel.
  sendMailIfConfigured({
    to: payload.holder.email,
    subject: copy.title,
    text: `${copy.body}\n\nView your claims: ${APP_BASE_URL}/claims.html\n`,
  });
}

let claimWatchRunning = false;
let lastClaimWatch = null;

async function runClaimWatchNow() {
  if (claimWatchRunning) return { skipped: true, reason: 'A sweep is already running.' };
  claimWatchRunning = true;
  const startedAt = new Date().toISOString();
  try {
    // Tenure → member, so a neighbour held by another NSPA member can be
    // named rather than shown as an anonymous third party.
    const holdings = await listClaimHoldings();
    const memberByTenure = new Map();
    for (const holder of holdings) {
      for (const t of holder.tenures) memberByTenure.set(t.tenureNumber, holder);
    }

    const summary = await claimwatch.runClaimWatch({
      listHoldings: async () => holdings,
      notify: deliverClaimAlert,
      notifyOpportunity: deliverOpportunityAlert,
      saveNeighbours: (holder, tenureNumber, neighbours) => {
        safely('save neighbours', () =>
          portal.replaceNeighbours(holder.memberId, tenureNumber, neighbours.map(n => ({
            tenureNumber: n.tenureNumber,
            neighbourMember: (memberByTenure.get(n.tenureNumber) || {}).memberId || null,
            status: n.status,
            titleType: n.titleType,
            expiry: n.expiry,
          })))
        );
      },
      log: msg => console.warn('claim watch:', msg),
    });
    lastClaimWatch = { startedAt, finishedAt: new Date().toISOString(), ...summary };
    await portal.setSetting('lastClaimWatch', lastClaimWatch);
    console.log(
      `claim watch: ${summary.tenures} tenure(s), ${summary.alerts} alert(s), ` +
      `${summary.openGround} open-ground, ${summary.errors} error(s)`
    );
    return lastClaimWatch;
  } catch (error) {
    console.error('claim watch failed:', error.message);
    return { error: error.message };
  } finally {
    claimWatchRunning = false;
  }
}

/** A member's own claims with their current watch state. */
async function claimsForMember(user) {
  const holdings = await listClaimHoldings();
  const mine = holdings.find(h => h.memberId === user.memberId);
  if (!mine) return [];

  const claims = await Promise.all(mine.tenures.map(async t => {
    const watch = await portal.getTenureWatch(t.tenureNumber);
    const expiryDays = watch ? claimwatch.daysUntil(watch.expiry) : null;
    const anniversaryDays = watch ? claimwatch.daysUntil(watch.anniversary) : null;
    return {
      tenureNumber: t.tenureNumber,
      projectId: t.projectId,
      projectTitle: t.projectTitle,
      status: watch ? watch.status : '',
      titleType: watch ? watch.titleType : '',
      issueDate: watch ? watch.issueDate : '',
      anniversary: watch ? watch.anniversary : '',
      expiry: watch ? watch.expiry : '',
      areaHa: watch ? watch.areaHa : null,
      checkedAt: watch ? watch.checkedAt : '',
      missing: watch ? watch.missing : false,
      expiryDays,
      anniversaryDays,
      // Drives the colour coding in the dashboard.
      urgency: expiryDays == null ? 'unknown'
        : expiryDays < 0 ? 'expired'
        : expiryDays <= 30 ? 'critical'
        : expiryDays <= 90 ? 'warning'
        : 'ok',
    };
  }));
  return claims.sort((a, b) => {
    const av = a.expiryDays == null ? Infinity : a.expiryDays;
    const bv = b.expiryDays == null ? Infinity : b.expiryDays;
    return av - bv;
  });
}

registerClaimRoutes(app, {
  requireMemberApi,
  requireAdminApi,
  claimsForMember,
  listUsers,
  portal,
  claimwatch,
  cleanClaimAlertInput,
  readSubmissions,
  runClaimWatchNow,
});


/**
 * Tells existing holders when a newly submitted project sits next to their
 * ground. Runs after submission and never blocks it — knowing who has just
 * moved in beside you is useful, but not at the cost of a failed submit.
 */
async function notifyAdjacentHolders(submission) {
  const newBoxes = (submission.tenures || [])
    .map(t => (t && t.geojson ? geo.summarizeGeoJSON(t.geojson) : null))
    .filter(Boolean)
    .map(s => s.bbox);
  if (!newBoxes.length) return;

  const holdings = await listClaimHoldings();
  const newTenures = new Set(
    (submission.tenures || []).map(t => String(t.tenureNumber || '').trim().toUpperCase())
  );

  for (const holder of holdings) {
    if (holder.memberId === submission.memberId) continue;

    const touching = holder.tenures.filter(own =>
      !newTenures.has(own.tenureNumber) &&
      newBoxes.some(box => claimwatch.boxesAdjacent(own.bbox, box))
    );
    if (!touching.length) continue;

    const list = touching.map(t => t.tenureNumber).join(', ');
    safely('adjacency notify', () =>
      portal.addNotification({
        memberId: holder.memberId,
        type: 'adjacent_project',
        title: 'A new project was registered next to your ground',
        body: `"${submission.project || submission.id}" was registered on ground adjoining your claim${touching.length === 1 ? '' : 's'} ${list}.`,
        link: '/claims.html',
        // One notice per project per member, however often this runs.
        dedupeKey: `adjacent:${submission.id}:${holder.memberId}`,
      })
    );

    sendMailIfConfigured({
      to: holder.email,
      subject: 'A new NSPA project was registered next to your ground',
      text: `"${submission.project || submission.id}" was registered on ground adjoining your claim${touching.length === 1 ? '' : 's'} ${list}.\n\n` +
            `View your claims: ${APP_BASE_URL}/claims.html\n`,
    });
  }
}


registerProfileRoutes(app, {
  uploadsDir: UPLOADS_DIR,
  requireAuth,
  requireMemberApi,
  publicMember,
  parseProfile,
  parseNetworkVisibility,
  cleanProfile,
  clampText,
  serializeNetworkVisibility,
  updateMembership,
  invalidateSessionUser,
  listUsers,
  isActiveMember,
  listProjects,
  networkProjectSummary,
  applyNetworkVisibility,
  publicProfile,
});

// Admin: all projects + status updates (Pending → Submitted → Approved).
app.get('/api/admin/projects', requireAdminApi, async (req, res) => {
  try {
    res.json({ projects: await listProjects() });
  } catch (error) {
    console.error('admin projects:', error.message);
    res.status(500).json({ error: 'Could not load projects.' });
  }
});

app.post('/api/admin/projects', requireAdminApi, async (req, res) => {
  const doCreate = async () => {
    const memberId = String(req.body.memberId || '').trim();
    const users = await listUsers();
    const owner = users.find(user =>
      user.memberId === memberId &&
      (user.accountStatus || 'active') !== 'deactivated'
    );
    if (!owner) return res.status(404).json({ error: 'Member not found.' });

    const title = clampText(req.body.project || req.body.title, 120);
    if (!title) return res.status(400).json({ error: 'Project name is required.' });

    const tenureNumbers = parseAdminTenureNumbers(req.body.tenureNumbers);
    if (!tenureNumbers.length) {
      return res.status(400).json({ error: 'At least one tenure number is required.' });
    }

    let tenures;
    try {
      tenures = await Promise.all(tenureNumbers.map(async tenureNumber => ({
        tenureNumber,
        geojson: await fetchTenureGeoJSON(tenureNumber),
      })));
    } catch (error) {
      return res.status(error.status || 502).json({ error: error.message || 'Could not load tenure geometry.' });
    }

    const rawStatus = String(req.body.status || 'Pending');
    const status = PROJECT_STATUSES.includes(rawStatus) ? rawStatus : 'Pending';
    const payload = {
      project: title,
      operator: clampText(req.body.operator, 120),
      description: clampText(req.body.description, 4000),
      tenures,
      commodities: Array.isArray(req.body.commodities)
        ? req.body.commodities.map(item => clampText(item, 120)).filter(Boolean)
        : splitListValue(req.body.commodities).map(item => clampText(item, 120)).filter(Boolean),
      depositTypes: Array.isArray(req.body.depositTypes)
        ? req.body.depositTypes.map(item => clampText(item, 120)).filter(Boolean)
        : splitListValue(req.body.depositTypes).map(item => clampText(item, 120)).filter(Boolean),
    };

    const submission = await saveProjectSubmission({
      owner,
      actor: req.user,
      payload,
      status,
      activityType: 'admin_project_created',
    });
    res.status(201).json({ ok: true, id: submission.id });
  };

  const run = submissionsWriteChain.catch(() => {}).then(doCreate);
  submissionsWriteChain = run.catch(() => {});

  try {
    await run;
  } catch (error) {
    console.error('admin create project:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not create project.' });
  }
});

app.post('/api/admin/project-status', requireAdminApi, async (req, res) => {
  try {
    const projectId = String(req.body.projectId || '');
    const status = String(req.body.status || '');
    const note = String(req.body.note || '').trim().slice(0, 500);
    if (!PROJECT_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${PROJECT_STATUSES.join(', ')}.` });
    }

    const projects = await listProjects();
    const project = projects.find(p => p.id === projectId);

    const ok = await setProjectStatus(projectId, status, {
      note,
      reviewer: memberDisplayName(req.user),
      at: new Date().toISOString(),
    });
    if (!ok) return res.status(404).json({ error: 'Project not found.' });

    if (project) notifyStatusChange(project, status, note);
    res.json({ ok: true });
  } catch (error) {
    console.error('project-status:', error.message);
    res.status(500).json({ error: 'Could not update the project status.' });
  }
});

function memberDisplayName(user) {
  return [user.firstName, user.lastName].filter(Boolean).join(' ') || 'A member';
}

// Activity and notification writes must never break the request that triggered
// them, so every call is wrapped.
async function safely(label, fn) {
  try {
    await fn();
  } catch (error) {
    console.error(`${label}:`, error.message);
  }
}

const STATUS_NOTIFICATIONS = {
  Approved: {
    type: 'project_approved',
    title: 'Project approved',
    body: p => `Your project "${p.title || p.id}" has been approved and is now visible to members.`,
  },
  Rejected: {
    type: 'project_rejected',
    title: 'Project not approved',
    body: p => `Your project "${p.title || p.id}" was not approved.`,
  },
  'Revisions Requested': {
    type: 'revision_requested',
    title: 'More information requested',
    body: p => `The NSPA team has requested revisions to your project "${p.title || p.id}".`,
  },
};

function notifyStatusChange(project, status, note) {
  const spec = STATUS_NOTIFICATIONS[status];
  if (!spec || !project.memberId) return;

  safely('notify status', () => {
    const body = note ? `${spec.body(project)}\n\nNote from the reviewer: ${note}` : spec.body(project);
    return portal.addNotification({
      memberId: project.memberId,
      type: spec.type,
      title: spec.title,
      body,
      link: '/dashboard.html',
    });
  });

  // Every status change lands on the project's timeline; only approvals are
  // interesting enough for the association-wide activity feed, so the feed
  // filters on type rather than being written to selectively.
  safely('activity status', () =>
    portal.recordActivity({
      type: status === 'Approved' ? 'project_approved' : 'project_status_changed',
      projectId: project.id,
      projectTitle: project.title,
      summary:
        status === 'Approved'
          ? `Project "${project.title || project.id}" was approved`
          : `Status changed to ${status}${note ? ` — ${note}` : ''}`,
    })
  );
}

registerPortalRoutes(app, { portal, visibleProjectsFor, readSubmissions, splitListValue });

registerContentRoutes(app, {
  DATA_DIR,
  DOCUMENT_MAX_SIZE,
  safeDocumentFileName,
  requireAdminApi,
  documentValidationError,
  describeUploadError,
  discardUploadedFiles,
  USE_SUPABASE,
  supabase,
  portal,
  isAdmin,
  safely,
  clampInt,
});

/* ── Membership expiry notifications ───────────────────────────────────────
 * Swept on boot and daily thereafter. The dedupe key includes the expiry date
 * so each member is warned once per membership year, and again once it lapses.
 * ──────────────────────────────────────────────────────────────────────────── */

const EXPIRY_WARNING_DAYS = 30;

async function sweepMembershipNotifications() {
  const users = await listUsers();
  const nowMs = Date.now();

  for (const user of users) {
    if (!user.memberId || (user.accountStatus || 'active') === 'deactivated') continue;
    if (!user.membershipExpiry) continue;

    const expiry = new Date(user.membershipExpiry);
    if (Number.isNaN(expiry.getTime())) continue;

    const day = expiry.toISOString().slice(0, 10);
    const daysLeft = Math.ceil((expiry.getTime() - nowMs) / (24 * 60 * 60 * 1000));

    if (daysLeft < 0 && user.membershipStatus !== 'active') {
      await portal.addNotification({
        memberId: user.memberId,
        type: 'membership_expired',
        title: 'Your membership has expired',
        body: `Your NSPA membership expired on ${day}. Renew to restore access to the project form, network, and map. Your projects and member ID are kept.`,
        link: '/membership.html',
        dedupeKey: `membership_expired:${day}`,
      });
    } else if (daysLeft >= 0 && daysLeft <= EXPIRY_WARNING_DAYS && user.membershipStatus === 'active') {
      await portal.addNotification({
        memberId: user.memberId,
        type: 'membership_expiring',
        title: 'Your membership expires soon',
        body: `Your NSPA membership expires on ${day} (${daysLeft} day${daysLeft === 1 ? '' : 's'} away). Renew to keep member access without interruption.`,
        link: '/membership.html',
        dedupeKey: `membership_expiring:${day}`,
      });
    }
  }
}

function startMembershipSweep() {
  const run = () =>
    sweepMembershipNotifications().catch(e => console.error('membership sweep:', e.message));
  run();
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  timer.unref(); // allow process exit
}

/* ── Admin: removing projects ────────────────────────────────────────────
 * Two levels, deliberately. Archiving is the everyday action: the project
 * disappears from every member-facing view but the row, its documents and its
 * history all survive, so a mistake costs nothing. Permanent deletion is a
 * separate, explicit step for genuine junk — duplicates, spam, test rows.
 * ──────────────────────────────────────────────────────────────────────────── */

async function doSetProjectArchived(projectId, archived) {
  if (USE_SUPABASE) {
    const updated = await supabase.update('projects', supabase.eq('id', projectId), { archived: !!archived });
    invalidateProjectsCache();
    return !!(updated && updated.length);
  }

  const { wb, ws } = await getProjectsSheet();
  let updated = false;
  ws.eachRow((row, n) => {
    if (n === 1 || updated) return;
    if (cellText(row.getCell(PROJECT_ID_COL)) !== projectId) return;
    row.getCell(PROJECT_ARCHIVED_COL).value = archived ? 'Yes' : '';
    updated = true;
  });
  if (updated) {
    await writeWorkbookAtomic(wb, PROJECTS_XLSX);
    invalidateProjectsCache();
  }
  return updated;
}

function setProjectArchived(projectId, archived) {
  const run = projectsWriteChain.catch(() => {}).then(() => doSetProjectArchived(projectId, archived));
  projectsWriteChain = run.catch(() => {});
  return run;
}

app.post('/api/admin/projects/:id/archive', requireAdminApi, async (req, res) => {
  try {
    const projectId = String(req.params.id);
    const archived = req.body.archived !== false; // default to archiving

    const project = (await listProjects()).find(p => p.id === projectId);
    if (!project) return res.status(404).json({ error: 'Project not found.' });

    const ok = await setProjectArchived(projectId, archived);
    if (!ok) return res.status(404).json({ error: 'Project not found.' });

    // The owner should know their project was pulled from view.
    if (project.memberId) {
      safely('notify archive', () =>
        portal.addNotification({
          memberId: project.memberId,
          type: archived ? 'project_archived' : 'project_restored',
          title: archived ? 'A project was removed from view' : 'A project was restored',
          body: archived
            ? `"${project.title || projectId}" has been removed from the member views by the NSPA team. Your submission and documents are kept — contact us if this looks wrong.`
            : `"${project.title || projectId}" is visible again.`,
          link: '/dashboard.html',
        })
      );
    }

    console.log(`admin ${req.user.email} ${archived ? 'archived' : 'restored'} ${projectId}`);
    res.json({ ok: true, archived });
  } catch (error) {
    console.error('archive project:', error.message);
    res.status(500).json({ error: 'Could not update the project.' });
  }
});

/**
 * Permanent deletion. Removes the project row, the submission record, every
 * uploaded document, and the portal.db rows that point at the project.
 * Requires the caller to echo the project id back before deletion.
 */
app.delete('/api/admin/projects/:id', requireAdminApi, async (req, res) => {
  const projectId = String(req.params.id);

  if (String(req.body.confirm || '') !== projectId) {
    return res.status(400).json({
      error: 'To delete permanently, confirm with the exact project ID.',
    });
  }

  const run = submissionsWriteChain.catch(() => {}).then(async () => {
    const projects = await listProjects();
    const project = projects.find(p => p.id === projectId);
    if (!project) return res.status(404).json({ error: 'Project not found.' });

    // 1. Remove the project row from the active data store.
    if (USE_SUPABASE) {
      await supabase.remove('projects', supabase.eq('id', projectId));
      invalidateProjectsCache();
    } else {
      const { wb, ws } = await getProjectsSheet();
      let removedRow = false;
      for (let n = ws.rowCount; n >= 2; n--) {
        if (cellText(ws.getRow(n).getCell(PROJECT_ID_COL)) === projectId) {
          ws.spliceRows(n, 1);
          removedRow = true;
        }
      }
      if (removedRow) {
        await writeWorkbookAtomic(wb, PROJECTS_XLSX);
        invalidateProjectsCache();
      }
    }

    // 2. Remove the submission and its uploaded files.
    const submissions = await readSubmissions();
    const kept = submissions.filter(s => s.id !== projectId);
    const documentCount = (submissions.find(s => s.id === projectId) || {}).documents?.length || 0;
    await writeSubmissions(kept);
    if (USE_SUPABASE) {
      await Promise.all(
        ((submissions.find(s => s.id === projectId) || {}).documents || [])
          .map(doc => supabase.deleteObject(`projects/${projectId}/${doc.storedName}`).catch(e => {
            console.warn('project object delete:', e.message);
          }))
      );
    } else {
      await fs.rm(path.join(UPLOADS_DIR, projectId), { recursive: true, force: true });
    }

    // 3. Remove what the portal layer holds about it.
    const purged = await portal.purgeProjectRecords(projectId);

    console.warn(
      `admin ${req.user.email} PERMANENTLY DELETED ${projectId} ` +
      `(${documentCount} document(s), ${purged.favourites} favourite(s), ${purged.activity} activity row(s))`
    );

    res.json({ ok: true, deleted: projectId, documents: documentCount, ...purged });
  });

  submissionsWriteChain = run.catch(() => {});
  try {
    await run;
  } catch (error) {
    console.error('delete project:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not delete the project.' });
  }
});

/* ── Backups ───────────────────────────────────────────────────────────── */

const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BACKUP_START_DELAY_MS = 5 * 60 * 1000;
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP || 7);
const BACKUP_EMAIL_MAX_BYTES = Number(process.env.BACKUP_EMAIL_MAX_BYTES || 20 * 1024 * 1024);

const backupService = createBackupService({
  backup,
  portal,
  supabase,
  useSupabase: USE_SUPABASE,
  dataDir: DATA_DIR,
  keep: BACKUP_KEEP,
  adminEmails: ADMIN_EMAILS,
  appBaseUrl: APP_BASE_URL,
  emailMaxBytes: BACKUP_EMAIL_MAX_BYTES,
  sendMailIfConfigured,
  sendMailAwaited,
  safely,
});

function startBackups() {
  if (process.env.BACKUPS === 'off') {
    console.log('  ⓘ Backups disabled (BACKUPS=off).');
    return;
  }
  setTimeout(() => backupService.runBackup({ kind: 'core' }), BACKUP_START_DELAY_MS).unref();
  setInterval(() => backupService.runBackup({ kind: 'core' }), BACKUP_INTERVAL_MS).unref();
}

registerBackupRoutes(app, {
  dataDir: DATA_DIR,
  backupService,
  requireAdminApi,
  emailConfigured: !!mailer,
});

/* ── Admin (staff) view of members ──────────────────────────────────────── */

function isAdmin(user) {
  return !!user && ADMIN_EMAILS.includes(String(user.email).toLowerCase());
}

function requireAdminApi(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin access required.' });
  next();
}

function requireAdminPage(req, res, next) {
  if (!req.user) return res.redirect(WIX_MEMBER_LOGIN_URL || '/signup.html');
  if (!isAdmin(req.user)) return res.redirect('/membership.html');
  next();
}

async function listUsers() {
  if (USE_SUPABASE) {
    const rows = await supabase.select('members', 'select=*&order=created_at.desc');
    return Promise.all(rows.map(async row => {
      const user = supabaseMemberToUser(row);
      return {
        ...user,
        studentVerification: publicStudentVerification(await portal.getStudentVerification(user.memberId)),
        hasSubscription: !!user.subscriptionId,
      };
    }));
  }

  const { ws } = await getUsersSheet();
  const users = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const email = cellText(row.getCell(EMAIL_COL));
    if (!email) return;
    users.push({
      memberId: cellText(row.getCell(MEMBER_ID_COL)),
      createdAt: cellText(row.getCell(2)),
      firstName: cellText(row.getCell(3)),
      lastName: cellText(row.getCell(4)),
      email,
      phone: cellText(row.getCell(6)),
      membershipStatus: cellText(row.getCell(MEMBERSHIP_STATUS_COL)) || 'none',
      memberSince: cellText(row.getCell(MEMBER_SINCE_COL)),
      accountStatus: cellText(row.getCell(ACCOUNT_STATUS_COL)) || 'active',
      membershipExpiry: cellText(row.getCell(MEMBERSHIP_EXPIRY_COL)),
      networkStatus: cellText(row.getCell(NETWORK_STATUS_COL)) || 'out',
      networkVisibility: parseNetworkVisibility(cellText(row.getCell(NETWORK_VISIBILITY_COL))),
      profile: parseProfile(cellText(row.getCell(PROFILE_COL))),
      studentVerification: null,
      hasSubscription: !!cellText(row.getCell(SUBSCRIPTION_COL)),
    });
  });
  return Promise.all(users.map(async user => ({
    ...user,
    studentVerification: publicStudentVerification(await portal.getStudentVerification(user.memberId)),
  })));
}

registerAdminRoutes(app, {
  requireAdminApi,
  verifyMailer,
  mailer,
  mailFrom: MAIL_FROM,
  listUsers,
  listProjects,
  isActiveMember,
  projectStatuses: PROJECT_STATUSES,
  zeffyStudentUrl: ZEFFY_STUDENT_URL,
  zeffyRegularUrl: ZEFFY_REGULAR_URL,
  getMailStatus: () => mailStatus,
  portal,
  activateMembership,
  updateMembership,
});

/* ── Membership persistence ─────────────────────────────────────────────── */

async function doUpdateMembership(email, updates) {
  if (USE_SUPABASE) {
    const patch = {};
    if (updates.firstName !== undefined) patch.first_name = updates.firstName;
    if (updates.lastName !== undefined) patch.last_name = updates.lastName;
    if (updates.phone !== undefined) patch.phone = updates.phone;
    if (updates.passwordHash !== undefined) patch.password_hash = updates.passwordHash;
    if (updates.paymentCustomerId !== undefined) patch.payment_customer_id = updates.paymentCustomerId;
    if (updates.subscriptionId !== undefined) patch.subscription_id = updates.subscriptionId;
    if (updates.membershipStatus !== undefined) patch.membership_status = updates.membershipStatus;
    if (updates.memberSince !== undefined) patch.member_since = updates.memberSince || null;
    if (updates.accountStatus !== undefined) patch.account_status = updates.accountStatus;
    if (updates.membershipExpiry !== undefined) patch.membership_expiry = updates.membershipExpiry || null;
    if (updates.networkStatus !== undefined) patch.network_status = updates.networkStatus;
    if (updates.networkVisibility !== undefined) patch.network_visibility = parseNetworkVisibility(updates.networkVisibility);
    if (updates.profile !== undefined) patch.profile = parseProfile(updates.profile);

    const lower = String(email).toLowerCase();
    const updated = await supabase.update('members', supabase.eq('email_lc', lower), patch);
    invalidateSessionUser(lower);
    invalidateMemberStates();
    return !!(updated && updated.length);
  }

  const { wb, ws } = await getUsersSheet();
  const lower = String(email).toLowerCase();
  let updated = false;
  ws.eachRow((row, n) => {
    if (n === 1 || updated) return;
    if (cellText(row.getCell(EMAIL_COL)).toLowerCase() !== lower) return;
    if (updates.firstName !== undefined)        row.getCell(3).value = updates.firstName;
    if (updates.lastName !== undefined)         row.getCell(4).value = updates.lastName;
    if (updates.phone !== undefined)            row.getCell(6).value = updates.phone;
    if (updates.passwordHash !== undefined)     row.getCell(PASSWORD_HASH_COL).value = updates.passwordHash;
    if (updates.paymentCustomerId !== undefined) row.getCell(PAYMENT_CUSTOMER_COL).value = updates.paymentCustomerId;
    if (updates.subscriptionId !== undefined)   row.getCell(SUBSCRIPTION_COL).value = updates.subscriptionId;
    if (updates.membershipStatus !== undefined) row.getCell(MEMBERSHIP_STATUS_COL).value = updates.membershipStatus;
    if (updates.memberSince !== undefined)      row.getCell(MEMBER_SINCE_COL).value = updates.memberSince;
    if (updates.accountStatus !== undefined)    row.getCell(ACCOUNT_STATUS_COL).value = updates.accountStatus;
    if (updates.membershipExpiry !== undefined) row.getCell(MEMBERSHIP_EXPIRY_COL).value = updates.membershipExpiry;
    if (updates.networkStatus !== undefined)    row.getCell(NETWORK_STATUS_COL).value = updates.networkStatus;
    if (updates.networkVisibility !== undefined) row.getCell(NETWORK_VISIBILITY_COL).value = updates.networkVisibility;
    if (updates.profile !== undefined)          row.getCell(PROFILE_COL).value = updates.profile; // serialized JSON
    updated = true;
  });
  if (updated) await writeWorkbookAtomic(wb, USERS_XLSX);
  invalidateSessionUser(lower);
  // Membership state drives project visibility, so a change here must be
  // reflected immediately in the map, search, and project pages.
  invalidateMemberStates();
  return updated;
}

function updateMembership(email, updates) {
  const run = usersWriteChain.catch(() => {}).then(() => doUpdateMembership(email, updates));
  usersWriteChain = run.catch(() => {});
  return run;
}

async function activateMembership(email, paymentCustomerId, paymentReferenceId) {
  if (!email) return;
  const user = await findUserByEmail(email);
  // A first-time member has no memberSince yet (their member ID was only just
  // issued). The July-1 bonus applies to them, not to lapsed-member renewals.
  const newMember = !user || !user.memberSince;
  const updates = { membershipStatus: 'active', membershipExpiry: membershipExpiryDate({ newMember }) };
  if (paymentCustomerId) updates.paymentCustomerId = paymentCustomerId;
  if (paymentReferenceId) updates.subscriptionId = paymentReferenceId;
  if (newMember) updates.memberSince = new Date().toISOString();
  await updateMembership(email, updates);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function emailDomain(email) {
  return normalizeEmail(email).split('@')[1] || '';
}

function studentDomainAllowed(domain) {
  if (!STUDENT_EMAIL_DOMAINS.length) return true;
  return STUDENT_EMAIL_DOMAINS.some(allowed => domain === allowed || domain.endsWith(`.${allowed}`));
}

function hashStudentCode(memberId, schoolEmail, code) {
  return crypto
    .createHash('sha256')
    .update(`${SESSION_SECRET}:${memberId}:${normalizeEmail(schoolEmail)}:${code}`)
    .digest('hex');
}

async function studentVerificationOk(memberId) {
  const record = await portal.getStudentVerification(memberId);
  if (!record || record.status !== 'verified') return false;
  return studentDomainAllowed(record.emailDomain || emailDomain(record.schoolEmail));
}

registerMembershipRoutes(app, {
  requireAuth,
  portal,
  mailer,
  mailFrom: MAIL_FROM,
  normalizeEmail,
  emailDomain,
  studentDomainAllowed,
  hashStudentCode,
  publicStudentVerification,
  clampText,
  studentVerificationOk,
  zeffyStudentUrl: ZEFFY_STUDENT_URL,
  zeffyRegularUrl: ZEFFY_REGULAR_URL,
  studentEmailDomains: STUDENT_EMAIL_DOMAINS,
});

const metalPriceService = createMetalPriceService();
const getMetalPrices = withCache(metalPriceService.loadMetalPrices, 3 * 60 * 1000);
registerPriceRoutes(app, { getMetalPrices });

// Periodic claim sweep. The first run is delayed so start-up isn't competing
// with NovaROC requests, and `unref()` keeps the timer from holding the
// process open during tests.
function startClaimWatch() {
  if (process.env.CLAIM_WATCH === 'off') {
    console.log('  ⓘ Claim watch disabled (CLAIM_WATCH=off).');
    return;
  }
  setTimeout(() => { runClaimWatchNow(); }, CLAIM_WATCH_START_DELAY_MS).unref();
  setInterval(() => { runClaimWatchNow(); }, CLAIM_WATCH_INTERVAL_MS).unref();
}

// 0.0.0.0 so the container is reachable from outside it. Node defaults to
// this, but hosts expect it stated.
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`NSPA form running at http://localhost:${PORT}`);
  console.log(`  data directory: ${DATA_DIR}`);
  startMembershipSweep();
  startClaimWatch();
  startBackups();

  // Say plainly whether email will work, and exactly what to fix if not.
  if (!mailer) {
    console.log('  ⓘ Email off — claim alerts are in-app only.');
    console.log('    To enable: set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM in .env (see .env.example).');
  } else {
    verifyMailer().then(status => {
      if (status.verified) {
        console.log(`  ✓ Email ready via ${SMTP_HOST}:${SMTP_PORT} as ${SMTP_USER || '(no auth)'}`);
      } else {
        console.log(`  ⚠ SMTP configured but the server rejected it: ${status.error}`);
        console.log('    Alerts will still arrive in-app. Check SMTP_USER / SMTP_PASS.');
      }
    });
  }
  if (!ZEFFY_STUDENT_URL || !ZEFFY_REGULAR_URL) {
    console.log('  ⚠ Zeffy checkout not fully configured — set ZEFFY_STUDENT_URL and ZEFFY_REGULAR_URL in .env');
  }
  if (!process.env.METALPRICE_API_KEY) {
    console.log('  ⚠ METALPRICE_API_KEY not set — metal prices will be unavailable.');
  }
});

const SHUTDOWN_TIMEOUT_MS = 15000;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — finishing in-flight writes before exit.`);

  // Stop accepting new connections; existing ones are allowed to finish.
  server.close(() => console.log('  http server closed'));

  const drained = Promise.allSettled([
    usersWriteChain,
    projectsWriteChain,
    submissionsWriteChain,
  ]).then(() => console.log('  pending writes drained'));

  const timeout = new Promise(resolve =>
    setTimeout(() => { console.warn('  shutdown timed out — exiting anyway'); resolve(); },
      SHUTDOWN_TIMEOUT_MS)
  );

  await Promise.race([drained, timeout]);

  try {
    portal.db.close();          // checkpoints the WAL so nothing is left behind
    console.log('  database closed');
  } catch (error) {
    console.warn('  database close:', error.message);
  }

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
