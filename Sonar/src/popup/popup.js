/* Menu do ícone da extensão. */
(async () => {
  const $ = (s) => document.querySelector(s);
  const settings = await sonarGetSettings();
  UI.applyTheme(settings.theme);
  UI.equalizer($('#eq'), 30);

  for (const btn of document.querySelectorAll('[data-switch]')) {
    const key = btn.dataset.switch;
    UI.switchControl(btn, { value: settings[key], onChange: (v) => chrome.storage.local.set({ [key]: v }) });
  }

  // Estatísticas
  const { stats = {} } = await chrome.storage.local.get('stats');
  const solved = stats.solved || 0;
  const total = solved + (stats.failed || 0);
  $('#solved').textContent = solved.toLocaleString('pt-BR');
  $('#rate').textContent = total ? `${Math.round((solved / total) * 100)}%` : '—';
  $('#avg').textContent = solved ? UI.secs(stats.totalMs / solved) : '—';

  // Estado do motor
  const st = await chrome.runtime.sendMessage({ type: 'status' }).catch(() => null);
  const name = `Whisper ${SONAR_MODELS.find((m) => m.id === settings.localModel)?.name || ''}`.trim();
  const ready = st?.ready && st.model === settings.localModel;
  const pill = $('#pill');
  pill.dataset.state = ready ? 'ready' : 'idle';
  pill.textContent = ready ? `${name} pronto` : `${name} em espera`;
  $('#eq').classList.toggle('idle', !ready && !settings.autoSolve);

  // Atalho
  const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'solve');
  $('#keys').innerHTML = (cmd?.shortcut || '')
    .split('+')
    .filter(Boolean)
    .map((k) => `<kbd>${k}</kbd>`)
    .join('');

  // Sem modelo baixado, o botão principal leva para a tela de boas-vindas.
  if (!settings.setupDone) {
    pill.dataset.state = 'error';
    pill.textContent = 'Nenhum modelo baixado';
    $('#solve').innerHTML = '<span>Escolher e baixar o modelo</span>';
  }
  $('#solve').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: settings.setupDone ? 'solveActiveTab' : 'openWelcome' });
    window.close();
  });

  $('#open-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
})();
