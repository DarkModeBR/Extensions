/*! LinkLimpo — service worker (Manifest V3). Licença: LGPL-3.0-or-later. */
'use strict';

importScripts('../core/settings.js', '../core/engine.js', '../core/dnr.js');

const { sanitize, normalizeDomain } = self.LinkLimpoSettings;
const { Engine, mergeRulesets, validateRuleset } = self.LinkLimpoEngine;
const DNR = self.LinkLimpoDNR;

const ALARM_UPDATE = 'linklimpo:update-rules';
const MENU = { link: 'll-copy-link', linkOpen: 'll-open-link', page: 'll-copy-page' };
const BLOCKED_PAGE = chrome.runtime.getURL('src/ui/blocked.html');
const LOG_MAX = 300;
const TAB_ENTRIES_MAX = 50;

/* ================================================================ estado */

let settings = null;
let engine = null;
let ruleset = null;
let dnrMeta = {};
let rebuildTimer = null;
let rebuildPromise = null;

const tabs = new Map(); // tabId → { count, entries: [] }
const carryTabs = new Set(); // abas em que nós mesmos iniciamos a navegação (manter histórico)
const lastRedirect = new Map(); // tabId → { url, t } — evita laços

let statsCache = null;
let statsDirty = false;
let logBuffer = [];

/* ============================================================ utilidades */

const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

function isHttp(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function isPaused(url, s = settings) {
  const host = hostOf(url).replace(/^www\./, '');
  if (!host || !s) return false;
  return s.pausedSites.some((d) => host === d || host.endsWith('.' + d));
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function fetchText(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function loadBundled(path) {
  const res = await fetch(chrome.runtime.getURL(path));
  return res.json();
}

/* ========================================================= configurações */

async function getSettings() {
  if (settings) return settings;
  const { settings: stored } = await chrome.storage.local.get('settings');
  settings = sanitize(stored);
  return settings;
}

async function saveSettings(patch) {
  const current = await getSettings();
  settings = sanitize(Object.assign({}, current, patch));
  await chrome.storage.local.set({ settings });
  return settings;
}

/* ================================================================ regras */

/** Monta o conjunto final: ClearURLs (baixado ou embutido) + extras + personalizadas. */
async function buildRuleset() {
  const s = await getSettings();
  const { remoteRules } = await chrome.storage.local.get('remoteRules');
  let base = null;
  let source = 'bundled';
  let baseHash = null;
  let fetchedAt = null;
  if (remoteRules && remoteRules.data && remoteRules.data.providers) {
    base = remoteRules.data;
    source = 'remote';
    baseHash = remoteRules.hash;
    fetchedAt = remoteRules.fetchedAt;
  } else {
    base = await loadBundled('rules/clearurls.min.json');
    baseHash = (await (await fetch(chrome.runtime.getURL('rules/clearurls.hash'))).text()).trim();
  }

  const layers = [];
  let extraVersion = null;
  if (s.extraRules) {
    const extra = await loadBundled('rules/extra-rules.json');
    extraVersion = extra.version || null;
    layers.push(extra);
  }
  let customError = null;
  let customProviders = 0;
  if (s.customRules && s.customRules.trim()) {
    try {
      const custom = JSON.parse(s.customRules);
      const errors = validateRuleset(custom);
      if (errors.length) customError = errors.slice(0, 5).join('; ');
      else {
        layers.push(custom);
        customProviders = Object.keys(custom.providers || {}).length + Object.keys(custom.extend || {}).length;
      }
    } catch (e) {
      customError = e.message;
    }
  }

  const merged = mergeRulesets(base, ...layers);
  const info = {
    source,
    hash: baseHash,
    fetchedAt,
    extraVersion,
    providers: Object.keys(merged.providers).length,
    customProviders,
    customError,
    builtAt: Date.now(),
  };
  return { merged, info };
}

function makeEngine(rs, s) {
  return new Engine(rs, {
    allowReferral: s.allowReferralMarketing,
    domainBlocking: s.domainBlocking,
    skipLocal: s.skipLocalHosts,
    redirects: s.redirectSkipping,
  });
}

async function getEngine() {
  if (engine) return engine;
  const s = await getSettings();
  if (!ruleset) {
    const { ruleset: stored } = await chrome.storage.local.get('ruleset');
    if (stored && stored.providers) ruleset = stored;
    else await rebuild('missing-ruleset');
  }
  engine = makeEngine(ruleset, s);
  return engine;
}

async function isRegexSupported(regex) {
  const r = await chrome.declarativeNetRequest.isRegexSupported({ regex, isCaseSensitive: false });
  return r.isSupported;
}

async function applyDynamicRules(rules) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: rules });
    return [];
  } catch (err) {
    // Alguma regra foi recusada: adiciona em blocos e isola as problemáticas.
    console.warn('[LinkLimpo] updateDynamicRules falhou, aplicando em partes:', err);
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    const rejected = [];
    for (let i = 0; i < rules.length; i += 25) {
      const chunk = rules.slice(i, i + 25);
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({ addRules: chunk });
      } catch (_) {
        for (const rule of chunk) {
          try {
            await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
          } catch (e) {
            rejected.push({ id: rule.id, error: String(e && e.message) });
          }
        }
      }
    }
    return rejected;
  }
}

