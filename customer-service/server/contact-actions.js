// The Skill interprets purpose and consent. This module validates provenance,
// field formats and the proposed operation; it never classifies customer words.
const LIMITS = { phone: 32, wechat: 64, email: 254, name: 80, company: 160 };
const CHANNELS = ['phone', 'wechat', 'email'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalize = value => typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim() : '';

export function contactFieldError(field, value) {
  if (!Object.hasOwn(LIMITS, field) || typeof value !== 'string' || value.length > LIMITS[field]
    || /[\u0000-\u001f\u007f]/u.test(value)) return 'invalid_contact_field';
  if (!value) return null;
  if (field === 'phone' && (!/^[+\d ()-]+$/u.test(value) || !/^\+?\d{7,15}$/u.test(value.replace(/[ ()-]/gu, '')))) return 'invalid_phone';
  if (field === 'wechat' && !/^[a-zA-Z0-9_-]{3,64}$/u.test(value)) return 'invalid_wechat';
  if (field === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) return 'invalid_email';
  return null;
}

export function hasContactChannel(contact) {
  return CHANNELS.some(field => typeof contact?.[field] === 'string' && !!contact[field].trim()
    && !contactFieldError(field, contact[field]));
}

export function validateContactAction(value, { messages = [], existingContact = null, hasExistingContact = false } = {}) {
  const invalid = reason => ({ valid: false, reason });
  if (value === undefined || value === null) return { valid: true, action: null };
  if (!record(value) || !['save', 'withdraw'].includes(value.type)) return invalid('contact_action_shape');
  const keys = value.type === 'save' ? ['type', 'sourceMessageId', 'evidence', 'fields', 'consent'] : ['type', 'sourceMessageId', 'evidence'];
  if (Object.keys(value).some(key => !keys.includes(key))) return invalid('contact_action_shape');
  const latest = messages.findLast(message => message?.role === 'user');
  if (!latest?.id || value.sourceMessageId !== latest.id || typeof value.evidence !== 'string'
    || value.evidence.length > 8000 || !normalize(latest.content)
    || normalize(value.evidence) !== normalize(latest.content)) return invalid('contact_action_source');
  if (value.type === 'withdraw') return { valid: true, action: { type: 'withdraw', sourceMessageId: latest.id, evidence: latest.content } };
  if (!record(value.fields) || !['granted', 'unknown'].includes(value.consent)) return invalid('contact_action_shape');
  const fields = {};
  for (const [field, entry] of Object.entries(value.fields)) {
    if (!Object.hasOwn(LIMITS, field) || !record(entry)
      || Object.keys(entry).some(key => !['value', 'sourceMessageId', 'quote'].includes(key))
      || typeof entry.value !== 'string' || !entry.value.trim()
      || typeof entry.quote !== 'string' || !entry.quote.trim() || entry.quote.length > 8000) return invalid('contact_field_shape');
    const source = messages.find(message => message?.id === entry.sourceMessageId && message.role === 'user');
    const clean = entry.value.trim();
    if (!source || !normalize(source.content).includes(normalize(entry.quote))
      || !normalize(entry.quote).includes(normalize(clean))) return invalid('contact_field_source');
    const fieldError = contactFieldError(field, clean);
    if (fieldError) return invalid(fieldError);
    fields[field] = { value: clean, sourceMessageId: source.id, quote: entry.quote };
  }
  const merged = { ...existingContact, ...Object.fromEntries(Object.entries(fields).map(([key, item]) => [key, item.value])) };
  if (!hasContactChannel(merged) && !hasExistingContact) return invalid('contact_channel_missing');
  return { valid: true, action: { type: 'save', sourceMessageId: latest.id, evidence: latest.content, fields, consent: value.consent } };
}
