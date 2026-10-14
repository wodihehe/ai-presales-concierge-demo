import { isDeepStrictEqual } from 'node:util';
import { isProfileReady } from './intelligence.js';

// The model interprets the message using the runtime Skill. This guard checks
// only the action contract and business snapshot, never customer keywords.
export function validateIntakeAction(result, { state, profile, message }) {
  const action = result?.action;
  if (!action || result.degraded || typeof action !== 'object' || Array.isArray(action)) return null;
  if (!['continue', 'confirm_requirements', 'quote_feedback', 'respond'].includes(action.type)) return null;
  const normalize = value => typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim() : '';
  if (!Number.isSafeInteger(action.summaryVersion) || action.summaryVersion !== state.summaryVersion
    || action.quoteVersion !== (state.quote?.version ?? null)
    || action.sourceMessageId !== message.id || !normalize(action.evidence)
    || normalize(action.evidence) !== normalize(message.content)
    || typeof action.scopeChanged !== 'boolean') return null;
  if (action.type === 'continue') return state.hasNewAttachments && !action.scopeChanged ? null : action;
  if (state.hasNewAttachments || action.scopeChanged || !isDeepStrictEqual(profile, result.profile)) return null;
  if (action.type === 'confirm_requirements' && (!state.summaryReady || !isProfileReady(profile))) return null;
  if (action.type === 'quote_feedback' && (!state.summaryConfirmed || !state.quote
    || state.quote.version !== state.summaryVersion
    || !['accepted', 'too_high', 'considering'].includes(action.feedback))) return null;
  if (action.type === 'respond' && (typeof result.reply !== 'string' || (!result.reply.trim() && !result.contactAction))) return null;
  return action;
}