/** Reconstrói regras, motor e regras de rede. Serializado: nunca roda duas vezes ao mesmo tempo. */
function rebuild(reason) {
  const run = async () => {
    const s = await getSettings();
    const { merged, info } = await buildRuleset();
    ruleset = merged;
    engine = makeEngine(merged, s);

    const compiled = await DNR.compile(merged, s, { isRegexSupported });
    const rejected = await applyDynamicRules(compiled.rules);
    dnrMeta = compiled.meta;
    info.dnr = {
      rules: compiled.rules.length - rejected.length,
      providers: compiled.stats.providers,
      regexRules: compiled.stats.regexRules,
      skipped: compiled.stats.skipped.length,
      rejected: rejected.length,
    };
    await chrome.storage.local.set({ ruleset: merged, rulesInfo: info, dnrMeta });
    await updateActionOptions();
    if (reason !== 'settings') broadcastConfig(); // mudança de configurações já avisa por conta própria
    console.info('[LinkLimpo] regras reconstruídas (' + reason + '):', info);
    return info;
  };
  rebuildPromise = (rebuildPromise || Promise.resolve()).catch(() => {}).then(run);
  return rebuildPromise;
}

function scheduleRebuild(reason) {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => rebuild(reason).catch((e) => console.error('[LinkLimpo] rebuild', e)), 250);
}

/** Baixa as regras oficiais do ClearURLs, verificando o hash SHA-256 publicado. */
async function updateRules({ force = false } = {}) {
  const s = await getSettings();
  const { remoteRules, rulesInfo } = await chrome.storage.local.get(['remoteRules', 'rulesInfo']);
  const status = { ok: false, changed: false, error: null, checkedAt: Date.now() };
  try {
    const expected = (await fetchText(s.rulesHashUrl)).trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(t('errHashFormat'));
    const currentHash = (remoteRules && remoteRules.hash) || (rulesInfo && rulesInfo.hash);
    if (!force && currentHash === expected) {
      status.ok = true;
    } else {
      const text = await fetchText(s.rulesUrl);
      const actual = await sha256Hex(text);
      if (actual !== expected) throw new Error(t('errHashMismatch'));
      const data = JSON.parse(text);
      if (!data || typeof data.providers !== 'object' || Object.keys(data.providers).length < 10) {
        throw new Error(t('errRulesFormat'));
      }
      await chrome.storage.local.set({ remoteRules: { data, hash: actual, fetchedAt: Date.now(), url: s.rulesUrl } });
      status.ok = true;
      status.changed = currentHash !== actual;
      await rebuild('rules-update');
    }
  } catch (err) {
    status.error = String((err && err.message) || err);
  }
  await chrome.storage.local.set({ rulesUpdateStatus: status });
  return status;
}

