/*!
 * LinkLimpo — script de conteúdo.
 * Limpa links no momento da interação (passar o mouse, clicar, botão do meio, menu
 * "copiar endereço do link", arrastar), antes de o navegador sair da página. Também limpa
 * a URL da própria página quando sobra rastreamento que as regras de rede não pegaram.
 *
 * Leve por padrão: no início da página só lê as configurações (poucos bytes). As regras só
 * são carregadas quando você mexe o mouse/teclado na página — quem só lê não paga nada.
 * A URL da própria página é conferida pelo service worker, que já tem as regras na memória.
 * Licença: LGPL-3.0-or-later.
 */
(() => {
  'use strict';
  if (globalThis.__linkLimpoLoaded) return;
  globalThis.__linkLimpoLoaded = true;

  const { Engine } = globalThis.LinkLimpoEngine;
  const { sanitize } = globalThis.LinkLimpoSettings;
  const LINK_SELECTOR = 'a[href], area[href]';

  let settings = null;
  let active = false;
  let engine = null;
  let loading = null;
  const done = new WeakMap(); // <a> → última href limpa (evita retrabalho)
  let pending = [];
  let flushTimer = null;

  function pausedHere(s) {
    const host = location.hostname.toLowerCase().replace(/^www\./, '');
    return s.pausedSites.some((d) => host === d || host.endsWith('.' + d));
  }

  function applySettings(s) {
    settings = s;
    active = !!(s && s.enabled && !pausedHere(s));
    engine = null; // as opções do motor podem ter mudado
    loading = null;
  }

  /** Carrega as regras e monta o motor (uma vez por página, sob demanda). */
  function ensureEngine() {
    if (engine || !active) return Promise.resolve(engine);
    if (!loading) {
      const s = settings;
      loading = chrome.storage.local
        .get('ruleset')
        .then(({ ruleset }) => {
          if (settings !== s || !ruleset) return null; // configuração mudou no meio do caminho
          engine = new Engine(ruleset, {
            allowReferral: s.allowReferralMarketing,
            domainBlocking: s.domainBlocking,
            skipLocal: s.skipLocalHosts,
            redirects: s.redirectSkipping,
            cacheSize: 200,
          });
          return engine;
        })
        .catch(() => null);
    }
    return loading;
  }

  function report(kind, r) {
    const m = r.matches.find((x) => x.redirected) || r.matches[0] || {};
    pending.push({
      kind,
      provider: m.provider,
      removed: r.matches.flatMap((x) => x.removed || []),
      before: r.original,
      after: r.url,
    });
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        const items = pending;
        pending = [];
        try {
          chrome.runtime.sendMessage({ type: 'contentCleaned', items }).catch(() => {});
        } catch (_) {
          /* extensão recarregada: contexto inválido */
        }
      }, 400);
    }
  }

  /* ------------------------------------------------------------ links */

  function findAnchor(event) {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    // Caminho rápido (nativo); composedPath só quando o alvo está dentro de shadow DOM.
    if (target.getRootNode() === document) return target.closest(LINK_SELECTOR);
    for (const node of event.composedPath()) {
      if (node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement) return node.hasAttribute('href') ? node : null;
      if (node === document.body) break;
    }
    return null;
  }

  function cleanAnchor(a) {
    if (settings.pingBlocking && a.hasAttribute('ping')) a.removeAttribute('ping');
    const href = a.href;
    if (!href || done.get(a) === href || !/^https?:/i.test(href)) return;
    const r = engine.clean(href);
    done.set(a, r.url);
    if (!r.changed || r.blocked) return;
    a.href = r.url;
    done.set(a, a.href);
    report(r.redirected ? 'redirect' : 'link', r);
  }

  function onInteract(event) {
    if (!active || !settings.cleanLinks) return;
    const a = findAnchor(event);
    if (!a) return;
    if (!engine) {
      // Primeira interação com um link: carrega as regras agora. O mouse passa pelo link
      // antes do clique, então o motor fica pronto bem antes de o clique acontecer.
      ensureEngine().then((e) => e && cleanAnchorSafe(a));
      return;
    }
    cleanAnchorSafe(a);
  }

  function cleanAnchorSafe(a) {
    try {
      cleanAnchor(a);
    } catch (e) {
      console.debug('[LinkLimpo]', e);
    }
  }

  // Captura no window: roda antes dos handlers da página. "click" de novo porque alguns sites
  // (ex.: buscadores) reescrevem o href no mousedown — limpamos depois deles também.
  for (const type of ['mouseover', 'pointerdown', 'click', 'auxclick', 'contextmenu', 'dragstart', 'focusin']) {
    window.addEventListener(type, onInteract, { capture: true, passive: true });
  }

  // Aquecimento: o primeiro movimento do mouse ou tecla na página já carrega as regras,
  // antes de o cursor chegar a um link. Quem só rola a página com a roda não paga nada.
  const warm = () => {
    window.removeEventListener('pointermove', warm, true);
    window.removeEventListener('keydown', warm, true);
    if (active && settings.cleanLinks) ensureEngine();
  };
  window.addEventListener('pointermove', warm, { capture: true, passive: true });
  window.addEventListener('keydown', warm, { capture: true, passive: true });

  /* ---------------------------------------------------- URL da página */

  /** Troca o endereço já limpo pelo service worker, sem recarregar a página. */
  function replaceUrl(url, from) {
    if (!active || !settings.historyCleaning || location.href !== from) return false;
    try {
      const next = new URL(url);
      if (next.origin !== location.origin) return false;
      history.replaceState(history.state, '', next.href);
      return true;
    } catch (_) {
      return false; // alguns documentos (sandbox) não permitem
    }
  }

  /* ---------------------------------------------------------- aviso */

  function toast(text) {
    const host = document.createElement('linklimpo-toast');
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; position: fixed; z-index: 2147483647; left: 50%; bottom: 24px; transform: translateX(-50%); }
      div { font: 500 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff; background: #10231f;
            padding: 10px 14px; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.25);
            display: flex; gap: 8px; align-items: center; opacity: 0; transform: translateY(8px);
            transition: opacity .18s ease, transform .18s ease; }
      div.on { opacity: 1; transform: none; }
      b { color: #5eead4; font-weight: 700; }
      @media (prefers-reduced-motion: reduce) { div { transition: none; } }`;
    const box = document.createElement('div');
    const mark = document.createElement('b');
    mark.textContent = '✓';
    box.append(mark, document.createTextNode(text));
    root.append(style, box);
    (document.body || document.documentElement).append(host);
    requestAnimationFrame(() => box.classList.add('on'));
    setTimeout(() => {
      box.classList.remove('on');
      setTimeout(() => host.remove(), 250);
    }, 1800);
  }

  /* ------------------------------------------------------- mensagens */

  function loadSettings() {
    return chrome.storage.local
      .get('settings')
      .then(({ settings: s }) => applySettings(sanitize(s)))
      .catch(() => {});
  }

  // O service worker avisa quando configurações ou regras mudam. (Não usamos
  // storage.onChanged: ele dispararia em todas as abas a cada gravação de estatística.)
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === 'replaceUrl') {
      // Garante as configurações carregadas antes de responder.
      (settings ? Promise.resolve() : loadSettings()).then(() => sendResponse(replaceUrl(msg.url, msg.from)));
      return true;
    }
    if (msg.type === 'configChanged') loadSettings();
    else if (msg.type === 'toast' && typeof msg.text === 'string') toast(msg.text.slice(0, 120));
    return false;
  });

  loadSettings();
})();
