(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────
  const ACTIVE_LIMIT  = 100;
  const REVIEW_LIMIT  = 30;
  const MASTERY_THR   = 0.85;
  const MASTERY_WIN   = 20;
  const MIN_TRIALS    = 20;
  const DATA_BASE     = 'data/';

  // ── localStorage helpers ──────────────────────────────────────────────────
  function lsGet(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }

  function getTrials(packId) { return lsGet(`mp_trials_${packId}`, []); }
  function addTrial(packId, trial) {
    const t = getTrials(packId);
    t.push(trial);
    lsSet(`mp_trials_${packId}`, t);
  }

  function getState(packId) {
    return lsGet(`mp_state_${packId}`, {
      phase: 1, mastered: false, masteredAt: null, phaseAdvancedAt: null,
      sessionCount: 0, totalSeconds: 0, weekStart: weekStart(),
      lastSessionDate: null,
    });
  }
  function setState(packId, s) { lsSet(`mp_state_${packId}`, s); }

  function weekStart() {
    const d = new Date();
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.getFullYear(), d.getMonth(), diff).toISOString().slice(0, 10);
  }

  // ── Training algorithm ────────────────────────────────────────────────────
  function getEligibleItemIds(pack, phase) {
    if (phase === 1) {
      return pack.items
        .filter(item => item.words.some(w => w.type === 'synthetic' || w.type === 'mixed'))
        .map(item => item.id);
    }
    return pack.items.map(item => item.id);
  }

  function getItemAccuracies(packId, itemIds, mode) {
    const trials = getTrials(packId);
    const accs = {};
    for (const id of itemIds) {
      const matching = trials
        .filter(t => t.item_id === id && t.mode === mode)
        .slice(-MASTERY_WIN);
      if (matching.length === 0) {
        accs[id] = { accuracy: 0.5, total: 0, correct: 0 };
      } else {
        const correct = matching.filter(t => t.correct).length;
        accs[id] = { accuracy: correct / matching.length, total: matching.length, correct };
      }
    }
    return accs;
  }

  function checkMastery(accs) {
    const ids = Object.keys(accs);
    if (ids.length === 0) return false;
    return ids.every(id => accs[id].total >= MIN_TRIALS && accs[id].accuracy >= MASTERY_THR);
  }

  function getPackAccuracy(accs) {
    const items = Object.values(accs).filter(d => d.total > 0);
    if (items.length === 0) return 0;
    const c = items.reduce((s, d) => s + d.correct, 0);
    const t = items.reduce((s, d) => s + d.total, 0);
    return t > 0 ? c / t : 0;
  }

  function findEligibleSpeakers(item) {
    const wordIds = item.words.map(w => w.id);
    const speakerSets = item.words.map(w =>
      new Set(w.recordings.map(r => r.speaker).filter(Boolean))
    );
    if (speakerSets.length === 0) return [];
    let common = [...speakerSets[0]];
    for (let i = 1; i < speakerSets.length; i++) {
      common = common.filter(s => speakerSets[i].has(s));
    }
    return common;
  }

  function pickWeighted(ids, weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < ids.length; i++) {
      r -= weights[i];
      if (r <= 0) return ids[i];
    }
    return ids[ids.length - 1];
  }

  function randomChoice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ── App state ─────────────────────────────────────────────────────────────
  let packs = [];
  let packDataCache = {};
  let currentPack = null;
  let currentMode = null;
  let trialCount = 0;
  let sessionCorrect = 0;
  let sessionStart = null;
  let timerInterval = null;
  let currentAudio = null;
  let discMasteryShown = false;

  // ── DOM ───────────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const screenPacks = $('screen-packs');
  const screenMode  = $('screen-mode');
  const screenTrain = $('screen-train');

  // ── Init ──────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      const resp = await fetch(DATA_BASE + 'packs.json');
      if (!resp.ok) throw new Error('Could not load packs');
      packs = await resp.json();
      $('packs-loading').hidden = true;
      renderPackList();
    } catch (e) {
      $('packs-loading').hidden = true;
      $('packs-error').textContent = 'Could not load training packs. ' + e.message;
      $('packs-error').hidden = false;
    }

    $('done-home').addEventListener('click', () => showScreen('packs'));
  });

  // ── Screens ───────────────────────────────────────────────────────────────
  function showScreen(name) {
    screenPacks.hidden = name !== 'packs';
    screenMode.hidden  = name !== 'mode';
    screenTrain.hidden = name !== 'train';
    setBreadcrumb(name);
    if (name === 'packs') {
      if (timerInterval) clearInterval(timerInterval);
      renderPackList();
    }
  }

  function setBreadcrumb(screen) {
    const bc = $('breadcrumb');
    if (screen === 'packs') {
      bc.innerHTML = '<span>Training</span>';
    } else if (screen === 'mode' && currentPack) {
      bc.innerHTML = `<a href="#" class="bc-home">Training</a><span class="sep"></span><span>${currentPack.name}</span>`;
      bc.querySelector('.bc-home').addEventListener('click', e => { e.preventDefault(); showScreen('packs'); });
    } else if (screen === 'train' && currentPack) {
      const modeName = currentMode === 'discrimination' ? 'Discrimination' : 'Identification';
      bc.innerHTML = `<a href="#" class="bc-home">Training</a><span class="sep"></span><a href="#" class="bc-pack">${currentPack.name}</a><span class="sep"></span><span>${modeName}</span>`;
      bc.querySelector('.bc-home').addEventListener('click', e => { e.preventDefault(); showScreen('packs'); });
      bc.querySelector('.bc-pack').addEventListener('click', e => { e.preventDefault(); showModeScreen(currentPack); });
    }
  }

  // ── Pack list ─────────────────────────────────────────────────────────────
  function renderPackList() {
    const el = $('pack-list');
    el.innerHTML = '';
    if (packs.length === 0) {
      el.innerHTML = '<div class="card text-center" style="color:var(--text-muted); padding:2.5rem;">No packs available yet.</div>';
      return;
    }
    for (const p of packs) {
      const state = getState(p.id);
      const ws = weekStart();
      if (state.weekStart !== ws) {
        state.sessionCount = 0;
        state.totalSeconds = 0;
        state.weekStart = ws;
        setState(p.id, state);
      }

      const trials = getTrials(p.id).filter(t => t.mode === 'identification');
      const totalTrials = trials.length;
      const sessionTarget = state.mastered ? 1 : 2;

      const card = document.createElement('div');
      card.className = 'pack-card';
      card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
          <div>
            <strong style="font-size:1.1rem;">${p.name}</strong>
            ${p.description ? `<p class="text-muted mt-1" style="font-size:.9rem;">${p.description}</p>` : ''}
          </div>
          <span class="badge badge-blue">${p.itemCount} items</span>
        </div>
        <div class="mt-1 flex-row" style="gap:.5rem; flex-wrap:wrap;">
          ${state.mastered ? '<span class="badge badge-green">Mastered</span><span class="badge badge-outline">Review</span>' : '<span class="badge badge-outline">Active</span>'}
          ${totalTrials > 0 ? `<span class="badge badge-grey">${totalTrials} trials</span>` : ''}
        </div>
        <div class="schedule-display mt-1">
          <span class="schedule-label">This week:</span>
          <span class="schedule-dots">
            <span class="schedule-dot ${state.sessionCount >= 1 ? 'filled' : ''}"></span>
            ${!state.mastered ? `<span class="schedule-dot ${state.sessionCount >= 2 ? 'filled' : ''}"></span>` : ''}
          </span>
          <span style="font-size:.82rem; color:var(--text-muted);">${state.sessionCount} / ${sessionTarget} sessions</span>
        </div>
        <div style="margin-top:1rem; text-align:right;">
          <span class="btn btn-primary btn-sm">${state.mastered ? 'Start Review →' : 'Start Practising →'}</span>
        </div>`;
      card.addEventListener('click', () => loadPackAndShowMode(p));
      el.appendChild(card);
    }
  }

  async function loadPackAndShowMode(packMeta) {
    if (packDataCache[packMeta.id]) {
      currentPack = packDataCache[packMeta.id];
      showModeScreen(currentPack);
      return;
    }
    try {
      const resp = await fetch(DATA_BASE + packMeta.file);
      if (!resp.ok) throw new Error('Load failed');
      const data = await resp.json();
      packDataCache[data.id] = data;
      currentPack = data;
      showModeScreen(currentPack);
    } catch (e) {
      alert('Could not load pack: ' + e.message);
    }
  }

  // ── Mode selection ────────────────────────────────────────────────────────
  function showModeScreen(pack) {
    $('mode-pack-name').textContent = pack.name;
    const itemIds = pack.items.map(i => i.id);

    const discAccs = getItemAccuracies(pack.id, itemIds, 'discrimination');
    const identAccs = getItemAccuracies(pack.id, itemIds, 'identification');
    const discTrials = Object.values(discAccs).reduce((s, d) => s + d.total, 0);
    const identTrials = Object.values(identAccs).reduce((s, d) => s + d.total, 0);
    const discMastered = checkMastery(discAccs);
    const identState = getState(pack.id);

    const discStats = $('mode-disc-stats');
    if (discTrials > 0) {
      const pct = Math.round(getPackAccuracy(discAccs) * 100);
      discStats.innerHTML = `<span class="badge badge-blue">${pct}%</span><span class="badge badge-grey">${discTrials} trials</span>${discMastered ? '<span class="badge badge-green">Mastered</span>' : ''}`;
      discStats.hidden = false;
    } else {
      discStats.hidden = true;
    }

    const identStats = $('mode-ident-stats');
    if (identTrials > 0) {
      const pct = Math.round(getPackAccuracy(identAccs) * 100);
      identStats.innerHTML = `<span class="badge badge-blue">${pct}%</span><span class="badge badge-grey">${identTrials} trials</span>${identState.mastered ? '<span class="badge badge-green">Mastered</span>' : ''}`;
      identStats.hidden = false;
    } else {
      identStats.hidden = true;
    }

    $('mode-ident-hint').hidden = !(discMastered && !identState.mastered);

    $('mode-disc-card').onclick = () => startSession(pack, 'discrimination');
    $('mode-ident-card').onclick = () => startSession(pack, 'identification');

    showScreen('mode');
  }

  // ── Session ───────────────────────────────────────────────────────────────
  function startSession(pack, mode) {
    currentPack = pack;
    currentMode = mode;
    trialCount = 0;
    sessionCorrect = 0;
    sessionStart = Date.now();
    discMasteryShown = false;

    $('phase-label').textContent = mode === 'discrimination' ? 'Discrimination' : 'Identification';
    $('session-score').hidden = true;
    updateCounter();
    startTimer();

    showScreen('train');
    loadNextTrial();
  }

  function startTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      const el = Math.floor((Date.now() - sessionStart) / 1000);
      const m = Math.floor(el / 60);
      const s = el % 60;
      $('session-timer').textContent = `${m}:${s.toString().padStart(2, '0')}`;
    }, 1000);
  }

  function elapsedSeconds() { return sessionStart ? Math.floor((Date.now() - sessionStart) / 1000) : 0; }

  function updateCounter() {
    const state = getState(currentPack.id);
    const limit = state.mastered ? REVIEW_LIMIT : ACTIVE_LIMIT;
    $('trial-counter').textContent = `Trial ${trialCount} / ${limit}`;
  }

  function updateScore() {
    if (trialCount === 0) return;
    const pct = Math.round((sessionCorrect / trialCount) * 100);
    const el = $('session-score');
    el.textContent = `${pct}%`;
    el.hidden = false;
    el.className = 'session-score';
    if (pct >= 85) el.classList.add('score-high');
    else if (pct >= 65) el.classList.add('score-mid');
    else el.classList.add('score-low');
  }

  function endSession() {
    if (timerInterval) clearInterval(timerInterval);
    const state = getState(currentPack.id);
    const elapsed = elapsedSeconds();
    state.totalSeconds += elapsed;
    state.lastSessionDate = new Date().toISOString().slice(0, 10);
    if (elapsed >= 300) state.sessionCount++;
    setState(currentPack.id, state);
  }

  function showDone() {
    endSession();
    const el = $('done-summary');
    if (trialCount > 0) {
      const pct = Math.round((sessionCorrect / trialCount) * 100);
      const elapsed = elapsedSeconds();
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      el.innerHTML =
        `<div class="done-stat"><span class="done-stat-value">${pct}%</span><span class="done-stat-label">accuracy</span></div>` +
        `<div class="done-stat"><span class="done-stat-value">${sessionCorrect}/${trialCount}</span><span class="done-stat-label">correct</span></div>` +
        `<div class="done-stat"><span class="done-stat-value">${m}:${s.toString().padStart(2, '0')}</span><span class="done-stat-label">time</span></div>`;
      el.hidden = false;
    }
    setTrainPhase('done');
  }

  // ── Train phases ──────────────────────────────────────────────────────────
  function setTrainPhase(phase) {
    $('train-loading').hidden = phase !== 'loading';
    $('train-ident').hidden   = phase !== 'ident' && phase !== 'ident-feedback';
    $('train-compare').hidden = phase !== 'compare';
    $('train-disc').hidden    = phase !== 'disc' && phase !== 'disc-feedback';
    $('train-done').hidden    = phase !== 'done';
  }

  // ── Load next trial ───────────────────────────────────────────────────────
  function loadNextTrial() {
    setTrainPhase('loading');
    const state = getState(currentPack.id);
    const limit = state.mastered ? REVIEW_LIMIT : ACTIVE_LIMIT;

    if (trialCount >= limit) { showDone(); return; }

    let phase = state.phase;
    let itemIds = getEligibleItemIds(currentPack, phase);

    if (phase === 1 && itemIds.length === 0) {
      state.phase = 2;
      state.phaseAdvancedAt = new Date().toISOString();
      setState(currentPack.id, state);
      phase = 2;
      itemIds = getEligibleItemIds(currentPack, phase);
    }
    if (itemIds.length === 0) { showDone(); return; }

    const accs = getItemAccuracies(currentPack.id, itemIds, currentMode);
    const weights = itemIds.map(id => Math.max(0.05, 1 - (accs[id] || { accuracy: 0.5 }).accuracy));
    const chosenId = pickWeighted(itemIds, weights);
    const item = currentPack.items.find(i => i.id === chosenId);
    if (!item) { showDone(); return; }

    const speakers = findEligibleSpeakers(item);
    if (speakers.length === 0) { showDone(); return; }
    const speaker = randomChoice(speakers);

    if (currentMode === 'identification') {
      loadIdentTrial(item, speaker);
    } else {
      loadDiscTrial(item, speaker);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // IDENTIFICATION
  // ══════════════════════════════════════════════════════════════════════════

  let identTrial = null;
  let identAudioEnded = false;
  let identStartTime = null;

  function loadIdentTrial(item, speaker) {
    const stimWord = randomChoice(item.words);
    const recs = stimWord.recordings.filter(r => r.speaker === speaker);
    if (recs.length === 0) { showDone(); return; }
    const rec = randomChoice(recs);

    identTrial = { item, stimWord, rec, speaker };
    identAudioEnded = false;
    identStartTime = null;

    // Build choices
    const choices = $('ident-choices');
    choices.innerHTML = '';
    const fb = $('ident-feedback');
    fb.hidden = true; fb.className = 'feedback-banner';
    $('ident-accuracy').hidden = true;

    const shuffled = shuffle(item.words);
    for (const w of shuffled) {
      const btn = document.createElement('button');
      btn.className = 'choice-btn';
      btn.textContent = w.label;
      btn.dataset.wordId = w.id;
      btn.disabled = true;
      btn.addEventListener('click', () => submitIdentAnswer(w.id));
      choices.appendChild(btn);
    }

    setTrainPhase('ident');
    playIdentAudio(rec.url);
  }

  function playIdentAudio(url) {
    stopAudio();
    $('ident-audio-status').textContent = 'Playing…';
    $('ident-replay').disabled = true;
    const audio = new Audio(url);
    currentAudio = audio;
    audio.addEventListener('ended', () => {
      identAudioEnded = true;
      identStartTime = Date.now();
      $('ident-audio-status').textContent = '';
      $('ident-replay').disabled = false;
      $('ident-choices').querySelectorAll('.choice-btn').forEach(b => b.disabled = false);
    });
    audio.addEventListener('error', () => {
      $('ident-audio-status').textContent = 'Audio failed.';
      $('ident-replay').disabled = false;
      $('ident-choices').querySelectorAll('.choice-btn').forEach(b => b.disabled = false);
    });
    audio.play().catch(() => {
      $('ident-audio-status').textContent = 'Tap Replay to hear.';
      $('ident-replay').disabled = false;
    });
  }

  $('ident-replay')?.addEventListener('click', () => {
    if (!identTrial) return;
    playIdentAudio(identTrial.rec.url);
  });

  function submitIdentAnswer(wordId) {
    const responseTime = identStartTime ? Date.now() - identStartTime : null;
    const correct = wordId === identTrial.stimWord.id;

    // Disable choices
    $('ident-choices').querySelectorAll('.choice-btn').forEach(b => {
      b.disabled = true;
      const wid = parseInt(b.dataset.wordId, 10);
      if (wid === identTrial.stimWord.id) b.classList.add('correct');
      else if (wid === wordId && !correct) b.classList.add('wrong');
    });

    trialCount++;
    if (correct) sessionCorrect++;
    updateCounter();
    updateScore();

    addTrial(currentPack.id, {
      item_id: identTrial.item.id,
      stimulus_word_id: identTrial.stimWord.id,
      response_word_id: wordId,
      correct,
      mode: 'identification',
      ts: Date.now(),
    });

    // Feedback
    const fb = $('ident-feedback');
    fb.hidden = false;
    fb.textContent = correct ? '✓ Correct' : '✗ Incorrect';
    fb.classList.add(correct ? 'correct' : 'incorrect');

    // Item accuracy
    const accs = getItemAccuracies(currentPack.id, [identTrial.item.id], 'identification');
    const acc = accs[identTrial.item.id];
    showAccBadge($('ident-accuracy'), acc);

    // Check mastery
    checkIdentMastery();

    // Build comparison
    buildCompare(identTrial.item, identTrial.speaker);
    setTrainPhase('compare');
  }

  function buildCompare(item, speaker) {
    const grid = $('compare-grid');
    grid.innerHTML = '';
    let cAudio = null;

    for (const w of item.words) {
      const btn = document.createElement('button');
      btn.className = 'discrim-btn';
      const icon = document.createElement('span');
      icon.className = 'play-icon';
      icon.textContent = '▶';
      const label = document.createElement('span');
      label.textContent = w.label;
      btn.appendChild(icon);
      btn.appendChild(label);

      const rec = w.recordings.find(r => r.speaker === speaker) || w.recordings[0];
      if (!rec) { btn.disabled = true; icon.textContent = '—'; }
      else {
        btn.addEventListener('click', () => {
          if (cAudio) { cAudio.pause(); cAudio.src = ''; }
          grid.querySelectorAll('.discrim-btn').forEach(b => {
            b.classList.remove('playing');
            b.querySelector('.play-icon').textContent = '▶';
          });
          const a = new Audio(rec.url);
          cAudio = a;
          btn.classList.add('playing');
          icon.textContent = '■';
          a.addEventListener('ended', () => { btn.classList.remove('playing'); icon.textContent = '▶'; cAudio = null; });
          a.play().catch(() => {});
        });
      }
      grid.appendChild(btn);
    }

    $('compare-next').onclick = () => {
      if (identPendingMastery) {
        identPendingMastery = false;
        $('ident-mastery-modal').hidden = false;
        $('ident-mastery-continue').onclick = () => {
          $('ident-mastery-modal').hidden = true;
          loadNextTrial();
        };
        return;
      }
      loadNextTrial();
    };
  }

  let identPendingMastery = false;

  function checkIdentMastery() {
    const state = getState(currentPack.id);
    const itemIds = getEligibleItemIds(currentPack, state.phase);
    const accs = getItemAccuracies(currentPack.id, itemIds, 'identification');

    if (state.phase === 1 && checkMastery(accs)) {
      state.phase = 2;
      state.phaseAdvancedAt = new Date().toISOString();
      setState(currentPack.id, state);
    }

    if (!state.mastered) {
      const fullIds = getEligibleItemIds(currentPack, state.phase);
      const fullAccs = getItemAccuracies(currentPack.id, fullIds, 'identification');
      if (checkMastery(fullAccs)) {
        state.mastered = true;
        state.masteredAt = new Date().toISOString();
        setState(currentPack.id, state);
        identPendingMastery = true;
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DISCRIMINATION
  // ══════════════════════════════════════════════════════════════════════════

  let discTrial = null;
  let discStartTime = null;

  function loadDiscTrial(item, speaker) {
    const target = randomChoice(item.words);
    const options = shuffle(item.words.map(w => {
      const rec = w.recordings.find(r => r.speaker === speaker) || w.recordings[0];
      return { word: w, rec };
    }));

    if (options.some(o => !o.rec)) { showDone(); return; }

    discTrial = { item, target, options, speaker };
    discStartTime = null;

    $('disc-target').textContent = target.label;

    // Reset play buttons
    for (const key of ['a', 'b']) {
      const btn = $(`disc-play-${key}`);
      btn.className = 'disc-play-btn';
      btn.querySelector('.disc-play-icon').textContent = '▶';
      $(`disc-label-${key}`).hidden = true;
    }

    // Reset answer
    for (const key of ['a', 'b']) {
      const btn = $(`disc-ans-${key}`);
      btn.className = 'disc-answer-btn';
      btn.disabled = false;
    }
    $('disc-prompt').hidden = false;
    $('disc-feedback').hidden = true;
    $('disc-feedback').className = 'feedback-banner';
    $('disc-accuracy').hidden = true;
    $('disc-next').hidden = true;

    // Wire up play buttons
    $('disc-play-a').onclick = () => playDiscOption(0);
    $('disc-play-b').onclick = () => playDiscOption(1);
    $('disc-ans-a').onclick = () => submitDiscAnswer(0);
    $('disc-ans-b').onclick = () => submitDiscAnswer(1);
    $('disc-next').onclick = () => loadNextTrial();

    setTrainPhase('disc');
  }

  function playDiscOption(idx) {
    const opt = discTrial.options[idx];
    if (!opt || !opt.rec) return;
    stopAudio();

    for (const key of ['a', 'b']) {
      $(`disc-play-${key}`).classList.remove('playing');
      $(`disc-play-${key}`).querySelector('.disc-play-icon').textContent = '▶';
    }

    const btn = $(`disc-play-${idx === 0 ? 'a' : 'b'}`);
    const icon = btn.querySelector('.disc-play-icon');
    const audio = new Audio(opt.rec.url);
    currentAudio = audio;
    btn.classList.add('playing');
    icon.textContent = '■';
    audio.addEventListener('ended', () => { btn.classList.remove('playing'); icon.textContent = '▶'; currentAudio = null; });
    audio.play().catch(() => { btn.classList.remove('playing'); icon.textContent = '▶'; });

    if (!discStartTime) discStartTime = Date.now();
  }

  function submitDiscAnswer(idx) {
    const selected = discTrial.options[idx];
    const correct = selected.word.id === discTrial.target.id;
    const responseTime = discStartTime ? Date.now() - discStartTime : null;

    $('disc-ans-a').disabled = true;
    $('disc-ans-b').disabled = true;

    trialCount++;
    if (correct) sessionCorrect++;
    updateCounter();
    updateScore();

    addTrial(currentPack.id, {
      item_id: discTrial.item.id,
      stimulus_word_id: discTrial.target.id,
      response_word_id: selected.word.id,
      correct,
      mode: 'discrimination',
      ts: Date.now(),
    });

    // Reveal labels
    const correctIdx = discTrial.options.findIndex(o => o.word.id === discTrial.target.id);
    for (let i = 0; i < 2; i++) {
      const key = i === 0 ? 'a' : 'b';
      $(`disc-label-${key}`).textContent = discTrial.options[i].word.label;
      $(`disc-label-${key}`).hidden = false;
      if (i === correctIdx) $(`disc-play-${key}`).classList.add('correct-reveal');
    }

    const correctKey = correctIdx === 0 ? 'a' : 'b';
    $(`disc-ans-${correctKey}`).classList.add('correct');
    if (!correct) {
      const wrongKey = idx === 0 ? 'a' : 'b';
      $(`disc-ans-${wrongKey}`).classList.add('wrong');
    }

    const fb = $('disc-feedback');
    fb.hidden = false;
    fb.textContent = correct ? '✓ Correct' : '✗ Incorrect';
    fb.classList.add(correct ? 'correct' : 'incorrect');

    const accs = getItemAccuracies(currentPack.id, [discTrial.item.id], 'discrimination');
    showAccBadge($('disc-accuracy'), accs[discTrial.item.id]);

    $('disc-prompt').hidden = true;
    $('disc-next').hidden = false;

    // Check disc mastery
    const allIds = currentPack.items.map(i => i.id);
    const allAccs = getItemAccuracies(currentPack.id, allIds, 'discrimination');
    if (checkMastery(allAccs) && !discMasteryShown) {
      discMasteryShown = true;
      setTimeout(() => {
        $('disc-mastery-modal').hidden = false;
        $('disc-mastery-try-ident').onclick = () => {
          $('disc-mastery-modal').hidden = true;
          endSession();
          startSession(currentPack, 'identification');
        };
        $('disc-mastery-continue').onclick = () => {
          $('disc-mastery-modal').hidden = true;
          loadNextTrial();
        };
      }, 600);
    }

    setTrainPhase('disc-feedback');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function stopAudio() {
    if (currentAudio) { currentAudio.pause(); currentAudio.src = ''; currentAudio = null; }
  }

  function showAccBadge(el, acc) {
    if (!el || !acc || acc.total === 0) { if (el) el.hidden = true; return; }
    const pct = Math.round(acc.accuracy * 100);
    el.textContent = `This pair: ${pct}% (last ${acc.total} trials)`;
    el.hidden = false;
    el.className = 'item-accuracy';
    if (pct >= 85) el.classList.add('acc-high');
    else if (pct >= 65) el.classList.add('acc-mid');
    else el.classList.add('acc-low');
  }

})();
