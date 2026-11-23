/* Tela de boas-vindas: escolher o modelo → baixar → pronto. */
(async () => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const { icon } = UI;
  const MB = 1048576;

  const settings = await sonarGetSettings();
  UI.applyTheme(settings.theme);
  for (const n of $$('[data-icon]')) n.insertAdjacentHTML('afterbegin', icon(n.dataset.icon));

  const eq = $('#eq');
  UI.equalizer(eq, Math.max(32, Math.min(120, Math.floor(eq.clientWidth / 10) || 80)));

  let chosen = settings.localModel;
  const model = () => SONAR_MODELS.find((m) => m.id === chosen);

  /* ---------- Etapas ---------- */

  const ORDER = ['choose', 'download', 'done'];
  function go(step) {
    for (const s of $$('.step')) s.hidden = s.dataset.step !== step;
    const i = ORDER.indexOf(step);
    $$('.progress-steps li').forEach((li, j) => {
      li.classList.toggle('done', j < i);
      li.classList.toggle('active', j === i);
      if (j === i) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });
    eq.classList.toggle('idle', step === 'choose');
    eq.classList.toggle('fast', step === 'download');
  }

  /* ---------- 1. Escolher ---------- */

  const meter = (label, n) =>
    `<div class="meter"><span>${label}</span>${[1, 2, 3].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</div>`;

  async function renderModels() {
    const cache = await sonarModelCache();
    const root = $('#models');
    root.innerHTML = '';
    for (const m of SONAR_MODELS) {
      const cached = cache[m.id]?.complete;
      const card = UI.el('div', {
        class: 'model',
        role: 'radio',
        tabindex: '0',
        'aria-checked': String(m.id === chosen),
      });
      card.innerHTML = `
        <div class="model-head">
          <h3>${m.name}</h3>
          ${m.recommended ? '<span class="tag-recommended">Recomendado</span>' : ''}
        </div>
        <p>${m.note}</p>
        <div class="meters">${meter('Velocidade', m.speed)}${meter('Precisão', m.accuracy)}</div>
        <div class="model-foot">
          <span class="model-state" data-state="${cached ? 'cached' : 'none'}">${cached ? 'Já baixado' : `~${m.size} MB`}</span>
        </div>`;
      const pick = () => {
        chosen = m.id;
        for (const c of root.children) c.setAttribute('aria-checked', String(c === card));
        renderStart(cache);
      };
      card.addEventListener('click', pick);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pick();
        }
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          const next = e.key === 'ArrowRight' ? card.nextElementSibling : card.previousElementSibling;
          next?.focus();
          next?.click();
        }
      });
      root.append(card);
    }
    renderStart(cache);
  }

  function renderStart(cache) {
    const m = model();
    $('#start').textContent = cache[m.id]?.complete ? `Usar o ${m.name}` : `Baixar o ${m.name} (${m.size} MB)`;
  }

  /* ---------- 2. Baixar ---------- */

  const panel = $('.meter-panel');
  function setProgress(pct, text) {
    $('#dl-pct').textContent = pct;
    $('#dl-bar').style.width = `${pct}%`;
    if (text) $('#dl-bytes').textContent = text;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.target !== 'ui' || msg.type !== 'modelProgress' || msg.model !== chosen) return false;
    if (msg.status === 'progress') {
      const mb = (n) => (n / MB).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
      setProgress(msg.percent, `${mb(msg.loaded)} de ${mb(msg.total)} MB`);
    } else if (msg.status === 'ready') {
      $('#dl-title').textContent = 'Preparando o motor';
      setProgress(100, 'Aquecendo o modelo para o primeiro desafio sair rápido…');
    }
    return false;
  });

  async function download() {
    const m = model();
    go('download');
    panel.classList.remove('error');
    $('#dl-error').hidden = true;
    $('#dl-title').textContent = `Baixando o ${m.name}`;
    $('#dl-text').textContent = 'Isso acontece só uma vez. Pode deixar esta aba aberta enquanto termina.';
    setProgress(0, 'Conectando…');
    try {
      await sonarLoadModel(m.id, settings.localDevice);
      await chrome.storage.local.set({ localModel: m.id, setupDone: true });
      $('#done-text').textContent =
        `O modelo ${m.name} está instalado e pronto. Ele fica guardado no navegador, sem precisar baixar de novo.`;
      go('done');
    } catch (e) {
      panel.classList.add('error');
      $('#dl-title').textContent = 'O download parou';
      $('#dl-text').textContent = String(e?.message || e);
      $('#dl-error').hidden = false;
    }
  }

  $('#start').addEventListener('click', download);
  $('#retry').addEventListener('click', download);
  $('#back').addEventListener('click', () => {
    go('choose');
    renderModels();
  });

  /* ---------- 3. Pronto ---------- */

  for (const btn of $$('[data-switch]')) {
    const key = btn.dataset.switch;
    UI.switchControl(btn, { value: settings[key], onChange: (v) => chrome.storage.local.set({ [key]: v }) });
  }

  const shortcut = (await chrome.commands.getAll()).find((c) => c.name === 'solve')?.shortcut || '';
  $('[data-shortcut]').innerHTML = shortcut
    .split('+')
    .filter(Boolean)
    .map((k) => `<kbd>${k}</kbd>`)
    .join('');

  $('#finish').addEventListener('click', async () => {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) chrome.tabs.remove(tab.id);
  });
  $('#open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  go('choose');
  renderModels();
})();
