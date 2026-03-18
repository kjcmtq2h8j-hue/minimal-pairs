/**
 * train.js — End User training session controller
 *
 * Expects PACK_ID, INITIAL_PHASE, INITIAL_MASTERED, and INITIAL_TRIAL_LIMIT
 * to be defined in the page.
 *
 * Training algorithm: accuracy-weighted item selection with hard stop.
 * - Active training: 100 trials per session
 * - Review mode: 30 trials per session
 * - No SRS intervals — items are weighted by recent accuracy
 */

(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────
  const state = {
    phase:       'loading',   // loading | presenting | answering | submitting | discrimination | done
    trial:       null,        // current trial data from API
    audioEl:     null,        // current Audio element
    audioEnded:  false,
    startTime:   null,        // when timer begins (audio end)
    feedbackData: null,       // result from submit API
    currentPhase: typeof INITIAL_PHASE !== 'undefined' ? INITIAL_PHASE : 1,
    sessionStartTime: null,   // when the session started
    sessionTimerInterval: null,
    sessionEnded: false,       // whether end-session was sent
    trialNumber: 0,
    trialLimit: typeof INITIAL_TRIAL_LIMIT !== 'undefined' ? INITIAL_TRIAL_LIMIT : 100,
    mastered: typeof INITIAL_MASTERED !== 'undefined' ? INITIAL_MASTERED : false,
    sessionCorrect: 0,
    sessionTotal: 0,
  };

  // ── DOM ───────────────────────────────────────────────────────────────────
  const shell           = document.getElementById('train-shell');
  const loadingDiv      = document.getElementById('phase-loading');
  const presentDiv      = document.getElementById('phase-present');
  const discrimDiv      = document.getElementById('phase-discrim');
  const doneDiv         = document.getElementById('phase-done');
  const doneSummary     = document.getElementById('done-summary');
  const advanceModal    = document.getElementById('phase-advance-modal');
  const masteryModal    = document.getElementById('mastery-modal');

  const audioStatus     = document.getElementById('audio-status');
  const replayBtn       = document.getElementById('replay-btn');
  const choicesDiv      = document.getElementById('choices');
  const feedbackBanner  = document.getElementById('feedback-banner');

  const discrimGrid     = document.getElementById('discrim-grid');
  const nextBtn         = document.getElementById('next-btn');

  const phaseLabel      = document.getElementById('phase-label');
  const sessionTimer    = document.getElementById('session-timer');
  const trialCounter    = document.getElementById('trial-counter');
  const sessionScore    = document.getElementById('session-score');
  const itemAccuracy    = document.getElementById('item-accuracy');

  const advanceTitle    = document.getElementById('advance-title');
  const advanceMessage  = document.getElementById('advance-message');
  const advanceContinue = document.getElementById('advance-continue-btn');
  const masteryContinue = document.getElementById('mastery-continue-btn');

  // ── Phase display names ─────────────────────────────────────────────────
  const PHASE_NAMES = { 1: 'Synthetic', 2: 'All pairs' };

  function updatePhaseDisplay(phase) {
    state.currentPhase = phase;
    if (phaseLabel) phaseLabel.textContent = PHASE_NAMES[phase] || 'All pairs';
  }

  function updateTrialCounter() {
    if (trialCounter) {
      trialCounter.textContent = `Trial ${state.trialNumber} / ${state.trialLimit}`;
    }
  }

  function updateSessionScore(correct, total) {
    if (!sessionScore || total === 0) return;
    const pct = Math.round((correct / total) * 100);
    sessionScore.textContent = `${pct}%`;
    sessionScore.hidden = false;
    sessionScore.className = 'session-score';
    if (pct >= 85) sessionScore.classList.add('score-high');
    else if (pct >= 65) sessionScore.classList.add('score-mid');
    else sessionScore.classList.add('score-low');
  }

  function showDoneSummary() {
    if (!doneSummary || state.sessionTotal === 0) return;
    const pct = Math.round((state.sessionCorrect / state.sessionTotal) * 100);
    const elapsed = getElapsedSeconds();
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    doneSummary.innerHTML =
      `<div class="done-stat"><span class="done-stat-value">${pct}%</span><span class="done-stat-label">accuracy</span></div>` +
      `<div class="done-stat"><span class="done-stat-value">${state.sessionCorrect}/${state.sessionTotal}</span><span class="done-stat-label">correct</span></div>` +
      `<div class="done-stat"><span class="done-stat-value">${min}:${sec.toString().padStart(2, '0')}</span><span class="done-stat-label">time</span></div>`;
    doneSummary.hidden = false;
  }

  function showItemAccuracy(acc, trials) {
    if (!itemAccuracy) return;
    if (acc === null || acc === undefined) {
      itemAccuracy.hidden = true;
      return;
    }
    itemAccuracy.textContent = `This pair: ${acc}% (last ${trials} trials)`;
    itemAccuracy.hidden = false;
    itemAccuracy.className = 'item-accuracy';
    if (acc >= 85) itemAccuracy.classList.add('acc-high');
    else if (acc >= 65) itemAccuracy.classList.add('acc-mid');
    else itemAccuracy.classList.add('acc-low');
  }

  // ── Session timer ───────────────────────────────────────────────────────
  function startSessionTimer() {
    state.sessionStartTime = Date.now();
    state.sessionTimerInterval = setInterval(updateTimerDisplay, 1000);
    updateTimerDisplay();
  }

  function updateTimerDisplay() {
    if (!state.sessionStartTime || !sessionTimer) return;
    const elapsed = Math.floor((Date.now() - state.sessionStartTime) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    sessionTimer.textContent = `${min}:${sec.toString().padStart(2, '0')}`;
  }

  function getElapsedSeconds() {
    if (!state.sessionStartTime) return 0;
    return Math.floor((Date.now() - state.sessionStartTime) / 1000);
  }

  async function endSession() {
    if (state.sessionEnded) return;
    state.sessionEnded = true;
    try {
      await fetch('/api/end-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pack_id: PACK_ID,
          elapsed_seconds: getElapsedSeconds(),
        }),
      });
    } catch (e) { /* best effort */ }
  }

  // ── Entry point ─────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    if (typeof PACK_ID === 'undefined') return;
    replayBtn.addEventListener('click', () => replayAudio());
    nextBtn.addEventListener('click', () => afterDiscrimination());
    if (advanceContinue) {
      advanceContinue.addEventListener('click', () => {
        advanceModal.hidden = true;
        loadTrial();
      });
    }
    if (masteryContinue) {
      masteryContinue.addEventListener('click', () => {
        masteryModal.hidden = true;
        loadTrial();
      });
    }
    // Send end-session when user navigates away
    window.addEventListener('beforeunload', () => {
      if (state.sessionStartTime && !state.sessionEnded) {
        navigator.sendBeacon('/api/end-session',
          new Blob([JSON.stringify({
            pack_id: PACK_ID,
            elapsed_seconds: getElapsedSeconds(),
          })], { type: 'application/json' }));
      }
    });
    updateTrialCounter();
    startSessionTimer();
    loadTrial();
  });

  // ── Load next trial ─────────────────────────────────────────────────────
  function loadTrial() {
    setPhase('loading');
    fetch(`/api/trial/${PACK_ID}`)
      .then(r => r.json())
      .then(data => {
        if (data.done) {
          state.trialNumber = data.trial_number || state.trialNumber;
          state.trialLimit = data.trial_limit || state.trialLimit;
          updateTrialCounter();
          showDoneSummary();
          endSession();
          setPhase('done');
          return;
        }
        state.trial      = data;
        state.audioEnded = false;
        state.startTime  = null;
        state.trialNumber = data.trial_number || state.trialNumber;
        state.trialLimit = data.trial_limit || state.trialLimit;
        if (data.mastered !== undefined) state.mastered = data.mastered;
        if (data.phase) updatePhaseDisplay(data.phase);
        updateTrialCounter();
        buildChoiceButtons();
        setPhase('presenting');
        playAudio();
      })
      .catch(() => {
        showError('Could not load next trial. Please refresh the page.');
      });
  }

  // ── Audio ───────────────────────────────────────────────────────────────
  function playAudio() {
    if (state.audioEl) {
      state.audioEl.pause();
      state.audioEl.src = '';
    }
    const el = new Audio(state.trial.recording_url);
    state.audioEl = el;

    setAudioStatus('Playing…');
    replayBtn.disabled = true;

    el.addEventListener('ended', () => {
      state.audioEnded = true;
      state.startTime  = Date.now();
      setAudioStatus('');
      replayBtn.disabled = false;
      enableChoices();
    });

    el.addEventListener('error', () => {
      setAudioStatus('Audio failed to load.');
      replayBtn.disabled = false;
      enableChoices();
    });

    el.play().catch(() => {
      setAudioStatus('Tap Replay to hear the word.');
      replayBtn.disabled = false;
    });
  }

  function replayAudio() {
    if (!state.trial) return;
    setAudioStatus('Playing…');
    replayBtn.disabled = true;
    const el = new Audio(state.trial.recording_url);
    state.audioEl = el;
    el.addEventListener('ended', () => {
      setAudioStatus('');
      replayBtn.disabled = false;
      if (!state.audioEnded) {
        state.audioEnded = true;
        state.startTime  = Date.now();
        enableChoices();
      }
    });
    el.play().catch(() => {
      setAudioStatus('');
      replayBtn.disabled = false;
    });
  }

  function setAudioStatus(msg) {
    if (audioStatus) audioStatus.textContent = msg;
  }

  // ── Choices ─────────────────────────────────────────────────────────────
  function buildChoiceButtons() {
    choicesDiv.innerHTML = '';
    feedbackBanner.hidden = true;
    feedbackBanner.className = 'feedback-banner';
    if (itemAccuracy) itemAccuracy.hidden = true;

    for (const ch of state.trial.choices) {
      const btn = document.createElement('button');
      btn.className          = 'choice-btn';
      btn.textContent        = ch.label;
      btn.dataset.wordId     = ch.word_id;
      btn.disabled           = true;
      btn.addEventListener('click', () => submitAnswer(ch.word_id));
      choicesDiv.appendChild(btn);
    }
  }

  function enableChoices() {
    choicesDiv.querySelectorAll('.choice-btn').forEach(b => b.disabled = false);
  }

  function disableChoices() {
    choicesDiv.querySelectorAll('.choice-btn').forEach(b => b.disabled = true);
  }

  // ── Submit answer ───────────────────────────────────────────────────────
  function submitAnswer(wordId) {
    if (state.phase !== 'presenting' && state.phase !== 'answering') return;
    const responseTime = state.startTime ? Date.now() - state.startTime : null;
    disableChoices();
    setPhase('submitting');

    fetch('/api/trial', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        item_id:          state.trial.item_id,
        stimulus_word_id: state.trial.stimulus_word_id,
        recording_id:     state.trial.recording_id,
        response_word_id: wordId,
        response_time_ms: responseTime,
      }),
    })
      .then(r => r.json())
      .then(result => {
        state.feedbackData = result;
        if (result.phase) updatePhaseDisplay(result.phase);
        if (result.trial_number) state.trialNumber = result.trial_number;
        if (result.trial_limit) state.trialLimit = result.trial_limit;
        updateTrialCounter();
        if (result.session_correct !== undefined) {
          state.sessionCorrect = result.session_correct;
          state.sessionTotal = result.session_total;
          updateSessionScore(result.session_correct, result.session_total);
        }
        showFeedback(wordId, result);
        showItemAccuracy(result.item_accuracy, result.item_accuracy_trials);
        buildDiscrimination(result.discrimination);

        // Check for phase advancement or mastery
        state.pendingAdvancement = result.phase_advanced ? result : null;
        state.pendingMastery = result.pack_mastered ? true : false;

        setPhase('discrimination');
      })
      .catch(() => showError('Could not submit answer. Please refresh.'));
  }

  // ── Feedback ────────────────────────────────────────────────────────────
  function showFeedback(respondedId, result) {
    choicesDiv.querySelectorAll('.choice-btn').forEach(btn => {
      const wid = parseInt(btn.dataset.wordId, 10);
      if (wid === result.stimulus_word_id) {
        btn.classList.add('correct');
      } else if (wid === respondedId && !result.correct) {
        btn.classList.add('wrong');
      }
    });

    feedbackBanner.hidden = false;
    if (result.correct) {
      feedbackBanner.textContent = '✓ Correct';
      feedbackBanner.classList.add('correct');
    } else {
      feedbackBanner.textContent = '✗ Incorrect';
      feedbackBanner.classList.add('incorrect');
    }
  }

  // ── After discrimination → check advancement/mastery then load next ────
  function afterDiscrimination() {
    // Phase advancement modal
    if (state.pendingAdvancement) {
      const adv = state.pendingAdvancement;
      state.pendingAdvancement = null;
      showAdvancementModal(adv.new_phase);
      return;
    }

    // Mastery modal
    if (state.pendingMastery) {
      state.pendingMastery = false;
      showMasteryModal();
      return;
    }

    loadTrial();
  }

  function showAdvancementModal(newPhase) {
    if (!advanceModal) { loadTrial(); return; }
    const msg = 'You\'ve mastered the synthetic pairs! All pairs are now in the mix.';
    if (advanceTitle) advanceTitle.textContent = 'Level up!';
    if (advanceMessage) advanceMessage.textContent = msg;
    advanceModal.hidden = false;
  }

  function showMasteryModal() {
    if (!masteryModal) { loadTrial(); return; }
    masteryModal.hidden = false;
  }

  // ── Discrimination phase ────────────────────────────────────────────────
  function buildDiscrimination(items) {
    discrimGrid.innerHTML = '';
    let currentDiscrimAudio = null;

    for (const item of items) {
      const btn = document.createElement('button');
      btn.className = 'discrim-btn';

      const playIcon = document.createElement('span');
      playIcon.className   = 'play-icon';
      playIcon.textContent = '▶';

      const label = document.createElement('span');
      label.textContent = item.label;

      btn.appendChild(playIcon);
      btn.appendChild(label);

      if (!item.recording_url) {
        btn.disabled = true;
        playIcon.textContent = '—';
      } else {
        btn.addEventListener('click', () => {
          if (currentDiscrimAudio) {
            currentDiscrimAudio.pause();
            currentDiscrimAudio.src = '';
            discrimGrid.querySelectorAll('.discrim-btn').forEach(b => {
              b.classList.remove('playing');
              const icon = b.querySelector('.play-icon');
              if (icon) icon.textContent = '▶';
            });
          }
          const audio = new Audio(item.recording_url);
          currentDiscrimAudio = audio;
          btn.classList.add('playing');
          playIcon.textContent = '■';
          audio.addEventListener('ended', () => {
            btn.classList.remove('playing');
            playIcon.textContent = '▶';
            currentDiscrimAudio = null;
          });
          audio.play().catch(() => {});
        });
      }

      discrimGrid.appendChild(btn);
    }
  }

  // ── Phase transitions ───────────────────────────────────────────────────
  function setPhase(phase) {
    state.phase = phase;

    loadingDiv.hidden       = (phase !== 'loading');
    presentDiv.hidden       = (phase !== 'presenting' && phase !== 'answering' && phase !== 'submitting' && phase !== 'discrimination');
    discrimDiv.hidden       = (phase !== 'discrimination');
    doneDiv.hidden          = (phase !== 'done');

    if (phase === 'discrimination') {
      replayBtn.disabled = true;
    }
  }

  // ── Error ───────────────────────────────────────────────────────────────
  function showError(msg) {
    loadingDiv.innerHTML = `<p class="loading-msg" style="color:var(--red)">${msg}</p>`;
    setPhase('loading');
  }

})();
