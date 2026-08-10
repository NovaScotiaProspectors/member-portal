const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

function registerContentRoutes(app, ctx) {
  const {
    DATA_DIR, DOCUMENT_MAX_SIZE, safeDocumentFileName, requireAdminApi,
    documentValidationError, describeUploadError, discardUploadedFiles,
    USE_SUPABASE, supabase, portal, isAdmin, safely, clampInt,
  } = ctx;

  /* ── Events ─────────────────────────────────────────────────────────────── */
  
  const EVENT_FILES_DIR = path.join(DATA_DIR, 'event-files');
  const EVENT_FILE_MAX_COUNT = 6;
  
  const eventUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        require('fs').mkdirSync(EVENT_FILES_DIR, { recursive: true });
        cb(null, EVENT_FILES_DIR);
      },
      filename: (req, file, cb) =>
        cb(null, `${crypto.randomBytes(8).toString('hex')}__${safeDocumentFileName(file.originalname)}`),
    }),
    limits: { fileSize: DOCUMENT_MAX_SIZE, files: EVENT_FILE_MAX_COUNT },
  });
  
  function describeEventUploadError(err) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return `Each event file must be ${DOCUMENT_MAX_SIZE / (1024 * 1024)} MB or smaller.`;
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return `You can upload at most ${EVENT_FILE_MAX_COUNT} files per event.`;
    }
    return 'Could not process the event files.';
  }
  
  // Members see upcoming events only, in chronological order. Past events are
  // hidden automatically; they appear in an archive section only when an admin
  // has enabled it (admins always see them, so they can decide).
  app.get('/api/events', async (req, res) => {
    try {
      const all = await portal.listEvents(req.user.memberId);
      const archiveEnabled = !!(await portal.getSetting('eventsArchiveEnabled', false));
      const admin = isAdmin(req.user);
  
      res.json({
        events: all.filter(e => !e.isPast),
        pastEvents: archiveEnabled || admin ? all.filter(e => e.isPast).reverse() : [],
        archiveEnabled,
        categories: portal.EVENT_CATEGORIES,
      });
    } catch (error) {
      console.error('events:', error.message);
      res.status(500).json({ error: 'Could not load events.' });
    }
  });
  
  // Admin: toggle whether members can browse the past-events archive.
  app.post('/api/admin/events-archive', requireAdminApi, async (req, res) => {
    try {
      const enabled = !!req.body.enabled;
      await portal.setSetting('eventsArchiveEnabled', enabled);
      res.json({ ok: true, archiveEnabled: enabled });
    } catch (error) {
      console.error('events archive toggle:', error.message);
      res.status(500).json({ error: 'Could not update the archive setting.' });
    }
  });
  
  app.get('/api/events/:id/files/:fileId/download', async (req, res) => {
    try {
      const file = await portal.findEventFile(req.params.id, req.params.fileId);
      if (!file) return res.status(404).json({ error: 'File not found.' });
  
      if (USE_SUPABASE) {
        const data = await supabase.downloadObject(`events/${file.storedName}`);
        res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${safeDocumentFileName(file.fileName || 'event-file')}"`);
        return res.send(data);
      }
  
      const filePath = path.resolve(EVENT_FILES_DIR, file.storedName);
      if (!filePath.startsWith(EVENT_FILES_DIR + path.sep)) {
        return res.status(400).json({ error: 'Invalid file path.' });
      }
  
      res.download(filePath, file.fileName || 'event-file', err => {
        if (err && !res.headersSent) {
          res.status(404).json({ error: 'The event file is missing on the server.' });
        }
      });
    } catch (error) {
      console.error('event file download:', error.message);
      res.status(500).json({ error: 'Could not download the event file.' });
    }
  });
  
  app.get('/api/events/:id/files/:fileId/view', async (req, res) => {
    try {
      const file = await portal.findEventFile(req.params.id, req.params.fileId);
      if (!file) return res.status(404).json({ error: 'File not found.' });
      if (!String(file.mimeType || '').startsWith('image/')) {
        return res.status(400).json({ error: 'This event file is not an image.' });
      }
  
      if (USE_SUPABASE) {
        const data = await supabase.downloadObject(`events/${file.storedName}`);
        res.type(file.mimeType || 'application/octet-stream');
        return res.send(data);
      }
  
      const filePath = path.resolve(EVENT_FILES_DIR, file.storedName);
      if (!filePath.startsWith(EVENT_FILES_DIR + path.sep)) {
        return res.status(400).json({ error: 'Invalid file path.' });
      }
  
      res.type(file.mimeType || 'application/octet-stream');
      res.sendFile(filePath);
    } catch (error) {
      console.error('event file view:', error.message);
      res.status(500).json({ error: 'Could not open the event image.' });
    }
  });
  
  app.post('/api/admin/events', requireAdminApi, (req, res) => {
    eventUpload.array('files', EVENT_FILE_MAX_COUNT)(req, res, async err => {
      if (err) {
        return res.status(400).json({ error: describeEventUploadError(err) });
      }
  
      const cleanup = () => discardUploadedFiles(req.files || []);
  
      try {
        const title = String(req.body.title || '').trim();
        const category = String(req.body.category || '').trim();
        const startsAt = String(req.body.startsAt || '').trim();
  
        const fail = message => {
          cleanup();
          return res.status(400).json({ error: message });
        };
  
        if (!title) return fail('An event title is required.');
        if (!portal.EVENT_CATEGORIES.includes(category)) {
          return fail(`Category must be one of: ${portal.EVENT_CATEGORIES.join(', ')}.`);
        }
        if (Number.isNaN(new Date(startsAt).getTime())) {
          return fail('A valid start date and time is required.');
        }
  
        const capacityRaw = req.body.capacity;
        const capacity =
          capacityRaw === '' || capacityRaw == null ? null : Number.parseInt(capacityRaw, 10);
        if (capacity != null && (Number.isNaN(capacity) || capacity < 1)) {
          return fail('Capacity must be a positive number, or left blank.');
        }
  
        for (const file of req.files || []) {
          const invalid = documentValidationError(file);
          if (invalid) return fail(invalid);
        }
  
        if (USE_SUPABASE) {
          for (const file of req.files || []) {
            await supabase.uploadFile(`events/${file.filename}`, file.path, file.mimetype || 'application/octet-stream');
            await fs.unlink(file.path).catch(() => {});
          }
        }
  
        const id = await portal.createEvent({
          title,
          category,
          description: String(req.body.description || '').trim(),
          location: String(req.body.location || '').trim(),
          startsAt: new Date(startsAt).toISOString(),
          endsAt: req.body.endsAt ? new Date(req.body.endsAt).toISOString() : null,
          capacity,
          registrationOpen: false,
          createdBy: req.user.email,
          files: (req.files || []).map(file => ({
            fileName: file.originalname,
            storedName: file.filename,
            size: file.size,
            mimeType: file.mimetype,
          })),
        });
  
        safely('activity event', () =>
          portal.recordActivity({
            type: 'event_created',
            actorName: 'NSPA',
            summary: `New ${category.replace(/_/g, ' ')}: "${title}"`,
          })
        );
  
        res.status(201).json({ ok: true, id });
      } catch (error) {
        console.error('create event:', error.message);
        cleanup();
        res.status(500).json({ error: 'Could not create the event.' });
      }
    });
  });
  
  app.get('/api/admin/events/:id/registrants', requireAdminApi, async (req, res) => {
    try {
      res.json({ registrants: await portal.listRegistrants(req.params.id) });
    } catch (error) {
      console.error('registrants:', error.message);
      res.status(500).json({ error: 'Could not load registrants.' });
    }
  });
  
  app.delete('/api/admin/events/:id', requireAdminApi, async (req, res) => {
    try {
      const files = await portal.listEventFiles(req.params.id);
      const ok = await portal.removeEvent(req.params.id);
      if (!ok) return res.status(404).json({ error: 'Event not found.' });
      for (const file of files) {
        if (USE_SUPABASE) {
          await supabase.deleteObject(`events/${file.storedName}`).catch(e => console.warn('event file delete:', e.message));
        } else {
          await fs.unlink(path.join(EVENT_FILES_DIR, file.storedName)).catch(e => {
            if (e.code !== 'ENOENT') console.warn('event file unlink:', e.message);
          });
        }
      }
      res.json({ ok: true });
    } catch (error) {
      console.error('delete event:', error.message);
      res.status(500).json({ error: 'Could not delete the event.' });
    }
  });
  
  /* ── Resource library ───────────────────────────────────────────────────── */
  
  const RESOURCES_DIR = path.join(DATA_DIR, 'resources');
  
  const resourceUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        require('fs').mkdirSync(RESOURCES_DIR, { recursive: true });
        cb(null, RESOURCES_DIR);
      },
      filename: (req, file, cb) =>
        cb(null, `${crypto.randomBytes(8).toString('hex')}__${safeDocumentFileName(file.originalname)}`),
    }),
    limits: { fileSize: DOCUMENT_MAX_SIZE, files: 1 },
  });
  
  app.get('/api/resources', async (req, res) => {
    try {
      const limit = clampInt(req.query.limit, 20, 1, 100);
      const offset = clampInt(req.query.offset, 0, 0, 100000);
      const category = String(req.query.category || '').trim();
      const query = String(req.query.q || '').trim().slice(0, 120);
  
      if (category && !portal.RESOURCE_CATEGORIES.some(c => c.value === category)) {
        return res.status(400).json({ error: 'Unknown category.' });
      }
  
      const result = await portal.listResources({ category, query, limit, offset });
      res.json({ ...result, categories: portal.RESOURCE_CATEGORIES });
    } catch (error) {
      console.error('resources:', error.message);
      res.status(500).json({ error: 'Could not load the resource library.' });
    }
  });
  
  app.get('/api/resources/:id/download', async (req, res) => {
    try {
      const resource = await portal.findResource(req.params.id);
      if (!resource) return res.status(404).json({ error: 'Resource not found.' });
      if (!resource.stored_name) {
        return res.status(404).json({ error: 'This resource is a link, not a file.' });
      }
  
      if (USE_SUPABASE) {
        const data = await supabase.downloadObject(`resources/${resource.stored_name}`);
        res.setHeader('Content-Type', resource.mime_type || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${safeDocumentFileName(resource.file_name || 'resource')}"`);
        return res.send(data);
      }
  
      const filePath = path.resolve(RESOURCES_DIR, resource.stored_name);
      if (!filePath.startsWith(RESOURCES_DIR + path.sep)) {
        return res.status(400).json({ error: 'Invalid resource path.' });
      }
  
      res.download(filePath, resource.file_name || 'resource', err => {
        if (err && !res.headersSent) {
          res.status(404).json({ error: 'The resource file is missing on the server.' });
        }
      });
    } catch (error) {
      console.error('resource download:', error.message);
      res.status(500).json({ error: 'Could not download the resource.' });
    }
  });
  
  app.post('/api/admin/resources', requireAdminApi, (req, res) => {
    resourceUpload.single('file')(req, res, async err => {
      if (err) {
        return res.status(400).json({ error: describeUploadError(err) });
      }
  
      try {
        const title = String(req.body.title || '').trim();
        const category = String(req.body.category || '').trim();
        const externalUrl = String(req.body.externalUrl || '').trim();
  
        const fail = message => {
          if (req.file) fs.unlink(req.file.path).catch(() => {});
          return res.status(400).json({ error: message });
        };
  
        if (!title) return fail('A resource title is required.');
        if (!portal.RESOURCE_CATEGORIES.some(c => c.value === category)) return fail('Unknown category.');
        if (!req.file && !externalUrl) return fail('Attach a file or provide a link.');
        if (req.file) {
          const invalid = documentValidationError(req.file);
          if (invalid) return fail(invalid);
        }
        if (externalUrl && !/^https?:\/\//i.test(externalUrl)) {
          return fail('Links must start with http:// or https://');
        }
  
        if (USE_SUPABASE && req.file) {
          await supabase.uploadFile(`resources/${req.file.filename}`, req.file.path, req.file.mimetype || 'application/octet-stream');
          await fs.unlink(req.file.path).catch(() => {});
        }
  
        const id = await portal.createResource({
          title,
          category,
          description: String(req.body.description || '').trim(),
          fileName: req.file ? req.file.originalname : null,
          storedName: req.file ? req.file.filename : null,
          size: req.file ? req.file.size : null,
          mimeType: req.file ? req.file.mimetype : null,
          externalUrl: externalUrl || null,
          uploadedBy: req.user.email,
        });
  
        safely('activity resource', () =>
          portal.recordActivity({
            type: 'resource_added',
            actorName: 'NSPA',
            summary: `New resource in the library: "${title}"`,
          })
        );
  
        res.status(201).json({ ok: true, id });
      } catch (error) {
        console.error('create resource:', error.message);
        if (req.file) fs.unlink(req.file.path).catch(() => {});
        res.status(500).json({ error: 'Could not add the resource.' });
      }
    });
  });
  
  app.delete('/api/admin/resources/:id', requireAdminApi, async (req, res) => {
    try {
      const resource = await portal.findResource(req.params.id);
      if (!resource) return res.status(404).json({ error: 'Resource not found.' });
  
      await portal.removeResource(resource.id);
      if (resource.stored_name) {
        if (USE_SUPABASE) {
          await supabase.deleteObject(`resources/${resource.stored_name}`).catch(e => console.warn('resource delete:', e.message));
        } else {
          await fs.unlink(path.join(RESOURCES_DIR, resource.stored_name)).catch(e => {
            if (e.code !== 'ENOENT') console.warn('resource unlink:', e.message);
          });
        }
      }
      res.json({ ok: true });
    } catch (error) {
      console.error('delete resource:', error.message);
      res.status(500).json({ error: 'Could not remove the resource.' });
    }
  });
}

module.exports = { registerContentRoutes };
