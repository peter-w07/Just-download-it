/*
 * Just download it: network helpers for the service worker and its resolvers.
 *
 * Requests made by the extension itself carry "Origin: chrome-extension://…"
 * (moz-extension://… in Firefox), which some sites (YouTube) refuse. Session
 * rules rewrite Origin and Referer on the extension's own requests to those
 * hosts only; the user's browsing is never touched (initiatorDomains is this
 * extension: its id in Chrome, its internal UUID in Firefox, i.e. the host of
 * its own URLs either way).
 */

const RULE_ID_BASE = 9000;
const RULE_ID_MAX = 9999;

/**
 * @param {{ domains: string[], origin: string, referer?: string }[]} list
 */
export async function installOriginRules(list) {
  const ownHost = new URL(chrome.runtime.getURL('')).hostname;
  const addRules = list.map((rule, i) => ({
    id: RULE_ID_BASE + i,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'origin', operation: 'set', value: rule.origin },
        { header: 'referer', operation: 'set', value: rule.referer || `${rule.origin}/` },
      ],
    },
    condition: {
      requestDomains: rule.domains,
      initiatorDomains: [ownHost],
      resourceTypes: ['xmlhttprequest', 'other'],
    },
  }));
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: existing.map((r) => r.id).filter((id) => id >= RULE_ID_BASE && id <= RULE_ID_MAX),
    addRules,
  });
}

/** fetch() with a timeout that never sends cookies. Resolves to null on network errors. */
export async function timedFetch(url, init = {}, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, credentials: 'omit', signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** GET a page or API as text. Throws an Error with a userMessage on failure. */
export async function fetchText(url, { headers = {}, site = 'The site', ms = 15000 } = {}) {
  const res = await timedFetch(url, { headers }, ms);
  if (!res) throw userError('network', `Couldn’t reach ${site}. Check your connection and try again.`);
  if (res.status === 404) throw userError('not-found', `${site} says this link doesn’t exist (it may be private or deleted).`);
  if (res.status === 429) throw userError('rate-limited', `${site} is limiting requests right now. Wait a minute and try again.`);
  if (!res.ok) throw userError('http', `${site} didn’t answer (HTTP ${res.status}). Try again.`);
  return res.text();
}

/** GET JSON. Throws an Error with a userMessage on failure. */
export async function fetchJson(url, options = {}) {
  const text = await fetchText(url, { ...options, headers: { Accept: 'application/json', ...(options.headers || {}) } });
  try {
    return JSON.parse(text);
  } catch {
    throw userError('bad-json', `${options.site || 'The site'} sent something unexpected. Try again.`);
  }
}

/** An Error whose userMessage is safe to show in the picker. */
export function userError(code, userMessage) {
  return Object.assign(new Error(code), { code, userMessage });
}
