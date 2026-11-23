/*!
 * LinkLimpo — compilador de regras ClearURLs → declarativeNetRequest (Manifest V3).
 * Licença: LGPL-3.0-or-later.
 *
 * O Manifest V3 não permite reescrever requisições com código. Este módulo converte o que dá
 * para expressar em regras nativas do navegador, que agem ANTES da requisição sair:
 *   - remoção de parâmetros (redirect + queryTransform.removeParams)
 *   - exceções (regras "allow" com prioridade maior)
 *   - bloqueio de domínios de rastreamento (completeProvider)
 *   - bloqueio de "ping" (auditoria de hiperlinks) e remoção de ETag
 *   - sites pausados (allowAllRequests)
 * O que não dá para expressar (nomes de parâmetro com regex aberta, rawRules, redirecionadores
 * com decodificação) fica com o motor JS, que roda nos cliques e na navegação.
 */
globalThis.LinkLimpoDNR = (function () {
  'use strict';

  const RT_NAV = ['main_frame', 'sub_frame'];
  const RT_SUB = ['stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'media', 'websocket', 'other'];
  const RT_ALL_BUT_MAIN = ['sub_frame'].concat(RT_SUB, ['ping', 'csp_report', 'webtransport', 'webbundle']);

  const PRIORITY = {
    ping: 1,
    etag: 1,
    params: 10, // provedores: 10, 12, 14... (exceções: +1)
    block: 20000,
    paused: 30000,
  };

  // Limite do Chrome para regras dinâmicas com regex (MAX_NUMBER_OF_REGEX_RULES).
  const MAX_REGEX_RULES = 1000;
  const NAMES_PER_RULE = 150; // blocos grandes = menos saltos; se o RE2 recusar, o bloco é dividido

  // Parâmetros reais conhecidos, usados para "expandir" regras com regex aberta
  // (ex.: utm(?:_[a-z_]*)? → utm_source, utm_medium...). Só entra o que a própria regex aceita.
  const KNOWN_PARAMS = [
    'utm', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_name', 'utm_cid',
    'utm_reader', 'utm_referrer', 'utm_social', 'utm_social_type', 'utm_brand', 'utm_place', 'utm_pubreferrer',
    'utm_swu', 'utm_viz_id', 'utm_int', 'utm_keyword', 'utm_marketing_tactic', 'utm_source_platform',
    'utm_creative_format', 'utm_campaign_id', 'utm_adgroup', 'utm_ad', 'utm_placement', 'utm_channel', 'utm_type',
    'mtm', 'mtm_source', 'mtm_medium', 'mtm_campaign', 'mtm_keyword', 'mtm_content', 'mtm_cid', 'mtm_group', 'mtm_placement',
    'ga_source', 'ga_medium', 'ga_campaign', 'ga_term', 'ga_content', 'ga_place', 'ga_userid', 'ga_sid', 'ga_hid', 'ga_fc', 'ga_vid',
    'otm_source', 'otm_medium', 'otm_campaign', 'otm_content', 'otm_click_id',
    'vn_source', 'vn_medium', 'vn_campaign', 'vn_content', 'vn_term',
    'wt_mc', 'wt_zmc', 'wtmc', 'wtzmc', 'mc', 'smc', 'amc', 'cmc', 'emc', 'imc', 'pmc', 'smc',
    'hsa_acc', 'hsa_cam', 'hsa_grp', 'hsa_ad', 'hsa_src', 'hsa_tgt', 'hsa_kw', 'hsa_mt', 'hsa_net', 'hsa_ver', 'hsa_la', 'hsa_ol',
    'ref', 'ref_', 'referrer', 'ref_src', 'ref_url', 'refsrc', 'fref', 'hc_ref', 'hc_location', 'refid', 'src', 'source',
    'biw', 'bih', 'gs_l', 'gs_lcp', 'gs_lp', 'gs_lcrp', 'gs_ssp', 'gs_ivs', 'gs_mss', 'gs_rn', 'gs_ri', 'gs_gbg', 'gs_upl',
    'gws_rd', 'gfe_rd', 'btnK', 'btnI', 'btnG', 'sca_esv', 'sca_upv',
    'pd_rd_w', 'pd_rd_r', 'pd_rd_wg', 'pd_rd_i', 'pd_rd_plhdr', 'pf_rd_p', 'pf_rd_r', 'pf_rd_s', 'pf_rd_t', 'pf_rd_i', 'pf_rd_m',
    '__mk_pt_BR', '__mk_en_US', '__mk_de_DE', '__mk_es_ES', '__mk_fr_FR', '__mk_it_IT', '__mk_ja_JP', '__mk_nl_NL', '__mk_zh_CN',
    'cv_ct_cx', 'cv_ct_id', 'cv_ct_pg', 'cv_ct_we', 'cv_ct_wn', 'sb-ci-n', 'sb-ci-v', 'sb-ci-a',
    'scm', 'scm_id', 'scm-url', 'scm-cnt',
    'c_id', 'c_uid', 'c_element_order', 'c_campaign', 'c_label', 'c_container_id', 'c_element_id', 'c_global_position',
    'c_tracking_id', 'c_position', 'c_type', 'c_category', 'c_event', 'c_page',
    'reco_backend', 'reco_backend_type', 'reco_client', 'reco_item_pos', 'reco_model', 'reco_id',
    'matt_tool', 'matt_word', 'matt_source', 'matt_campaign', 'matt_ad_type', 'matt_ad_position', 'matt_ad_id', 'matt_network',
    'lipi', 'lici', 'liid',
    'hc_location', 'hc_ref',
    '_x_ads_channel', '_x_ads_sub_channel', '_x_ads_account', '_x_ads_set', '_x_ads_id', '_x_ads_creative_id', '_x_ns_source',
    '_x_ns_gclid', '_x_vst_scene', '_x_sessn_id', '_x_campaign', '_x_cid',
    'refer_page_name', 'refer_page_id', 'refer_page_sn', '_oak_name_id', '_oak_mp_inf', '_oak_gallery', '_oak_gallery_order',
    'gs_lp',
  ];

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
  }

  /** Heurística de compatibilidade com RE2 (o motor de regex do declarativeNetRequest). */
  function looksRe2Compatible(src) {
    if (/\(\?[=!]|\(\?<[=!]|\(\?<[A-Za-z]/.test(src)) return false; // lookaround / grupos nomeados
    if (/\\[1-9]/.test(src)) return false; // backreference
    try {
      new RegExp(src);
    } catch (_) {
      return false;
    }
    return true;
  }

  /* ---------------------------------------------- expansão de nomes regex */

  /**
   * Enumera todas as strings aceitas por uma regex "finita" simples
   * (literais, escapes, (a|b), (?:x)?, [ab], x?). Retorna null se não for finita
   * ou se passar do limite.
   */
  function enumerate(src, limit) {
    let pos = 0;
    const fail = () => {
      throw new Error('nf');
    };
    function cross(a, b) {
      const out = [];
      for (const x of a) for (const y of b) {
        out.push(x + y);
        if (out.length > limit) fail();
      }
      return out;
    }
    function parseAlt() {
      let result = [];
      let seq = parseSeq();
      result = result.concat(seq);
      while (src[pos] === '|') {
        pos++;
        seq = parseSeq();
        result = result.concat(seq);
        if (result.length > limit) fail();
      }
      return result;
    }
    function parseSeq() {
      let acc = [''];
      while (pos < src.length && src[pos] !== '|' && src[pos] !== ')') {
        let atom = parseAtom();
        if (src[pos] === '?') {
          pos++;
          atom = atom.concat(['']);
        } else if (src[pos] === '*' || src[pos] === '+' || src[pos] === '{') {
          fail();
        }
        acc = cross(acc, atom);
      }
      return acc;
    }
    function parseAtom() {
      const c = src[pos];
      if (c === '(') {
        pos++;
        if (src.startsWith('?:', pos)) pos += 2;
        else if (src[pos] === '?') fail();
        const inner = parseAlt();
        if (src[pos] !== ')') fail();
        pos++;
        return inner;
      }
      if (c === '[') {
        pos++;
        if (src[pos] === '^') fail();
        const chars = [];
        while (pos < src.length && src[pos] !== ']') {
          let ch = src[pos];
          if (ch === '\\') {
            pos++;
            ch = src[pos];
            if (/[A-Za-z0-9]/.test(ch)) fail();
          } else if (src[pos + 1] === '-' && src[pos + 2] !== ']') {
            fail(); // intervalo
          }
          chars.push(ch);
          pos++;
        }
        if (src[pos] !== ']') fail();
        pos++;
        return chars;
      }
      if (c === '\\') {
        pos++;
        const e = src[pos++];
        if (e === undefined || /[A-Za-z0-9]/.test(e)) fail();
        return [e];
      }
      if ('.^$*+?{}'.includes(c)) fail();
      pos++;
      return [c];
    }
    try {
      const out = parseAlt();
      if (pos !== src.length) return null;
      return Array.from(new Set(out));
    } catch (_) {
      return null;
    }
  }

  const SAFE_NAME = /^[A-Za-z0-9_.$\-[\]~!*'(),;:@]+$/;

  /** Converte uma regra de nome (regex) em nomes literais para removeParams. */
  function expandRule(rule, dictionary) {
    const stripped = rule.replace(/^\(\?:%3F\)\?/i, '');
    const finite = enumerate(stripped, 64);
    let names;
    if (finite) {
      names = finite;
    } else {
      let re;
      try {
        re = new RegExp('^(?:' + rule + ')$', 'i');
      } catch (_) {
        return [];
      }
      names = dictionary.filter((n) => re.test(n));
    }
    return names.filter((n) => n && SAFE_NAME.test(n) && !n.includes('%'));
  }

  function buildDictionary(providers) {
    const set = new Set(KNOWN_PARAMS);
    for (const def of Object.values(providers)) {
      for (const r of (def.rules || []).concat(def.referralMarketing || [])) {
        const fin = enumerate(r.replace(/^\(\?:%3F\)\?/i, ''), 64);
        if (fin) fin.forEach((n) => set.add(n));
      }
    }
    return Array.from(set);
  }

  /* ------------------------------------------------------------ compilador */

  /**
   * @param {{providers: Object}} ruleset  regras mescladas
   * @param {Object} settings  configurações da extensão
   * @param {Object} ctx
   *   blockedPageUrl — URL da página de bloqueio da extensão (para main_frame bloqueado)
   *   isRegexSupported — async (regex) => boolean   (no navegador: chrome.declarativeNetRequest.isRegexSupported)
   * @returns {Promise<{rules: Array, meta: Object, stats: Object}>}
   */
  async function compile(ruleset, settings, ctx = {}) {
    const rules = [];
    const meta = {}; // id → { provider, kind }
    const stats = { providers: 0, paramRules: 0, exceptionRules: 0, blockRules: 0, skipped: [], regexRules: 0 };
    if (!settings || settings.enabled === false) return { rules, meta, stats };

    const supported = ctx.isRegexSupported || (async (r) => looksRe2Compatible(r));
    const cache = new Map();
    const check = async (regex) => {
      if (cache.has(regex)) return cache.get(regex);
      let ok = looksRe2Compatible(regex);
      if (ok) {
        try {
          ok = await supported(regex);
        } catch (_) {
          ok = false;
        }
      }
      cache.set(regex, ok);
      return ok;
    };

    let nextId = 1;
    const add = (rule, info) => {
      rule.id = nextId++;
      if (rule.condition.regexFilter) {
        if (stats.regexRules >= MAX_REGEX_RULES) return false;
        stats.regexRules++;
      }
      rules.push(rule);
      if (info) meta[rule.id] = info;
      return true;
    };

    const providers = (ruleset && ruleset.providers) || {};
    const dictionary = buildDictionary(providers);
    const paramTypes = settings.cleanSubresources ? RT_NAV.concat(RT_SUB) : RT_NAV.slice();

    // 1. Sites pausados — vencem tudo.
    const paused = (settings.pausedSites || []).filter((d) => typeof d === 'string' && d);
    if (paused.length) {
      add({
        priority: PRIORITY.paused,
        action: { type: 'allowAllRequests' },
        condition: { requestDomains: paused, resourceTypes: RT_NAV },
      }, { provider: 'paused', kind: 'paused' });
    }

    // 2. Provedores. globalRules primeiro (menor prioridade), depois os específicos.
    const names = Object.keys(providers);
    names.sort((a, b) => (a === 'globalRules' ? -1 : b === 'globalRules' ? 1 : 0));

    let index = 0;
    for (const name of names) {
      const def = providers[name];
      if (!def || typeof def.urlPattern !== 'string') continue;
      const prio = PRIORITY.params + index * 2;
      index++;

      const pattern = def.urlPattern === '.*' ? '' : '(?:' + def.urlPattern + ')';
      if (pattern && !(await check(def.urlPattern))) {
        stats.skipped.push({ provider: name, reason: 'urlPattern' });
        continue;
      }
      // Sem conseguir honrar TODAS as exceções no nível de rede, o provedor fica só com o motor JS.
      const exceptions = def.exceptions || [];
      let exceptionsOk = true;
      for (const ex of exceptions) if (!(await check(ex))) exceptionsOk = false;
      if (!exceptionsOk) {
        stats.skipped.push({ provider: name, reason: 'exceptions' });
        continue;
      }

      const isComplete = def.completeProvider === true;
      if (isComplete && !settings.domainBlocking) continue;

      // Nomes literais a remover.
      let literal = [];
      if (!isComplete) {
        const list = (def.rules || []).concat(settings.allowReferralMarketing ? [] : def.referralMarketing || []);
        const set = new Set();
        for (const r of list) for (const n of expandRule(r, dictionary)) set.add(n);
        literal = Array.from(set);
        if (!literal.length) continue;
      }

      const exPriority = isComplete ? PRIORITY.block + 1 : prio + 1;
      const exTypes = isComplete ? ['main_frame'].concat(RT_ALL_BUT_MAIN) : paramTypes;
      const pending = [];

      if (isComplete) {
        // main_frame bloqueado mostra o erro do navegador; o service worker detecta
        // (webNavigation.onErrorOccurred) e troca pela página explicativa da extensão —
        // assim não é preciso expor a página como web_accessible_resource.
        pending.push({
          rule: {
            priority: PRIORITY.block,
            action: { type: 'block' },
            condition: {
              regexFilter: '^' + (pattern || '.*'),
              isUrlFilterCaseSensitive: false,
              resourceTypes: ['main_frame'].concat(RT_ALL_BUT_MAIN),
            },
          },
          info: { provider: name, kind: 'block' },
        });
      } else {
        // Uma regra por bloco de nomes; o filtro exige que algum desses nomes esteja na query,
        // assim a regra só dispara quando há o que remover e as próximas podem agir em cadeia.
        const chunks = [];
        for (let i = 0; i < literal.length; i += NAMES_PER_RULE) chunks.push(literal.slice(i, i + NAMES_PER_RULE));
        while (chunks.length) {
          const chunk = chunks.shift();
          const regexFilter = '^' + pattern + '[^#]*[?&](?:' + chunk.map(escapeRegex).join('|') + ')(?:=|&|#|$)';
          if (!(await check(regexFilter))) {
            if (chunk.length > 1) {
              const mid = Math.ceil(chunk.length / 2);
              chunks.unshift(chunk.slice(0, mid), chunk.slice(mid));
            } else {
              stats.skipped.push({ provider: name, reason: 'name:' + chunk[0] });
            }
            continue;
          }
          pending.push({
            rule: {
              priority: prio,
              action: { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: chunk } } } },
              condition: { regexFilter, isUrlFilterCaseSensitive: false, resourceTypes: paramTypes },
            },
            info: { provider: name, kind: 'params' },
          });
        }
      }
      if (!pending.length) continue;

      for (const ex of exceptions) {
        pending.push({
          rule: {
            priority: exPriority,
            action: { type: 'allow' },
            condition: { regexFilter: ex, isUrlFilterCaseSensitive: false, resourceTypes: exTypes },
          },
          info: { provider: name, kind: 'exception' },
        });
      }

      // Só adiciona o provedor se couber inteiro (regras + exceções) no limite de regex.
      const needed = pending.filter((p) => p.rule.condition.regexFilter).length;
      if (stats.regexRules + needed > MAX_REGEX_RULES) {
        stats.skipped.push({ provider: name, reason: 'limit' });
        continue;
      }
      for (const p of pending) {
        add(p.rule, p.info);
        if (p.info.kind === 'params') stats.paramRules++;
        else if (p.info.kind === 'exception') stats.exceptionRules++;
        else if (p.info.kind === 'block') stats.blockRules++;
      }
      stats.providers++;
    }

    // 3. Auditoria de hiperlinks (<a ping>) e beacons de "ping".
    if (settings.pingBlocking) {
      add({ priority: PRIORITY.ping, action: { type: 'block' }, condition: { resourceTypes: ['ping'] } }, { provider: 'ping', kind: 'ping' });
    }

    // 4. ETag (rastreamento por cache).
    if (settings.etagRemoval) {
      add({
        priority: PRIORITY.etag,
        action: { type: 'modifyHeaders', responseHeaders: [{ header: 'etag', operation: 'remove' }] },
        condition: { resourceTypes: RT_ALL_BUT_MAIN.concat(['main_frame']) },
      }, { provider: 'etag', kind: 'etag' });
    }

    return { rules, meta, stats };
  }

  return { compile };
})();