async function scheduleUpdates() {
  const s = await getSettings();
  await chrome.alarms.clear(ALARM_UPDATE);
  if (s.autoUpdateRules) {
    chrome.alarms.create(ALARM_UPDATE, { delayInMinutes: 1, periodInMinutes: s.updateIntervalHours * 60 });
  }
}

/* ====================================================== ícone e contador */

async function updateActionOptions() {
  const s = await getSettings();
  try {
    await chrome.declarativeNetRequest.setExtensionActionOptions({
      displayActionCountAsBadgeText: s.enabled && s.showBadge,
    });
  } catch (_) {
    /* navegadores antigos */
  }
  await chrome.action.setBadgeBackgroundColor({ color: '#0E7C66' });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
  await setIcon(null, s.enabled);
}

const iconPaths = (on) => {
  const v = on ? 'on' : 'off';
  return { 16: `icons/${v}-16.png`, 32: `icons/${v}-32.png`, 48: `icons/${v}-48.png`, 128: `icons/${v}-128.png` };
};

async function setIcon(tabId, on) {
  try {
    const opts = { path: iconPaths(on) };
    if (tabId != null) opts.tabId = tabId;
    await chrome.action.setIcon(opts);
  } catch (_) {
    /* aba fechada */
  }
}

// Abas com ícone de "pausado". O ícone só é trocado quando o estado muda — decodificar
// e enviar o PNG a cada navegação seria trabalho à toa.
const tabIconOff = new Set();

async function refreshTabIcon(tabId, url) {
  const s = await getSettings();
  const off = !!(s.enabled && url && isPaused(url, s));
  if (off === tabIconOff.has(tabId)) return;
  if (off) tabIconOff.add(tabId);
  else tabIconOff.delete(tabId);
  await setIcon(tabId, s.enabled && !off);
}

/** Avisa as abas abertas que configurações ou regras mudaram (elas releem sob demanda). */
async function broadcastConfig() {
  const all = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }).catch(() => []);
  for (const tab of all) chrome.tabs.sendMessage(tab.id, { type: 'configChanged' }, { frameId: 0 }).catch(() => {});
}

/* ================================================= estatísticas e registro */

async function getStats() {
  if (statsCache) return statsCache;
  const { stats } = await chrome.storage.local.get('stats');
  statsCache = Object.assign({ total: 0, params: 0, redirects: 0, blocked: 0, links: 0, since: Date.now() }, stats);
  return statsCache;
}

let flushTimer = null;
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    const data = {};
    if (statsDirty) {
      data.stats = statsCache;
      statsDirty = false;
    }
    if (logBuffer.length) {
      const { log = [] } = await chrome.storage.local.get('log');
      data.log = logBuffer.concat(log).slice(0, LOG_MAX);
      logBuffer = [];
    }
    const sessionTabs = {};
    for (const [id, v] of tabs) sessionTabs[id] = v;
    await chrome.storage.session.set({ tabs: sessionTabs });
    if (Object.keys(data).length) await chrome.storage.local.set(data);
  }, 1500);
}

async function tabState(tabId) {
  if (!tabs.has(tabId)) {
    const { tabs: stored = {} } = await chrome.storage.session.get('tabs');
    tabs.set(tabId, stored[tabId] || { count: 0, entries: [] });
  }
  return tabs.get(tabId);
}

/**
 * Registra uma limpeza.
 * @param {number} tabId
 * @param {{kind: 'params'|'redirect'|'block'|'link'|'history'|'ping', provider?: string, removed?: string[], before?: string, after?: string}} entry
 * @param {{badge?: boolean}} opts  badge: incrementa o contador (falso para ações que o próprio DNR já conta)
 */
