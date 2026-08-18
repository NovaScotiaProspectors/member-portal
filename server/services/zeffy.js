const ZEFFY_API_BASE = 'https://api.zeffy.com/api/v1';

const text = value => String(value == null ? '' : value).trim();

function webhookEvent(body) {
  const event = body && body.event;
  return text(body && (
    body.type || body.eventType || body.event_type ||
    (event && typeof event === 'object' ? event.type : event)
  ));
}

function webhookPayment(body) {
  if (!body || typeof body !== 'object') return {};
  if (body.payment && typeof body.payment === 'object') return body.payment;
  if (body.data && body.data.payment && typeof body.data.payment === 'object') return body.data.payment;
  if (body.data && typeof body.data === 'object') return body.data;
  return {};
}

function paymentId(payment) {
  return text(payment && (payment.id || payment.paymentId || payment.payment_id));
}

function paymentEmail(payment) {
  const contact = payment && (payment.contact || payment.buyer || payment.customer || {});
  return text(
    (contact && (contact.email || contact.emailAddress || contact.email_address)) ||
    (payment && (payment.email || payment.buyerEmail || payment.buyer_email))
  ).toLowerCase();
}

function paymentCampaignId(payment) {
  const campaign = payment && payment.campaign;
  return text(
    (campaign && typeof campaign === 'object' && (campaign.id || campaign.campaignId || campaign.campaign_id)) ||
    (typeof campaign === 'string' && campaign) ||
    (payment && (payment.campaignId || payment.campaign_id))
  );
}

function paymentStatus(payment) {
  return text(payment && (payment.status || payment.paymentStatus || payment.payment_status)).toLowerCase();
}

function paymentCustomerId(payment) {
  const contact = payment && (payment.contact || payment.buyer || payment.customer || {});
  return text(
    (contact && (contact.id || contact.contactId || contact.contact_id)) ||
    (payment && (payment.contactId || payment.contact_id || payment.customerId || payment.customer_id))
  );
}

function approvedPlan(payment, campaigns = {}) {
  const id = paymentCampaignId(payment);
  if (id && id === text(campaigns.student)) return 'student';
  if (id && id === text(campaigns.regular)) return 'regular';
  return '';
}

function createZeffyService({ apiKey, campaigns = {}, fetchImpl = fetch } = {}) {
  const key = text(apiKey);

  async function getPayment(id) {
    if (!key) throw new Error('ZEFFY_API_KEY is not configured.');
    const response = await fetchImpl(`${ZEFFY_API_BASE}/payments/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
    if (!response.ok) {
      throw new Error(`Zeffy payment verification failed (${response.status}).`);
    }
    return data.payment || data.data || data;
  }

  async function verifyCompletedWebhook(body) {
    if (webhookEvent(body) !== 'payment.completed') {
      return { ok: false, ignored: true, reason: 'unsupported_event' };
    }
    const id = paymentId(webhookPayment(body));
    if (!id) return { ok: false, status: 400, reason: 'missing_payment_id' };

    // The callback body is only a notification. Authorization comes from this
    // independent API lookup with the organization's private Zeffy API key.
    const payment = await getPayment(id);
    if (paymentId(payment) && paymentId(payment) !== id) {
      return { ok: false, status: 400, reason: 'payment_id_mismatch' };
    }
    if (paymentStatus(payment) !== 'succeeded') {
      return { ok: false, ignored: true, reason: 'payment_not_succeeded' };
    }
    const plan = approvedPlan(payment, campaigns);
    if (!plan) return { ok: false, ignored: true, reason: 'not_membership_campaign' };
    const email = paymentEmail(payment);
    if (!email) return { ok: false, status: 422, reason: 'missing_buyer_email' };

    return {
      ok: true,
      id,
      email,
      plan,
      customerId: paymentCustomerId(payment),
      payment,
    };
  }

  return { configured: !!(key && (text(campaigns.student) || text(campaigns.regular))), getPayment, verifyCompletedWebhook };
}

module.exports = {
  createZeffyService,
  webhookEvent,
  webhookPayment,
  paymentId,
  paymentEmail,
  paymentCampaignId,
  paymentStatus,
  approvedPlan,
};
