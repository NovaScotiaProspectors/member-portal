const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const AVATAR_MAX_SIZE = 2 * 1024 * 1024;
const AVATAR_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png' };

function registerProfileRoutes(app, ctx) {
  const {
    uploadsDir,
    useSupabase,
    supabase,
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
  } = ctx;

  const avatarsDir = path.join(uploadsDir, 'avatars');
  const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: AVATAR_MAX_SIZE, files: 1 },
  });

  const avatarObjectPath = stored => `avatars/${path.basename(stored)}`;

  async function storeAvatar(stored, data, contentType) {
    if (useSupabase) {
      await supabase.uploadObject(avatarObjectPath(stored), data, contentType);
      return;
    }
    await fs.mkdir(avatarsDir, { recursive: true });
    await fs.writeFile(path.join(avatarsDir, path.basename(stored)), data);
  }

  async function removeAvatar(stored) {
    if (!stored) return;
    const fileName = path.basename(stored);
    if (useSupabase) {
      await supabase.deleteObject(avatarObjectPath(fileName)).catch(error => {
        console.warn('avatar storage delete:', error.message);
      });
    }
    await fs.unlink(path.join(avatarsDir, fileName)).catch(() => {});
  }

  async function loadAvatar(stored) {
    const fileName = path.basename(stored);
    if (useSupabase) {
      try {
        return await supabase.downloadObject(avatarObjectPath(fileName));
      } catch (storageError) {
        // Preserve access to avatars created before Supabase Storage was used,
        // when a persistent local data disk is still attached.
        try {
          return await fs.readFile(path.join(avatarsDir, fileName));
        } catch {
          throw storageError;
        }
      }
    }
    return fs.readFile(path.join(avatarsDir, fileName));
  }

  app.get('/api/profile', requireAuth, async (req, res) => {
    res.json({
      member: await publicMember(req.user),
      profile: req.user.profile || parseProfile(null),
      visibility: parseNetworkVisibility(req.user.networkVisibility),
      networkStatus: req.user.networkStatus || 'out',
    });
  });

  app.put('/api/profile', requireAuth, async (req, res) => {
    try {
      const clean = cleanProfile(req.body.profile);
      clean.avatar = (req.user.profile && req.user.profile.avatar) || '';

      const updates = { profile: JSON.stringify(clean) };
      if (req.body.phone !== undefined) updates.phone = clampText(req.body.phone, 30);
      if (req.body.visibility !== undefined) {
        updates.networkVisibility = serializeNetworkVisibility(req.body.visibility);
      }

      await updateMembership(req.user.email, updates);
      invalidateSessionUser(req.user.email);
      res.json({ ok: true, profile: clean });
    } catch (error) {
      console.error('profile update:', error.message);
      res.status(500).json({ error: 'Could not save your profile.' });
    }
  });

  app.post('/api/profile/avatar', requireAuth, (req, res) => {
    avatarUpload.single('avatar')(req, res, async err => {
      try {
        if (err) {
          const msg = err.code === 'LIMIT_FILE_SIZE'
            ? 'Profile pictures must be 2 MB or smaller.'
            : 'Could not process the image.';
          return res.status(400).json({ error: msg });
        }
        if (!req.file) return res.status(400).json({ error: 'Choose an image to upload.' });

        const ext = AVATAR_TYPES[req.file.mimetype];
        const nameExt = path.extname(req.file.originalname || '').toLowerCase();
        if (!ext || !['.jpg', '.jpeg', '.png'].includes(nameExt)) {
          return res.status(400).json({ error: 'Profile pictures must be JPG or PNG.' });
        }

        const stored = `${req.user.memberId}__${crypto.randomBytes(6).toString('hex')}${ext}`;
        await storeAvatar(stored, req.file.buffer, req.file.mimetype);

        const previous = req.user.profile && req.user.profile.avatar;
        try {
          const profile = parseProfile(req.user.profile);
          profile.avatar = stored;
          await updateMembership(req.user.email, { profile: JSON.stringify(profile) });
          invalidateSessionUser(req.user.email);
        } catch (error) {
          await removeAvatar(stored);
          throw error;
        }
        await removeAvatar(previous);

        res.json({ ok: true });
      } catch (error) {
        console.error('avatar upload:', error.message);
        res.status(500).json({ error: 'Could not save your profile picture.' });
      }
    });
  });

  app.delete('/api/profile/avatar', requireAuth, async (req, res) => {
    try {
      const previous = req.user.profile && req.user.profile.avatar;
      const profile = parseProfile(req.user.profile);
      profile.avatar = '';
      await updateMembership(req.user.email, { profile: JSON.stringify(profile) });
      invalidateSessionUser(req.user.email);
      await removeAvatar(previous);
      res.json({ ok: true });
    } catch (error) {
      console.error('avatar remove:', error.message);
      res.status(500).json({ error: 'Could not remove your profile picture.' });
    }
  });

  app.get('/api/members/:memberId/avatar', requireMemberApi, async (req, res) => {
    try {
      const users = await listUsers();
      const user = users.find(u => u.memberId === String(req.params.memberId));
      const stored = user && user.profile && user.profile.avatar;
      if (!stored) return res.status(404).json({ error: 'No profile picture.' });

      const fileName = path.basename(stored);
      const type = fileName.endsWith('.png') ? 'image/png' : 'image/jpeg';
      const data = await loadAvatar(fileName);
      res.type(type);
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(data);
    } catch (error) {
      if (error.code === 'ENOENT' || /storage 404/i.test(error.message)) {
        return res.status(404).json({ error: 'No profile picture.' });
      }
      console.error('avatar serve:', error.message);
      res.status(500).json({ error: 'Could not load the picture.' });
    }
  });

  app.get('/api/network/members/:memberId', requireMemberApi, async (req, res) => {
    try {
      const users = await listUsers();
      const user = users.find(u =>
        u.memberId === String(req.params.memberId) &&
        isActiveMember(u) &&
        (u.accountStatus || 'active') !== 'deactivated' &&
        (u.networkStatus || 'out') === 'joined'
      );
      if (!user) return res.status(404).json({ error: 'This member is not in the network.' });

      const projects = (await listProjects()).filter(p => p.memberId === user.memberId);
      const member = applyNetworkVisibility({
        memberId: user.memberId,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        memberSince: user.memberSince,
        isCurrentUser: user.memberId === req.user.memberId,
        profile: publicProfile(user.profile),
        ...networkProjectSummary(projects),
      }, user.networkVisibility);

      res.json({ member });
    } catch (error) {
      console.error('network member:', error.message);
      res.status(500).json({ error: 'Could not load this member.' });
    }
  });
}

module.exports = { registerProfileRoutes };