async function record(tabId, entry, opts = {}) {
  const s = await getSettings();
  const stats = await getStats();
  stats.total++;
  if (entry.kind === 'redirect') stats.redirects++;
  else if (entry.kind === 'block') stats.blocked++;
  else if (entry.kind === 'link') stats.links++;
  else stats.params++;
  statsDirty = true;

  const e = Object.assign({ t: Date.now() }, entry);
  if (tabId != null && tabId >= 0) {
    const st = await tabState(tabId);
    st.count++;
    st.entries.unshift(e);
    if (st.entries.length > TAB_ENTRIES_MAX) st.entries.length = TAB_ENTRIES_MAX;
    if (opts.badge && s.showBadge && s.enabled) {
      chrome.declarativeNetRequest.setExtensionActionOptions({ tabUpdate: { tabId, increment: 1 } }).catch(() => {});
    }
  }
  if (s.logEnabled) logBuffer.unshift(e);
  scheduleFlush();
}

/* ============================================================ navegação */

function resetTab(tabId, url) {
  if (carryTabs.has(tabId)) {
    carryTabs.delete(tabId);
    return;
  }
  // O aviso das regras de rede pode chegar antes deste evento: preserva o que já foi
  // registrado para esta mesma navegação.
  const prev = tabs.get(tabId);
  const now = Date.now();
  const keep = prev ? prev.entries.filter((e) => e.before === url && now - e.t < 2000) : [];
  tabs.set(tabId, { count: keep.length, entries: keep });
  scheduleFlush();
}

chrome.webNavigation.onBeforeNavigate.addListener(async (d) => {
  if (d.frameId !== 0 || !isHttp(d.url)) return;
  resetTab(d.tabId, d.url);
  const s = await getSettings();
  if (!s.enabled || !s.redirectSkipping || isPaused(d.url, s)) return;
  const e = await getEngine();
  const r = e.clean(d.url);
  if (!r.redirected || r.url === d.url) return;
  const last = lastRedirect.get(d.tabId);
  if (last && last.url === r.url && Date.now() - last.t < 4000) return;
  lastRedirect.set(d.tabId, { url: r.url, t: Date.now() });
  carryTabs.add(d.tabId);
  const target = r.blocked ? BLOCKED_PAGE + '#' + encodeURIComponent(r.url) : r.url;
  chrome.tabs.update(d.tabId, { url: target }).catch(() => carryTabs.delete(d.tabId));
  const m = r.matches.find((x) => x.redirected) || {};
  record(d.tabId, { kind: 'redirect', provider: m.provider, before: d.url, after: r.url }, { badge: true });
});

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  refreshTabIcon(d.tabId, d.url);
});

async function onSameDocumentChange(d) {
  if (d.frameId !== 0 || !isHttp(d.url)) return;
  const s = await getSettings();
  if (!s.enabled || !s.historyCleaning || isPaused(d.url, s)) return;
  const e = await getEngine();
  const r = e.clean(d.url);
  if (!r.changed || r.redirected || r.blocked) return;
  try {
    if (new URL(r.url).origin !== new URL(d.url).origin) return;
  } catch (_) {
    return;
  }
  // A aba só troca o endereço (history.replaceState); o motor fica aqui no service worker,
  // então a página não precisa carregar as regras só para conferir a própria URL.
  const ok = await chrome.tabs
    .sendMessage(d.tabId, { type: 'replaceUrl', url: r.url, from: d.url }, { frameId: 0 })
    .catch(() => false);
  if (ok === true) {
    const m = r.matches[0] || {};
    record(d.tabId, { kind: 'history', provider: m.provider, removed: r.matches.flatMap((x) => x.removed || []), before: d.url, after: r.url }, { badge: true });
  }
}
// Sobra de rastreamento após o carregamento (o que as regras de rede não pegaram) e URLs
// alteradas depois pela própria página (history API / fragmento).
chrome.webNavigation.onDOMContentLoaded.addListener(onSameDocumentChange);
chrome.webNavigation.onHistoryStateUpdated.addListener(onSameDocumentChange);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(onSameDocumentChange);

