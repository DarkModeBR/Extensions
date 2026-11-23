/* Tela do Sonar que cobre o desafio do reCAPTCHA do início ao fim da resolução.
 * Fica em um Shadow DOM fechado: o CSS do Google não interfere e vice-versa. */
/* eslint-disable no-var */
var SonarOverlay = (() => {
  const STEPS = [
    { id: 'open', label: 'Abrir o desafio de áudio', title: 'Preparando o desafio', weight: 12, ms: 700 },
    { id: 'listen', label: 'Ouvir e entender o áudio', title: 'Ouvindo o áudio', weight: 58, ms: 1600 },
    { id: 'type', label: 'Digitar a resposta', title: 'Digitando a resposta', weight: 12, ms: 400 },
    { id: 'verify', label: 'Confirmar com o Google', title: 'Confirmando', weight: 18, ms: 1300 },
  ];

  let fontsRequested = false;
  function loadFonts() {
    if (fontsRequested) return;
    fontsRequested = true;
    for (const [family, file, weight] of [
      ['Sonar Display', 'bricolage.woff2', '200 800'],
      ['Sonar Text', 'onest.woff2', '100 900'],
    ]) {
      new FontFace(family, `url(${chrome.runtime.getURL(`assets/fonts/${file}`)})`, { weight })
        .load()
        .then((f) => document.fonts.add(f))
        .catch(() => {}); // sem a fonte, usa a do sistema
    }
  }

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }

.root {
  --frame: #ffffff;
  --card: linear-gradient(165deg, #1f2944 0%, #141b2e 55%, #10162a 100%);
  --edge: rgba(255, 255, 255, .07);
  --line: #2c3654; --text: #e8ecf6; --text-2: #a3adc8; --text-3: #6f7a99;
  --core: #1a2238; --signal: #f4b23e; --signal-ink: #2a1d05; --signal-wash: rgba(244, 178, 62, .14);
  --ok: #4fd1a5; --bad: #f2716b;
  position: fixed; inset: 0; z-index: 2147483647;
  padding: 6px;
  background: var(--frame);
  color: var(--text);
  font: 400 14px/1.45 'Sonar Text', 'Segoe UI', Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
  user-select: none;
  opacity: 0;
  transition: opacity .2s ease;
}
.root[data-theme='light'] {
  --card: linear-gradient(165deg, #ffffff 0%, #f3f6fc 100%);
  --edge: #dfe5f1;
  --line: #d5dceb; --text: #18203a; --text-2: #4a5677; --text-3: #7c87a6;
  --core: #ffffff; --signal-wash: rgba(244, 178, 62, .2);
  --ok: #1f9e74; --bad: #d24c46;
}
.root.show { opacity: 1; }

.card {
  position: relative;
  height: 100%;
  display: grid;
  grid-template-rows: auto 1fr auto;
  border-radius: 18px;
  border: 1px solid var(--edge);
  background: var(--card);
  box-shadow: 0 18px 40px -22px rgba(10, 14, 30, .6);
  overflow: hidden;
}
/* brilho âmbar suave atrás do sonar */
.card::before {
  content: ''; position: absolute; left: 50%; top: 38%; width: 340px; height: 340px;
  transform: translate(-50%, -50%);
  background: radial-gradient(circle, var(--signal-wash) 0%, transparent 62%);
  pointer-events: none;
  transition: opacity .4s;
}
.root[data-state='bad'] .card::before { opacity: 0; }

.top { position: relative; display: flex; align-items: center; gap: 9px; padding: 14px 16px 0; }
.mark { width: 24px; height: 24px; border-radius: 7px; background: #222b45; display: grid; place-items: center; }
.root[data-theme='light'] .mark { background: #18203a; }
.mark svg { width: 14px; height: 14px; }
.brand { font: 700 15px/1 'Sonar Display', 'Segoe UI', sans-serif; letter-spacing: -.01em; }

.center {
  position: relative; display: grid; place-items: center; align-content: center;
  gap: 14px; min-height: 0; padding: 6px 20px; text-align: center;
}

/* Sonar: anéis + barras */
.sonar { position: relative; width: 116px; height: 116px; display: grid; place-items: center; }
.ring {
  position: absolute; inset: 0; border-radius: 50%; border: 1.5px solid var(--signal); opacity: 0;
  animation: ping 2.4s cubic-bezier(.2, .7, .2, 1) infinite;
}
.ring:nth-child(2) { animation-delay: .8s; }
.ring:nth-child(3) { animation-delay: 1.6s; }
@keyframes ping { 0% { transform: scale(.6); opacity: .55; } 100% { transform: scale(1.45); opacity: 0; } }
.core {
  position: relative; width: 78px; height: 78px; border-radius: 50%;
  display: grid; place-items: center;
  background: var(--core); border: 1px solid var(--line);
  box-shadow: 0 12px 28px -14px rgba(0, 0, 0, .6);
  transition: background-color .3s, border-color .3s, transform .3s;
}
.bars { display: flex; align-items: center; gap: 4px; height: 34px; }
.bars i {
  width: 5px; height: 100%; border-radius: 3px; background: var(--signal);
  transform: scaleY(.3); animation: eq 1.1s ease-in-out infinite;
}
.bars i:nth-child(1) { animation-delay: -.2s; }
.bars i:nth-child(2) { animation-delay: -.55s; }
.bars i:nth-child(3) { animation-delay: -.1s; }
.bars i:nth-child(4) { animation-delay: -.75s; }
.bars i:nth-child(5) { animation-delay: -.4s; }
@keyframes eq { 0%, 100% { transform: scaleY(.25); } 50% { transform: scaleY(1); } }
.root[data-step='open'] .bars i, .root[data-step='verify'] .bars i { animation-duration: 1.8s; }
.root[data-step='listen'] .bars i { animation-duration: .7s; }
.root[data-step='listen'] .ring { animation-duration: 1.6s; }
.root[data-step='type'] .bars i { animation-duration: .35s; }

.glyph { position: absolute; inset: 0; display: none; place-items: center; }
.glyph svg { width: 34px; height: 34px; }
.glyph path { stroke-dasharray: 40; stroke-dashoffset: 40; animation: draw .45s .1s ease forwards; }
@keyframes draw { to { stroke-dashoffset: 0; } }
.root[data-state='ok'] .core { background: var(--ok); border-color: var(--ok); transform: scale(1.04); }
.root[data-state='bad'] .core { background: var(--bad); border-color: var(--bad); }
.root[data-state='ok'] .ring { border-color: var(--ok); }
.root[data-state='bad'] .ring,
.root[data-state='ok'] .bars,
.root[data-state='bad'] .bars { display: none; }
.root[data-state='ok'] .glyph-ok,
.root[data-state='bad'] .glyph-bad { display: grid; }

.title { margin: 2px 0 0; font: 650 20px/1.2 'Sonar Display', 'Segoe UI', sans-serif; letter-spacing: -.015em; }
.sub { margin: -8px 0 0; max-width: 290px; color: var(--text-2); font-size: 13px; }
.sub:empty, .answer:empty { display: none; }
.answer {
  max-width: 290px; padding: 5px 13px; border-radius: 999px;
  background: var(--signal-wash); color: var(--signal);
  font: 600 13px 'Sonar Text', 'Segoe UI', sans-serif;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.root[data-theme='light'] .answer { color: #9a6408; }

.steps { display: grid; gap: 7px; margin: 2px 0 0; padding: 0; list-style: none; text-align: left; }
.steps li { display: flex; align-items: center; gap: 10px; color: var(--text-3); font-size: 13px; transition: color .2s; }
.steps li::before {
  content: ''; flex: none; width: 16px; height: 16px; border-radius: 50%;
  border: 1.5px solid var(--line); background: transparent center / 10px no-repeat;
}
.steps li.active { color: var(--text); font-weight: 600; }
.steps li.active::before {
  border-color: var(--signal); background-color: var(--signal);
  box-shadow: 0 0 0 4px rgba(244, 178, 62, .18); animation: halo 1.1s ease-in-out infinite;
}
.steps li.done { color: var(--text-2); }
.steps li.done::before {
  border-color: var(--ok); background-color: var(--ok);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23121829' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3.5 8.5l3 3 6-7'/%3E%3C/svg%3E");
}
@keyframes halo { 50% { box-shadow: 0 0 0 7px rgba(244, 178, 62, 0); } }
.root[data-state] .steps { display: none; }

.retry {
  display: none; height: 38px; padding: 0 20px; border: 0; border-radius: 11px; cursor: pointer;
  background: var(--signal); color: var(--signal-ink);
  font: 600 13.5px 'Sonar Text', 'Segoe UI', sans-serif;
}
.retry:hover { background: #ffc65c; }
.retry:focus-visible { outline: 2px solid var(--signal); outline-offset: 3px; }
.root[data-state='bad'] .retry:not([hidden]) { display: inline-block; }

.foot { position: relative; display: flex; align-items: center; gap: 12px; padding: 0 18px 18px; }
.track { flex: 1; height: 6px; border-radius: 999px; background: var(--line); overflow: hidden; }
.fill { width: 0; height: 100%; border-radius: inherit; background: var(--signal); transition: background-color .3s; }
.root[data-state='ok'] .fill { background: var(--ok); }
.root[data-state='bad'] .fill { background: var(--bad); }
.pct { min-width: 38px; text-align: right; font: 650 13px 'Sonar Display', 'Segoe UI', sans-serif; font-variant-numeric: tabular-nums; }

@media (max-height: 430px) { .steps { display: none; } }
@media (max-height: 330px) {
  .sonar { width: 86px; height: 86px; }
  .core { width: 60px; height: 60px; }
  .bars { height: 26px; }
  .title { font-size: 17px; }
  .center { gap: 10px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before { animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
}
`;

  const MARK =
    '<svg viewBox="0 0 16 16" fill="none" stroke="#f4b23e" stroke-width="2" stroke-linecap="round"><path d="M2 7v2M5 4.5v7M8 2v12M11 5v6M14 7v2"/></svg>';

  const HTML = `
    <div class="root" role="dialog" aria-modal="true" aria-label="Sonar resolvendo o desafio">
      <div class="card">
        <div class="top"><span class="mark">${MARK}</span><span class="brand">Sonar</span></div>
        <div class="center">
          <div class="sonar" aria-hidden="true">
            <span class="ring"></span><span class="ring"></span><span class="ring"></span>
            <div class="core">
              <div class="bars"><i></i><i></i><i></i><i></i><i></i></div>
              <span class="glyph glyph-ok"><svg viewBox="0 0 24 24" fill="none" stroke="#121829" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>
              <span class="glyph glyph-bad"><svg viewBox="0 0 24 24" fill="none" stroke="#121829" stroke-width="3" stroke-linecap="round"><path d="M12 6v8M12 18v.5"/></svg></span>
            </div>
          </div>
          <p class="title" aria-live="polite"></p>
          <p class="sub"></p>
          <span class="answer"></span>
          <ol class="steps">${STEPS.map((s) => `<li>${s.label}</li>`).join('')}</ol>
          <button class="retry" type="button">Tentar de novo</button>
        </div>
        <div class="foot">
          <div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="fill"></div></div>
          <span class="pct">0%</span>
        </div>
      </div>
    </div>`;

  /**
   * @param {{ theme?: string, onRetry?: () => void, onDismiss?: () => void }} opts
   * onDismiss: tecla Esc (saída de emergência, sem botão na tela).
   */
  function create({ theme = 'auto', onRetry, onDismiss } = {}) {
    loadFonts();
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>${CSS}</style>${HTML}`;

    const q = (s) => shadow.querySelector(s);
    const root = q('.root');
    const fill = q('.fill');
    const track = q('.track');
    const pct = q('.pct');
    const title = q('.title');
    const sub = q('.sub');
    const answer = q('.answer');
    const retry = q('.retry');
    const items = [...shadow.querySelectorAll('.steps li')];

    root.dataset.theme =
      theme === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme;
    retry.addEventListener('click', () => onRetry?.());
    root.addEventListener('pointerdown', (e) => e.stopPropagation()); // nada chega ao desafio por baixo
    const onKey = (e) => {
      if (e.key === 'Escape' && host.isConnected) onDismiss?.();
    };

    const durations = Object.fromEntries(STEPS.map((s) => [s.id, s.ms]));
    let current = -1;
    let stepStart = 0;
    let shown = 0;
    let final = null; // valor fixo ao concluir ou falhar
    let raf = 0;

    // Progresso: avança dentro da etapa atual de forma assintótica (nunca "trava" em 100%).
    function target() {
      if (final != null) return final;
      if (current < 0) return 0;
      const base = STEPS.slice(0, current).reduce((a, s) => a + s.weight, 0);
      const s = STEPS[current];
      const f = Math.min(0.94, 1 - Math.exp((-1.3 * (performance.now() - stepStart)) / durations[s.id]));
      return base + s.weight * f;
    }

    function frame() {
      const t = target();
      shown += (t - shown) * 0.12;
      if (Math.abs(t - shown) < 0.05) shown = t;
      const p = Math.round(shown);
      fill.style.width = `${shown}%`;
      pct.textContent = `${p}%`;
      track.setAttribute('aria-valuenow', String(p));
      raf = requestAnimationFrame(frame);
    }

    function setState(state) {
      if (state) root.dataset.state = state;
      else delete root.dataset.state;
    }

    return {
      get visible() {
        return host.isConnected;
      },
      show() {
        if (!host.isConnected) {
          document.documentElement.append(host);
          window.addEventListener('keydown', onKey, true);
        }
        requestAnimationFrame(() => root.classList.add('show'));
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(frame);
      },
      hide() {
        cancelAnimationFrame(raf);
        window.removeEventListener('keydown', onKey, true);
        root.classList.remove('show');
        setTimeout(() => {
          if (!root.classList.contains('show')) host.remove();
        }, 220);
      },
      reset() {
        final = null;
        current = -1;
        shown = 0;
        setState('');
        delete root.dataset.step;
        title.textContent = '';
        sub.textContent = '';
        answer.textContent = '';
      },
      /** Ajusta a duração esperada de uma etapa (ex.: modelo ainda carregando). */
      expect(id, ms) {
        durations[id] = ms;
      },
      step(id, { text } = {}) {
        final = null;
        setState('');
        current = STEPS.findIndex((s) => s.id === id);
        stepStart = performance.now();
        root.dataset.step = id;
        title.textContent = STEPS[current].title;
        sub.textContent = '';
        answer.textContent = text ? `“${text}”` : '';
        items.forEach((li, i) => {
          li.classList.toggle('done', i < current);
          li.classList.toggle('active', i === current);
        });
      },
      success(seconds) {
        final = 100;
        setState('ok');
        delete root.dataset.step;
        title.textContent = 'Desafio resolvido';
        sub.textContent = `em ${seconds.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`;
      },
      fail(heading, message, { canRetry = true } = {}) {
        final = Math.max(shown, 8);
        setState('bad');
        delete root.dataset.step;
        title.textContent = heading;
        sub.textContent = message;
        answer.textContent = '';
        retry.hidden = !canRetry;
        if (canRetry) retry.focus({ preventScroll: true });
      },
    };
  }

  return { create };
})();
