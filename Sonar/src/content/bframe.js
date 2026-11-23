/* Content script do iframe de desafio do reCAPTCHA (bframe).
 * Fluxo: abrir desafio de áudio → baixar → transcrever → digitar → verificar → repetir se preciso.
 * Do início ao fim, a tela do Sonar (overlay.js) cobre o desafio. */
(() => {
  if (window.__sonar) return;
  window.__sonar = true;

  const SEL = {
    buttons: '.rc-buttons',
    help: '.help-button-holder',
    audioButton: '#recaptcha-audio-button',
    reloadButton: '#recaptcha-reload-button',
    verifyButton: '#recaptcha-verify-button',
    audioLink: '.rc-audiochallenge-tdownload-link',
    audioSource: '#audio-source',
    audioInput: '#audio-response',
    blocked: '.rc-doscaptcha-header-text, .rc-doscaptcha-body-text',
  };

  const state = {
    settings: { ...SONAR_DEFAULTS },
    solving: false,
    cancelled: false,
    visible: false,
    autoDone: false,
    pendingUntil: 0,
  };
  let overlay = null;

  sonarGetSettings().then((s) => (state.settings = s));
  chrome.storage.onChanged.addListener((changes) => {
    for (const k in changes) if (k in SONAR_DEFAULTS) state.settings[k] = changes[k].newValue;
  });

  /* ---------- utilidades ---------- */

  const $ = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const isShown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

  /** Repete `check` até retornar algo verdadeiro ou estourar o tempo (→ null). */
  function waitFor(check, timeout = 10000, interval = 60) {
    return new Promise((resolve) => {
      const end = Date.now() + timeout;
      (function tick() {
        let v = null;
        try {
          v = check();
        } catch (_) {}
        if (v || Date.now() >= end) resolve(v || null);
        else setTimeout(tick, interval);
      })();
    });
  }

  function isBlocked() {
    const el = $(SEL.blocked);
    return isShown(el) && el.textContent.trim() !== '';
  }

  function audioUrl() {
    const src = $(SEL.audioLink)?.href || $(SEL.audioSource)?.src;
    return src ? new URL(src, location.href).href : null;
  }

  const audioOpen = () => isShown($(SEL.audioInput)) && !!audioUrl();

  function humanClick(el) {
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      clientX: r.left + r.width * rand(0.3, 0.7),
      clientY: r.top + r.height * rand(0.3, 0.7),
    };
    const ptr = { ...base, pointerId: 1, isPrimary: true, pointerType: 'mouse' };
    el.dispatchEvent(new PointerEvent('pointerover', ptr));
    el.dispatchEvent(new MouseEvent('mouseover', base));
    el.dispatchEvent(new PointerEvent('pointerdown', ptr));
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    el.focus?.();
    el.dispatchEvent(new PointerEvent('pointerup', ptr));
    el.dispatchEvent(new MouseEvent('mouseup', base));
    el.click();
  }

  async function typeInto(input, text) {
    input.focus();
    input.value = '';
    if (state.settings.humanTyping) {
      for (const key of text) {
        const k = { key, bubbles: true, cancelable: true, composed: true };
        input.dispatchEvent(new KeyboardEvent('keydown', k));
        input.dispatchEvent(new KeyboardEvent('keypress', k));
        input.value += key;
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: key, inputType: 'insertText' }));
        input.dispatchEvent(new KeyboardEvent('keyup', k));
        await sleep(rand(20, 60));
      }
    } else {
      input.value = text;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ---------- botão no desafio ---------- */

  function injectButton() {
    const holder = $(SEL.buttons);
    if (!holder || holder.querySelector('#sonar-solver-button')) return;
    const wrap = document.createElement('div');
    wrap.className = 'button-holder sonar-button-holder';
    const btn = document.createElement('button');
    btn.id = 'sonar-solver-button';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Resolver com o Sonar (Alt+Shift+S). Botão direito abre as configurações.');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      solve();
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: 'openOptions' }).catch(() => {});
    });
    wrap.append(btn);
    holder.insertBefore(wrap, holder.querySelector(SEL.help)?.nextSibling || null);
  }

  /* ---------- tela do Sonar ---------- */

  function getOverlay() {
    overlay ??= SonarOverlay.create({
      theme: state.settings.theme,
      onRetry: () => solve(),
      onDismiss: () => {
        state.cancelled = true;
        overlay.hide();
      },
    });
    return overlay;
  }

  /* ---------- fluxo ---------- */

  class Cancelled extends Error {}

  /** Para se o usuário cancelou (Esc) ou fechou o desafio clicando fora. */
  function checkAlive() {
    if (state.cancelled || !state.visible) throw new Cancelled();
  }

  async function openAudioChallenge() {
    if (audioOpen()) return true;
    const btn = await waitFor(() => (isShown($(SEL.audioButton)) ? $(SEL.audioButton) : null), 5000);
    if (!btn) return false;
    humanClick(btn);
    await waitFor(() => audioOpen() || isBlocked(), 10000);
    return audioOpen() && !isBlocked();
  }

  async function transcribe(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`Não consegui baixar o áudio (HTTP ${res.status}).`);
    return sonarTranscribe(await sonarBlobToBase64(await res.blob()), state.settings);
  }

  /**
   * Depois de verificar:
   * - 'solved'  → o Google escondeu o desafio (só isso conta como resolvido);
   * - 'again'   → apareceu outro áudio (resposta errada ou "resolva mais");
   * - 'blocked' → bloqueio por excesso de tentativas;
   * - 'stuck'   → nada mudou; pede outro áudio.
   */
  async function outcome(prevUrl) {
    const r = await waitFor(
      () => {
        if (!state.visible) return 'solved';
        if (isBlocked()) return 'blocked';
        const u = audioUrl();
        return u && u !== prevUrl ? 'again' : null;
      },
      8000,
      60
    );
    return r || 'stuck';
  }

  async function reloadAudio(prevUrl) {
    const rb = $(SEL.reloadButton);
    if (!rb) return false;
    humanClick(rb);
    const ok = await waitFor(() => isBlocked() || (audioUrl() && audioUrl() !== prevUrl), 8000);
    return !!ok && !isBlocked();
  }

  async function solve() {
    if (state.solving || !state.visible) return;
    state.solving = true;
    state.cancelled = false;
    const t0 = performance.now();
    const ov = getOverlay();
    ov.reset();
    ov.show();

    const report = (result) =>
      chrome.runtime.sendMessage({ type: 'stat', result, ms: Math.round(performance.now() - t0) }).catch(() => {});
    const failBlocked = () => {
      ov.fail(
        'Áudio bloqueado pelo Google',
        'Muitas tentativas desta rede. Espere alguns minutos. Esc mostra o desafio.',
        { canRetry: false }
      );
      report('failed');
    };

    try {
      if (!state.settings.setupDone) {
        chrome.runtime.sendMessage({ type: 'openWelcome' }).catch(() => {});
        ov.fail(
          'Escolha um modelo de voz',
          'Abrimos a tela inicial do Sonar em outra aba. Depois de baixar, tente de novo.'
        );
        return;
      }
      // Duração esperada do "ouvir": maior se o modelo ainda não estiver aquecido.
      const prep = await chrome.runtime.sendMessage({ type: 'prepare' }).catch(() => null);
      ov.expect('listen', prep?.warm ? 1200 : prep?.ready ? 1800 : 3500);

      ov.step('open');
      if (isBlocked()) return failBlocked();
      const opened = await openAudioChallenge();
      checkAlive();
      if (!opened) {
        if (isBlocked()) return failBlocked();
        ov.fail('Desafio de áudio indisponível', 'O reCAPTCHA não abriu a opção de áudio.');
        return report('failed');
      }

      const max = Math.max(1, state.settings.maxAttempts | 0);
      for (let attempt = 1; attempt <= max; attempt++) {
        const url = audioUrl();
        ov.step('listen');
        const { text } = await transcribe(url);
        checkAlive();

        const input = $(SEL.audioInput);
        const verify = $(SEL.verifyButton);
        if (!text || !input || !verify) {
          if (!(await reloadAudio(url))) break;
          continue;
        }

        ov.step('type', { text });
        await typeInto(input, text);
        checkAlive();
        ov.step('verify', { text });
        await sleep(rand(60, 140));
        humanClick(verify);

        const res = await outcome(url);
        if (res === 'solved') {
          ov.success((performance.now() - t0) / 1000);
          report('solved');
          // O desafio já está escondido pelo Google; a tela sai depois sem ninguém ver o CAPTCHA.
          setTimeout(() => !state.solving && !state.visible && ov.hide(), 800);
          return;
        }
        if (res === 'blocked') return failBlocked();
        if (res === 'stuck' && !(await reloadAudio(url))) break;
        checkAlive();
      }

      if (isBlocked()) return failBlocked();
      ov.fail('Não deu desta vez', 'Os áudios estavam difíceis. Tente de novo.');
      report('failed');
    } catch (e) {
      if (e instanceof Cancelled) {
        ov.hide();
        return;
      }
      console.warn('[Sonar]', e);
      const msg = String(e?.message || e);
      ov.fail(
        'Algo deu errado',
        msg.includes('context invalidated') ? 'A extensão foi atualizada. Recarregue a página.' : msg
      );
      report('failed');
    } finally {
      state.solving = false;
    }
  }

  /* ---------- observadores ---------- */

  function onVisible() {
    sonarWarmup(state.settings); // garante o modelo pronto enquanto o desafio aparece
    if (Date.now() < state.pendingUntil) {
      state.pendingUntil = 0;
      setTimeout(solve, 120);
    } else {
      maybeAutoSolve();
    }
  }

  function maybeAutoSolve() {
    const { autoSolve, setupDone } = state.settings;
    if (!autoSolve || !setupDone || !state.visible || state.solving || state.autoDone) return;
    if (!$(SEL.audioButton) && !audioOpen()) return;
    state.autoDone = true;
    solve(); // a tela do Sonar cobre o desafio na hora
  }

  const io = new IntersectionObserver((entries) => {
    const now = entries.at(-1).isIntersecting;
    if (now === state.visible) return;
    state.visible = now;
    if (now) return onVisible();
    state.autoDone = false;
    if (!state.solving) overlay?.hide();
  });

  let observed = null;
  let scheduled = false;
  function onMutations() {
    scheduled = false;
    injectButton();
    const root = $('.rc-footer') || document.body;
    if (root && root !== observed) {
      if (observed) io.unobserve(observed);
      io.observe(root);
      observed = root;
    }
    maybeAutoSolve();
  }

  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(onMutations, 40); // agrupa rajadas de mutações (rAF pausa em iframes ocultos)
  }).observe(document.documentElement, { childList: true, subtree: true });
  onMutations();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'solveNow') return false;
    if (state.visible) solve();
    else state.pendingUntil = Date.now() + 8000; // a caixa vai ser marcada; resolve quando abrir
    return false;
  });
})();
