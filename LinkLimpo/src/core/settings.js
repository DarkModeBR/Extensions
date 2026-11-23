/*! LinkLimpo — configurações padrão. Licença: LGPL-3.0-or-later. */
globalThis.LinkLimpoSettings = (function () {
  'use strict';

  const RULES_URL = 'https://rules2.clearurls.xyz/data.minify.json';
  const RULES_HASH_URL = 'https://rules2.clearurls.xyz/rules.minify.hash';

  const DEFAULT_SETTINGS = {
    enabled: true,
    // Proteções
    cleanLinks: true, // limpa links no clique / copiar (script de conteúdo)
    redirectSkipping: true, // pula redirecionadores (google.com/url?q=...)
    historyCleaning: true, // limpa URLs alteradas por history.pushState/replaceState
    domainBlocking: true, // bloqueia domínios de rastreamento/anúncio (completeProvider)
    pingBlocking: true, // bloqueia <a ping> e navigator.sendBeacon do tipo ping
    etagRemoval: false, // remove ETag (pode deixar o cache menos eficiente)
    allowReferralMarketing: false, // mantém parâmetros de afiliados
    skipLocalHosts: true, // ignora localhost / rede local
    cleanSubresources: false, // aplica as regras também a scripts, imagens, XHR... (avançado)
    // Interface
    showBadge: true,
    contextMenus: true,
    logEnabled: false, // registro local dos últimos itens limpos
    // Regras
    extraRules: true,
    autoUpdateRules: true,
    rulesUrl: RULES_URL,
    rulesHashUrl: RULES_HASH_URL,
    updateIntervalHours: 24,
    customRules: '', // JSON no mesmo formato (com "extend"/"disable" opcionais)
    pausedSites: [],
  };

  const BOOL_KEYS = Object.keys(DEFAULT_SETTINGS).filter((k) => typeof DEFAULT_SETTINGS[k] === 'boolean');

  function normalizeDomain(input) {
    if (typeof input !== 'string') return '';
    let s = input.trim().toLowerCase();
    if (!s) return '';
    try {
      if (/^[a-z]+:\/\//.test(s)) s = new URL(s).hostname;
    } catch (_) {
      return '';
    }
    s = s.replace(/^\*\./, '').replace(/^www\./, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
    return /^[a-z0-9.-]+\.[a-z0-9-]{2,}$|^localhost$/.test(s) ? s : '';
  }

  /** Mescla com os padrões e corrige tipos — nunca confie no que vem do storage/importação. */
  function sanitize(input) {
    const out = Object.assign({}, DEFAULT_SETTINGS);
    if (!input || typeof input !== 'object') return out;
    for (const k of BOOL_KEYS) if (typeof input[k] === 'boolean') out[k] = input[k];
    for (const k of ['rulesUrl', 'rulesHashUrl']) {
      if (typeof input[k] === 'string' && /^https:\/\//.test(input[k])) out[k] = input[k];
    }
    if (typeof input.customRules === 'string') out.customRules = input.customRules.slice(0, 500000);
    const h = Number(input.updateIntervalHours);
    if (Number.isFinite(h)) out.updateIntervalHours = Math.min(24 * 30, Math.max(1, Math.round(h)));
    if (Array.isArray(input.pausedSites)) {
      out.pausedSites = Array.from(new Set(input.pausedSites.map(normalizeDomain).filter(Boolean))).slice(0, 5000);
    }
    return out;
  }

  return { DEFAULT_SETTINGS, sanitize, normalizeDomain };
})();