// Página principal bloqueada pelo DNR → troca o erro do navegador pela página explicativa.
chrome.webNavigation.onErrorOccurred.addListener(async (d) => {
  if (d.frameId !== 0 || !isHttp(d.url) || !/ERR_BLOCKED_BY_CLIENT/.test(d.error)) return;
  const s = await getSettings();
  if (!s.enabled || !s.domainBlocking) return;
  const e = await getEngine();
  const r = e.clean(d.url);
  if (!r.blocked) return; // bloqueado por outra extensão
  carryTabs.add(d.tabId);
  chrome.tabs.update(d.tabId, { url: BLOCKED_PAGE + '#' + encodeURIComponent(d.url) }).catch(() => carryTabs.delete(d.tabId));
  const m = r.matches.find((x) => x.blocked) || {};
  // Com onRuleMatchedDebug disponível, o bloqueio já foi registrado por ele.
  if (!chrome.declarativeNetRequest.onRuleMatchedDebug) record(d.tabId, { kind: 'block', provider: m.provider, before: d.url });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  tabIconOff.delete(tabId);
  lastRedirect.delete(tabId);
  carryTabs.delete(tabId);
  scheduleFlush();
});

// Só existe em extensões carregadas sem empacotar ("modo do desenvolvedor"): dá o detalhe
// de cada regra de rede que agiu. Na loja, o contador do ícone continua funcionando.
/** Verdadeiro se `next` é `prev` com alguns parâmetros a menos (mesmo endereço). */
function isContinuation(prev, next) {
  try {
    const a = new URL(prev);
    const b = new URL(next);
    if (a.origin + a.pathname !== b.origin + b.pathname) return false;
    const keys = new Set(a.searchParams.keys());
    return Array.from(b.searchParams.keys()).every((k) => keys.has(k));
  } catch (_) {
    return false;
  }
}

if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(async (info) => {
    if (info.rule.rulesetId !== '_dynamic') return;
    if (!Object.keys(dnrMeta).length) {
      const { dnrMeta: stored } = await chrome.storage.local.get('dnrMeta');
      dnrMeta = stored || {};
    }
    const m = dnrMeta[info.rule.ruleId];
    if (!m || m.kind === 'exception' || m.kind === 'paused' || m.kind === 'etag') return;
    const req = info.request;
    const entry = { kind: m.kind === 'block' ? 'block' : m.kind === 'ping' ? 'ping' : 'params', provider: m.provider, before: req.url };
    if (m.kind === 'params') {
      try {
        const keys = Array.from(new URL(req.url).searchParams.keys());
        const rules = await chrome.declarativeNetRequest.getDynamicRules({ ruleIds: [info.rule.ruleId] });
        const names = rules[0] ? rules[0].action.redirect.transform.queryTransform.removeParams : [];
        entry.removed = keys.filter((k) => names.includes(k));
      } catch (_) {
        /* ignora */
      }
    }
    // Uma navegação pode passar por várias regras em cadeia (Google → globais...). Junta os
    // saltos num item só, guardando a URL original, para o popup mostrar tudo que saiu.
    if (m.kind === 'params' && req.tabId >= 0) {
      const st = await tabState(req.tabId);
      const prev = st.entries[0];
      if (prev && prev.kind === 'params' && Date.now() - prev.t < 3000 && isContinuation(prev.before, req.url)) {
        prev.removed = Array.from(new Set((prev.removed || []).concat(entry.removed || [])));
        if (m.provider !== 'globalRules') prev.provider = m.provider;
        scheduleFlush();
        return;
      }
    }
    // Ações de rede já entram no contador do ícone pelo próprio navegador.
    record(req.tabId, entry, { badge: false });
  });
}

/* ===================================================== área de transferência */

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: 'src/offscreen/offscreen.html',
    reasons: ['CLIPBOARD'],
    justification: 'Copiar o link limpo para a área de transferência.',
  });
}

async function copyText(text, tabId) {
  let ok = false;
  try {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy', text });
    ok = !!(res && res.ok);
  } catch (e) {
    console.warn('[LinkLimpo] cópia via offscreen falhou', e);
  }
  if (tabId != null) {
    chrome.tabs
      .sendMessage(tabId, { type: 'toast', text: ok ? t('toastCopied') : t('toastCopyFailed') }, { frameId: 0 })
      .catch(() => {});
  }
  return ok;
}

