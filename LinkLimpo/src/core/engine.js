/*!
 * LinkLimpo — motor de limpeza de URLs.
 * Compatível com o formato de regras do ClearURLs (https://docs.clearurls.xyz/specs/rules).
 * Licença: LGPL-3.0-or-later.
 *
 * Script clássico: carregado pelo service worker (importScripts) e pelo script de conteúdo.
 */
globalThis.LinkLimpoEngine = (function () {
  'use strict';

  const MAX_REDIRECT_DEPTH = 5;
  const CACHE_SIZE = 1000;

  // Prefixos de host usados por quase todos os urlPattern do ClearURLs.
  const HOST_PREFIXES = [
    '^https?:\\/\\/(?:[a-z0-9-]+\\.)*?',
    '^https?:\\/\\/(?:[a-z0-9-]+\\.)*',
    '^https?:\\/\\/(?:www\\.)?',
    '^https?:\\/\\/',
  ];

  /* ------------------------------------------------------------------ utils */

  function safeDecode(s) {
    try {
      return decodeURIComponent(s);
    } catch (_) {
      return s;
    }
  }

  function tryRegExp(source, flags) {
    try {
      return new RegExp(source, flags);
    } catch (_) {
      return null;
    }
  }

  /** Verdadeiro se a regex tem `|` fora de grupos e classes (alternância no nível superior). */
  function hasTopLevelAlternation(src) {
    let depth = 0;
    let inClass = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') {
        i++;
        continue;
      }
      if (inClass) {
        if (c === ']') inClass = false;
        continue;
      }
      if (c === '[') inClass = true;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === '|' && depth === 0) return true;
    }
    return false;
  }

  /**
   * Extrai um trecho literal obrigatório (ex.: "amazon") de um urlPattern.
   * Serve de pré-filtro barato: se a URL não contém o trecho, a regex nem é testada.
   * Retorna null quando não dá para garantir que o trecho é obrigatório.
   */
  function extractKeyword(pattern) {
    if (typeof pattern !== 'string' || hasTopLevelAlternation(pattern)) return null;
    let rest = null;
    for (const prefix of HOST_PREFIXES) {
      if (pattern.startsWith(prefix)) {
        rest = pattern.slice(prefix.length);
        break;
      }
    }
    if (rest === null) return null;
    let kw = '';
    let i = 0;
    while (i < rest.length) {
      const c = rest[i];
      if (/[A-Za-z0-9_-]/.test(c)) {
        kw += c;
        i++;
      } else if (c === '\\' && i + 1 < rest.length && /[./_-]/.test(rest[i + 1])) {
        kw += rest[i + 1];
        i += 2;
      } else {
        break;
      }
    }
    const next = rest[i];
    // Quantificador que torna o último caractere opcional/repetível.
    if (next === '?' || next === '*' || next === '{') kw = kw.slice(0, -1);
    kw = kw.toLowerCase();
    return kw.length >= 3 ? kw : null;
  }

  function isLocalHost(hostname) {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
    if (host === '0.0.0.0' || host === '::1') return true;
    if (/^(?:127|10)\.\d+\.\d+\.\d+$/.test(host)) return true;
    if (/^192\.168\.\d+\.\d+$/.test(host) || /^169\.254\.\d+\.\d+$/.test(host)) return true;
    if (/^172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host)) return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
    return false;
  }

  function base64UrlDecode(input) {
    try {
      let s = input.replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      const bin = atob(s);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_) {
      return null;
    }
  }

  /**
   * Decodifica o destino extraído de um redirecionador.
   * Diferente do ClearURLs, não decodifica "até não dar mais": remove só as camadas de
   * codificação necessárias para chegar numa URL absoluta, preservando os parâmetros
   * codificados do próprio destino (ex.: q=a%26b continua intacto).
   */
  function decodeTarget(raw, spec) {
    let s = raw;
    if (spec && spec.stripPrefix && s.startsWith(spec.stripPrefix)) s = s.slice(spec.stripPrefix.length);
    if (spec && spec.decode === 'base64url') {
      s = base64UrlDecode(s);
      if (s == null) return null;
    }
    for (let i = 0; i < 4 && !/^https?:\/\//i.test(s); i++) {
      const d = safeDecode(s);
      if (d === s) break;
      s = d;
    }
    // Ex.: "https://site.com%2Fpagina%3Fx%3D1" — o resto ainda está codificado.
    if (/^https?:\/\/[^/?#]*%2f/i.test(s)) s = safeDecode(s);
    if (!/^https?:\/\//i.test(s)) return null;
    try {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.href;
    } catch (_) {
      return null;
    }
  }

  function splitUrl(url) {
    const hashIdx = url.indexOf('#');
    const beforeHash = hashIdx === -1 ? url : url.slice(0, hashIdx);
    const hash = hashIdx === -1 ? null : url.slice(hashIdx + 1);
    const qIdx = beforeHash.indexOf('?');
    return {
      base: qIdx === -1 ? beforeHash : beforeHash.slice(0, qIdx),
      query: qIdx === -1 ? null : beforeHash.slice(qIdx + 1),
      hash,
    };
  }

  /**
   * Remove de "a=1&b=2" os campos cujo nome casa com `test`. Mantém os demais campos
   * exatamente como estavam (sem recodificar — o ClearURLs recodificava e às vezes
   * quebrava URLs). Retorna null quando nada foi removido.
   */
  function filterFields(str, test, removed) {
    const parts = str.split('&');
    const kept = [];
    const before = removed.length;
    for (const part of parts) {
      if (part === '') continue;
      const eq = part.indexOf('=');
      const rawKey = eq === -1 ? part : part.slice(0, eq);
      const key = safeDecode(rawKey.replace(/\+/g, ' '));
      if (test(rawKey) || (key !== rawKey && test(key))) {
        removed.push(key);
        continue;
      }
      kept.push(part);
    }
    if (removed.length === before) return null;
    return kept.join('&');
  }

  /** O fragmento só é tratado como lista de parâmetros quando parece uma (ex.: #a=1&b=2). */
  function hashLooksLikeParams(hash) {
    return hash.includes('=') && !/^[/!?]/.test(hash);
  }

  /* -------------------------------------------------------------- provider */

  function normalizeRedirections(list) {
    const out = [];
    for (const item of list || []) {
      if (typeof item === 'string') {
        const re = tryRegExp(item, 'i');
        if (re) out.push({ re, spec: null });
      } else if (item && typeof item.regex === 'string') {
        const re = tryRegExp(item.regex, 'i');
        if (re) out.push({ re, spec: { decode: item.decode || null, stripPrefix: item.stripPrefix || '' } });
      }
    }
    return out;
  }

  function compileNameList(list, flags) {
    const valid = [];
    for (const r of list) {
      if (typeof r === 'string' && r && tryRegExp(r, flags)) valid.push(r);
    }
    if (!valid.length) return null;
    return tryRegExp('^(?:' + valid.map((r) => '(?:' + r + ')').join('|') + ')$', flags);
  }

  class Provider {
    constructor(name, def) {
      this.name = name;
      this.def = def;
      this.keyword = extractKeyword(def.urlPattern);
      this.compiled = null;
    }

    compile(allowReferral) {
      if (this.compiled && this.compiled.allowReferral === allowReferral) return this.compiled;
      const d = this.def;
      const names = (d.rules || []).slice();
      if (!allowReferral) names.push(...(d.referralMarketing || []));
      this.compiled = {
        allowReferral,
        pattern: tryRegExp(d.urlPattern, 'i'),
        exceptions: (d.exceptions || []).map((e) => tryRegExp(e, 'i')).filter(Boolean),
        redirections: normalizeRedirections(d.redirections),
        rawRules: (d.rawRules || []).map((r) => tryRegExp(r, 'gi')).filter(Boolean),
        names: compileNameList(names, 'i'),
        complete: d.completeProvider === true,
      };
      return this.compiled;
    }
  }

  /* ---------------------------------------------------------------- engine */

  class Engine {
    /**
     * @param {{providers: Object}} ruleset  regras no formato ClearURLs (já mescladas)
     * @param {Object} options
     *   allowReferral  — mantém parâmetros de afiliado (referralMarketing). Padrão: false
     *   domainBlocking — marca como bloqueadas URLs de provedores "completeProvider". Padrão: true
     *   skipLocal      — ignora localhost e IPs privados. Padrão: true
     *   redirects      — pula redirecionadores (google.com/url?q=...). Padrão: true
     */
    constructor(ruleset, options = {}) {
      this.options = {
        allowReferral: !!options.allowReferral,
        domainBlocking: options.domainBlocking !== false,
        skipLocal: options.skipLocal !== false,
        redirects: options.redirects !== false,
      };
      this.providers = [];
      this.alwaysCheck = [];
      this.byKeyword = [];
      const providers = (ruleset && ruleset.providers) || {};
      for (const name of Object.keys(providers)) {
        const def = providers[name];
        if (!def || typeof def.urlPattern !== 'string') continue;
        const p = new Provider(name, def);
        p.index = this.providers.length;
        this.providers.push(p);
        if (p.keyword) this.byKeyword.push(p);
        else this.alwaysCheck.push(p);
      }
      this.cache = new Map();
      this.cacheSize = options.cacheSize > 0 ? options.cacheSize : CACHE_SIZE;
    }

    get size() {
      return this.providers.length;
    }

    /** Provedores que podem casar com a URL, na ordem original das regras. */
    candidates(url) {
      const lower = url.toLowerCase();
      const list = this.alwaysCheck.slice();
      for (const p of this.byKeyword) if (lower.includes(p.keyword)) list.push(p);
      if (list.length > 1) list.sort((a, b) => a.index - b.index);
      return list;
    }

    /**
     * Limpa uma URL.
     * @returns {{url: string, original: string, changed: boolean, redirected: boolean,
     *            blocked: boolean, matches: Array<{provider: string, removed: string[], redirected?: boolean, blocked?: boolean}>}}
     */
    clean(url) {
      if (typeof url !== 'string') return this._unchanged(String(url));
      const hit = this.cache.get(url);
      if (hit) {
        // Renova a posição no LRU.
        this.cache.delete(url);
        this.cache.set(url, hit);
        return hit;
      }
      const result = this._clean(url, 0);
      if (this.cache.size >= this.cacheSize) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(url, result);
      return result;
    }

    _unchanged(url) {
      return { url, original: url, changed: false, redirected: false, blocked: false, matches: [] };
    }

    _clean(original, depth) {
      let parsed;
      try {
        parsed = new URL(original);
      } catch (_) {
        return this._unchanged(original);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return this._unchanged(original);
      if (this.options.skipLocal && isLocalHost(parsed.hostname)) return this._unchanged(original);

      const { allowReferral, domainBlocking, redirects } = this.options;
      const matches = [];
      let url = original;

      for (const provider of this.candidates(original)) {
        const c = provider.compile(allowReferral);
        if (!c.pattern || !c.pattern.test(url)) continue;
        if (c.exceptions.some((e) => e.test(url))) continue;

        if (redirects) {
          for (const { re, spec } of c.redirections) {
            const m = re.exec(url);
            if (!m || !m[1]) continue;
            const target = decodeTarget(m[1], spec);
            if (!target || target === url) continue;
            matches.push({ provider: provider.name, removed: [], redirected: true });
            if (depth >= MAX_REDIRECT_DEPTH) {
              return { url: target, original, changed: true, redirected: true, blocked: false, matches };
            }
            const inner = this._clean(target, depth + 1);
            return {
              url: inner.url,
              original,
              changed: true,
              redirected: true,
              blocked: inner.blocked,
              matches: matches.concat(inner.matches),
            };
          }
        }

        if (c.complete) {
          if (domainBlocking) {
            matches.push({ provider: provider.name, removed: [], blocked: true });
            return { url, original, changed: url !== original, redirected: false, blocked: true, matches };
          }
          continue;
        }

        const removed = [];
        for (const raw of c.rawRules) {
          raw.lastIndex = 0;
          const found = url.match(raw);
          if (!found) continue;
          raw.lastIndex = 0;
          const next = url.replace(raw, '');
          if (next !== url) {
            for (const f of found) if (f) removed.push(f.length > 40 ? f.slice(0, 40) + '…' : f);
            url = next;
          }
        }

        if (c.names) {
          const parts = splitUrl(url);
          if (parts.query !== null || parts.hash !== null) {
            const test = (k) => c.names.test(k);
            let query = parts.query;
            let hash = parts.hash;
            if (query !== null && query !== '') {
              const q = filterFields(query, test, removed);
              if (q !== null) query = q;
            }
            if (hash !== null && hashLooksLikeParams(hash)) {
              const h = filterFields(hash, test, removed);
              if (h !== null) hash = h;
            }
            if (query !== parts.query || hash !== parts.hash) {
              url = parts.base + (query ? '?' + query : '') + (hash ? '#' + hash : '');
            }
          }
        }

        if (removed.length) matches.push({ provider: provider.name, removed });
      }

      return { url, original, changed: url !== original, redirected: false, blocked: false, matches };
    }
  }

  /* --------------------------------------------------------------- rulesets */

  const ARRAY_FIELDS = ['rules', 'rawRules', 'referralMarketing', 'exceptions', 'redirections'];

  function cloneProvider(def) {
    const out = Object.assign({}, def);
    for (const f of ARRAY_FIELDS) if (Array.isArray(def[f])) out[f] = def[f].slice();
    return out;
  }

  /**
   * Mescla regras. Cada camada pode ter:
   *   providers: { nome: definição }  — adiciona ou substitui provedores
   *   extend:    { nome: { rules: [...], exceptions: [...], ... } } — acrescenta itens a provedores existentes
   *   disable:   [ "nome", ... ]      — desativa provedores
   */
  function mergeRulesets(base, ...layers) {
    const providers = {};
    const src = (base && base.providers) || {};
    for (const name of Object.keys(src)) providers[name] = cloneProvider(src[name]);
    for (const layer of layers) {
      if (!layer || typeof layer !== 'object') continue;
      for (const [name, def] of Object.entries(layer.providers || {})) {
        if (def && typeof def.urlPattern === 'string') providers[name] = cloneProvider(def);
      }
      for (const [name, ext] of Object.entries(layer.extend || {})) {
        const target = providers[name];
        if (!target || !ext) continue;
        for (const f of ARRAY_FIELDS) {
          if (!Array.isArray(ext[f])) continue;
          const set = new Set((target[f] || []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))));
          target[f] = (target[f] || []).concat(
            ext[f].filter((x) => !set.has(typeof x === 'string' ? x : JSON.stringify(x)))
          );
        }
      }
      for (const name of layer.disable || []) delete providers[name];
    }
    return { providers };
  }

  /** Valida um conjunto de regras e devolve a lista de problemas encontrados. */
  function validateRuleset(ruleset) {
    const errors = [];
    if (!ruleset || typeof ruleset !== 'object') return ['O conteúdo não é um objeto JSON.'];
    const check = (where, src, flags) => {
      if (typeof src !== 'string') errors.push(where + ': esperado texto');
      else if (!tryRegExp(src, flags)) errors.push(where + ': regex inválida');
    };
    for (const [name, def] of Object.entries(ruleset.providers || {})) {
      if (!def || typeof def !== 'object') {
        errors.push(name + ': definição inválida');
        continue;
      }
      check(name + '.urlPattern', def.urlPattern, 'i');
      for (const f of ['rules', 'rawRules', 'referralMarketing', 'exceptions']) {
        (def[f] || []).forEach((r, i) => check(name + '.' + f + '[' + i + ']', r, 'i'));
      }
      (def.redirections || []).forEach((r, i) =>
        check(name + '.redirections[' + i + ']', typeof r === 'string' ? r : r && r.regex, 'i')
      );
    }
    for (const [name, ext] of Object.entries(ruleset.extend || {})) {
      for (const f of ['rules', 'rawRules', 'referralMarketing', 'exceptions']) {
        (ext[f] || []).forEach((r, i) => check('extend.' + name + '.' + f + '[' + i + ']', r, 'i'));
      }
    }
    return errors;
  }

  return { Engine, mergeRulesets, validateRuleset };
})();
