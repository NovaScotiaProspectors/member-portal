/* ── Zeffy payment webhook ──────────────────────────────────────────────────
 * Zeffy calls this when a payment completes. The callback body is treated as a
 * notification only — nothing in it is trusted. Authorisation comes from the
 * independent lookup in services/zeffy.js, made with the organisation's private
 * API key, which is what decides whether a membership is activated.
 *
 * Deliveries are retried by senders and can arrive more than once, so every
 * payment id is recorded once it has been acted on and a repeat is answered
 * without touching the membership again. Without that, a redelivery arriving
 * after a membership lapsed would silently reinstate it.
 * ──────────────────────────────────────────────────────────────────────────── */

const EVENT_KEY_PREFIX = 'zeffy_payment:';

function registerIntegrationRoutes(app, ctx) {
  const {
    zeffy, findUserByEmail, activateMembership, invalidateSessionUser,
    studentVerificationOk, portal,
  } = ctx;

  const eventKey = paymentId => `${EVENT_KEY_PREFIX}${paymentId}`;

  app.post('/api/webhooks/zeffy', async (req, res) => {
    if (!zeffy.configured) return res.status(503).json({ error: 'Zeffy verification is not configured.' });
    try {
      const result = await zeffy.verifyCompletedWebhook(req.body);
      if (!result.ok) {
        if (result.ignored) return res.json({ ok: true, ignored: result.reason });
        return res.status(result.status || 400).json({ error: result.reason });
      }

      // Already acted on. Answer 200 so the sender stops retrying, and change
      // nothing — a second delivery must never extend a membership.
      const seen = await portal.getSetting(eventKey(result.id), null);
      if (seen) return res.json({ ok: true, duplicate: true, activated: !!seen.activated });

      const user = await findUserByEmail(result.email);
      if (!user) {
        // Do not acknowledge this as processed. Zeffy retries non-2xx webhook
        // deliveries, which gives a payer who used the direct checkout link a
        // chance to create their portal account without requiring an admin.
        console.warn(`Verified Zeffy payment ${result.id} has no matching portal account for ${result.email}.`);
        return res.status(409).json({ error: 'No portal account matches the payer email.', pendingAccountMatch: true });
      }
      if (user.subscriptionId === result.id) {
        // Recovery path for the narrow failure window where activation was
        // saved but recording the webhook event failed.
        await portal.setSetting(eventKey(result.id), {
          memberId: user.memberId,
          plan: result.plan,
          activated: true,
          recovered: true,
          at: new Date().toISOString(),
        });
        return res.json({ ok: true, duplicate: true, activated: true });
      }
      if (result.plan === 'student' && !(await studentVerificationOk(user.memberId))) {
        console.warn(`Verified Zeffy student payment ${result.id} does not have a verified student account.`);
        return res.json({ ok: true, activated: false, reason: 'student_not_verified' });
      }

      await activateMembership(user.email, result.customerId, result.id);
      invalidateSessionUser(user.email);

      // Recorded after the fact: a failed activation must stay retryable.
      await portal.setSetting(eventKey(result.id), {
        memberId: user.memberId,
        plan: result.plan,
        activated: true,
        at: new Date().toISOString(),
      });

      return res.json({ ok: true, activated: true });
    } catch (error) {
      console.error('zeffy webhook:', error);
      return res.status(502).json({ error: 'Could not verify the Zeffy payment.' });
    }
  });
}

module.exports = { registerIntegrationRoutes, EVENT_KEY_PREFIX };