/* ======================================================== menus e atalhos */

async function setupMenus() {
  await chrome.contextMenus.removeAll();
  const s = await getSettings();
  if (!s.contextMenus) return;
  chrome.contextMenus.create({ id: MENU.link, title: t('menuCopyLink'), contexts: ['link'] });
  chrome.contextMenus.create({ id: MENU.linkOpen, title: t('menuOpenLink'), contexts: ['link'] });
  chrome.contextMenus.create({ id: MENU.page, title: t('menuCopyPage'), contexts: ['page', 'frame'] });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const e = await getEngine();
  const raw = info.menuItemId === MENU.page ? info.frameUrl || info.pageUrl : info.linkUrl;
  if (!raw) return;
  const r = e.clean(raw);
  if (info.menuItemId === MENU.linkOpen) {
    chrome.tabs.create({ url: r.url, index: tab ? tab.index + 1 : undefined, openerTabId: tab ? tab.id : undefined });
  } else {
    await copyText(r.url, tab && tab.id);
  }
  if (r.changed) record(tab && tab.id, { kind: r.redirected ? 'redirect' : 'link', before: raw, after: r.url }, { badge: false });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'copy-clean-url') return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;
  const e = await getEngine();
  await copyText(e.clean(tab.url).url, tab.id);
});

/* ============================================================== mensagens */

const handlers = {
  async getTabInfo({ tabId }) {
    const s = await getSettings();
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const st = await tabState(tabId);
    const { rulesInfo, rulesUpdateStatus } = await chrome.storage.local.get(['rulesInfo', 'rulesUpdateStatus']);
    let badge = '';
    try {
      badge = await chrome.action.getBadgeText({ tabId });
    } catch (_) {
      /* ignora */
    }
    const url = tab ? tab.url || '' : '';
    let cleanUrl = url;
    if (isHttp(url)) cleanUrl = (await getEngine()).clean(url).url;
    return {
      settings: s,
      url,
      cleanUrl,
      host: hostOf(url).replace(/^www\./, ''),
      supported: isHttp(url),
      paused: isPaused(url, s),
      tab: st,
      badge,
      stats: await getStats(),
      rulesInfo,
      rulesUpdateStatus,
    };
  },

  async clean({ url }) {
    return (await getEngine()).clean(String(url || ''));
  },

  setSettings({ patch }) {
    return serial(() => applySettings(patch || {}));
  },

  togglePause({ host, paused }) {
    return serial(async () => {
      const d = normalizeDomain(host);
      const s = await getSettings();
      if (!d) return s;
      const set = new Set(s.pausedSites);
      if (paused) set.add(d);
      else for (const x of Array.from(set)) if (d === x || d.endsWith('.' + x)) set.delete(x);
      return applySettings({ pausedSites: Array.from(set) });
    });
  },

  async updateRules() {
    return updateRules({ force: true });
  },

  async resetRules() {
    await chrome.storage.local.remove(['remoteRules', 'rulesUpdateStatus']);
    return rebuild('reset-rules');
  },

  async getState() {
    const data = await chrome.storage.local.get(['rulesInfo', 'rulesUpdateStatus', 'log']);
    return Object.assign({ settings: await getSettings(), stats: await getStats() }, data);
  },

  async resetStats() {
    statsCache = { total: 0, params: 0, redirects: 0, blocked: 0, links: 0, since: Date.now() };
    await chrome.storage.local.set({ stats: statsCache });
    return statsCache;
  },

  async clearLog() {
    logBuffer = [];
    await chrome.storage.local.set({ log: [] });
    return true;
  },

  async explainBlocked({ url }) {
    const r = (await getEngine()).clean(String(url || ''));
    const m = r.matches.find((x) => x.blocked);
    return { blocked: r.blocked, provider: m ? m.provider : null, host: hostOf(url) };
  },

  async allowBlockedOnce({ url }) {
    const host = hostOf(url);
    if (!host) return false;
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const id = existing.reduce((m, r) => Math.max(m, r.id), 0) + 1;
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [
        {
          id,
          priority: 40000,
          action: { type: 'allowAllRequests' },
          condition: { requestDomains: [host], resourceTypes: ['main_frame', 'sub_frame'] },
        },
        {
          id: id + 1,
          priority: 40000,
          action: { type: 'allow' },
          condition: { requestDomains: [host] },
        },
      ],
    });
    return true;
  },

  async contentCleaned({ items }, sender) {
    const tabId = sender.tab ? sender.tab.id : null;
    for (const it of (items || []).slice(0, 50)) {
      await record(
        tabId,
        { kind: it.kind || 'link', provider: it.provider, removed: (it.removed || []).slice(0, 20), before: it.before, after: it.after },
        { badge: true }
      );
    }
    return true;
  },
};

// Gravações de configurações em fila: duas mudanças seguidas (ex.: adicionar dois sites
// pausados rapidamente) nunca leem o mesmo estado antigo e uma apaga a outra.
let settingsQueue = Promise.resolve();
function serial(fn) {
  const run = settingsQueue.then(fn, fn);
  settingsQueue = run.catch(() => {});
  return run;
}

async function applySettings(patch) {
  const before = await getSettings();
  const s = await saveSettings(patch);
  await afterSettingsChange(before, s);
  return s;
}

async function afterSettingsChange(before, after) {
  const changed = (keys) => keys.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (
    changed([
      'enabled', 'domainBlocking', 'pingBlocking', 'etagRemoval', 'allowReferralMarketing', 'skipLocalHosts',
      'cleanSubresources', 'extraRules', 'customRules', 'pausedSites', 'redirectSkipping',
    ])
  ) {
    engine = null;
    await rebuild('settings');
  } else {
    await updateActionOptions();
  }
  if (changed(['autoUpdateRules', 'updateIntervalHours'])) await scheduleUpdates();
  if (changed(['rulesUrl', 'rulesHashUrl'])) await chrome.storage.local.remove('remoteRules');
  if (changed(['contextMenus'])) await setupMenus();
  if (changed(['pausedSites', 'enabled'])) {
    const all = await chrome.tabs.query({});
    for (const tab of all) refreshTabIcon(tab.id, tab.url);
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) broadcastConfig();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;
  // Só aceita mensagens da própria extensão (páginas e content scripts).
  if (sender.id !== chrome.runtime.id) return false;
  const fn = handlers[msg.type];
  if (!fn) return false;
  // Content scripts só podem relatar limpezas — o resto é exclusivo das páginas da extensão.
  const fromExtensionPage = sender.url && sender.url.startsWith(chrome.runtime.getURL(''));
  if (!fromExtensionPage && msg.type !== 'contentCleaned') return false;
  Promise.resolve()
    .then(() => fn(msg, sender))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true;
});

/* ============================================================== ciclo de vida */

chrome.runtime.onInstalled.addListener(async (details) => {
  const { settings: stored } = await chrome.storage.local.get('settings');
  settings = sanitize(stored);
  await chrome.storage.local.set({ settings });
  await rebuild('installed:' + details.reason);
  await setupMenus();
  await scheduleUpdates();
  if (settings.autoUpdateRules) updateRules().catch(() => {});
  if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/options.html#welcome') });
});

chrome.runtime.onStartup.addListener(async () => {
  await getSettings();
  await updateActionOptions();
  await scheduleUpdates();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_UPDATE) updateRules().catch(() => {});
});

// Mudanças feitas por outra página da extensão (ex.: opções abertas em duas abas).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const next = sanitize(changes.settings.newValue);
  if (settings && JSON.stringify(next) !== JSON.stringify(settings)) {
    const before = settings;
    settings = next;
    afterSettingsChange(before, next).catch(() => {});
  }
});
