(function () {
  'use strict';

  const IS_DISC = typeof TRAINING_MODE !== 'undefined' && TRAINING_MODE === 'discrimination';

  // ── State ─────────────────────────────────────────────────────────────────
  const state = {
    phase:       'loading',
    trial:       null,
    audioEl:     null,
    audioEnded:  false,
    startTime:   null,
    feedbackData: null,
    currentPhase: typeof INITIAL_PHASE !== 'undefined' ? INITIAL_PHASE : 1,
    sessionStartTime: null,
    sessionTimerInterval: null,
    sessionEnded: false,
    trialNumber: 0,
    trialLimit: typeof INITIAL_TRIAL_LIMIT !== 'undefined' ? INITIAL_TRIAL_LIMIT : 100,
    mastered: typeof INITIAL_MASTERED !== 'undefined' ? INITIAL_MASTERED : false,
    sessionCorrect: 0,
    sessionTotal: 0,
    // Discrimination-specific
    discTrial: null,
    discPlayed: { a: false, b: false },
    discMasteryShown: false,
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

  // Discrimination mode DOM
  const discTrialDiv    = document.getElementById('phase-disc-trial');
  const discTargetWord  = document.getElementById('disc-target-word');
  const discPlayA       = document.getElementById('disc-play-a');
  const discPlayB       = document.getElementById('disc-play-b');
  const discLabelA      = document.getElementById('disc-label-a');
  const discLabelB      = document.getElementById('disc-label-b');
  const discAnswerPrompt = document.getElementById('disc-answer-prompt');
  const discAnswerA     = document.getElementById('disc-answer-a');
  const discAnswerB     = document.getElementById('disc-answer-b');
  const discFeedback    = document.getElementById('disc-feedback');
  const discAccuracy    = document.getElementById('disc-accuracy');
  const discNextBtn     = document.getElementById('disc-next-btn');
  const discMasteryModal = document.getElementById('disc-mastery-modal');
  const discMasteryContinue = document.getElementById('disc-mastery-continue');

  // ── Phase display names ─────────────────────────────────────────────────
  const PHASE_NAMES = { 1: 'Synthetic', 2: 'All pairs' };

  function updatePhaseDisplay(phase) {
    state.currentPhase = phase;
    if (phaseLabel) {
      if (IS_DISC) {
        phaseLabel.textContent = 'Discrimination';
      } else {
        phaseLabel.textContent = PHASE_NAMES[phase] || 'All pairs';
      }
    }
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

  function showItemAccuracyBadge(el, acc, trials) {
    if (!el) return;
    if (acc === null || acc === undefined) { el.hidden = true; return; }
    el.textContent = `This pair: ${acc}% (last ${trials} trials)`;
    el.hidden = false;
    el.className = 'item-accuracy';
    if (acc >= 85) el.classList.add('acc-high');
    else if (acc >= 65) el.classList.add('acc-mid');
    else el.classList.add('acc-low');
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

    if (!IS_DISC) {
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
    } else {
      // Discrimination mode listeners
      if (discPlayA) discPlayA.addEventListener('click', () => playDiscOption(0));
      if (discPlayB) discPlayB.addEventListener('click', () => playDiscOption(1));
      if (discAnswerA) discAnswerA.addEventListener('click', () => submitDiscAnswer(0));
      if (discAnswerB) discAnswerB.addEventListener('click', () => submitDiscAnswer(1));
      if (discNextBtn) discNextBtn.addEventListener('click', () => loadTrial());
      if (discMasteryContinue) {
        discMasteryContinue.addEventListener('click', () => {
          discMasteryModal.hidden = true;
          loadTrial();
        });
      }
    }

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
    const url = IS_DISC
      ? `/api/discrimination-trial/${PACK_ID}`
      : `/api/trial/${PACK_ID}`;

    fetch(url)
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

        if (IS_DISC) {
          loadDiscriminationTrial(data);
        } else {
          loadIdentificationTrial(data);
        }
      })
      .catch(() => {
        showError('Could not load next trial. Please refresh the page.');
      });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // IDENTIFICATION MODE
  // ══════════════════════════════════════════════════════════════════════════

  function loadIdentificationTrial(data) {
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
  }

  function playAudio() {
    if (state.audioEl) { state.audioEl.pause(); state.audioEl.src = ''; }
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
    el.play().catch(() => { setAudioStatus(''); replayBtn.disabled = false; });
  }

  function setAudioStatus(msg) {
    if (audioStatus) audioStatus.textContent = msg;
  }

  function buildChoiceButtons() {
    choicesDiv.innerHTML = '';
    feedbackBanner.hidden = true;
    feedbackBanner.className = 'feedback-banner';
    if (itemAccuracy) itemAccuracy.hidden = true;
    for (const ch of state.trial.choices) {
      const btn = document.createElement('button');
      btn.className      = 'choice-btn';
      btn.textContent    = ch.label;
      btn.dataset.wordId = ch.word_id;
      btn.disabled       = true;
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
        showItemAccuracyBadge(itemAccuracy, result.item_accuracy, result.item_accuracy_trials);
        buildIdentDiscrimination(result.discrimination);
        state.pendingAdvancement = result.phase_advanced ? result : null;
        state.pendingMastery = result.pack_mastered ? true : false;
        setPhase('discrimination');
      })
      .catch(() => showError('Could not submit answer. Please refresh.'));
  }

  function showFeedback(respondedId, result) {
    choicesDiv.querySelectorAll('.choice-btn').forEach(btn => {
      const wid = parseInt(btn.dataset.wordId, 10);
      if (wid === result.stimulus_word_id) btn.classList.add('correct');
      else if (wid === respondedId && !result.correct) btn.classList.add('wrong');
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

  function afterDiscrimination() {
    if (state.pendingAdvancement) {
      const adv = state.pendingAdvancement;
      state.pendingAdvancement = null;
      showAdvancementModal(adv.new_phase);
      return;
    }
    if (state.pendingMastery) {
      state.pendingMastery = false;
      showMasteryModal();
      return;
    }
    loadTrial();
  }

  function showAdvancementModal(newPhase) {
    if (!advanceModal) { loadTrial(); return; }
    if (advanceTitle) advanceTitle.textContent = 'Level up!';
    if (advanceMessage) advanceMessage.textContent = 'You\'ve mastered the synthetic pairs! All pairs are now in the mix.';
    advanceModal.hidden = false;
  }

  function showMasteryModal() {
    if (!masteryModal) { loadTrial(); return; }
    masteryModal.hidden = false;
  }

  function buildIdentDiscrimination(items) {
    discrimGrid.innerHTML = '';
    let currentAudio = null;
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
          if (currentAudio) {
            currentAudio.pause(); currentAudio.src = '';
            discrimGrid.querySelectorAll('.discrim-btn').forEach(b => {
              b.classList.remove('playing');
              const ic = b.querySelector('.play-icon');
              if (ic) ic.textContent = '▶';
            });
          }
          const audio = new Audio(item.recording_url);
          currentAudio = audio;
          btn.classList.add('playing');
          playIcon.textContent = '■';
          audio.addEventListener('ended', () => {
            btn.classList.remove('playing');
            playIcon.textContent = '▶';
            currentAudio = null;
          });
          audio.play().catch(() => {});
        });
      }
      discrimGrid.appendChild(btn);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DISCRIMINATION MODE
  // ══════════════════════════════════════════════════════════════════════════

  let discCurrentAudio = null;

  function loadDiscriminationTrial(data) {
    state.discTrial = data;
    state.discPlayed = { a: false, b: false };
    state.startTime = null;
    state.trialNumber = data.trial_number || state.trialNumber;
    state.trialLimit = data.trial_limit || state.trialLimit;
    if (data.mastered !== undefined) state.mastered = data.mastered;
    updateTrialCounter();

    // Set target word
    discTargetWord.textContent = data.target_label;

    // Reset play buttons
    discPlayA.className = 'disc-play-btn';
    discPlayB.className = 'disc-play-btn';
    discPlayA.querySelector('.disc-play-icon').textContent = '▶';
    discPlayB.querySelector('.disc-play-icon').textContent = '▶';
    discLabelA.hidden = true;
    discLabelB.hidden = true;

    // Reset answer area
    discAnswerA.className = 'disc-answer-btn';
    discAnswerB.className = 'disc-answer-btn';
    discAnswerA.disabled = false;
    discAnswerB.disabled = false;
    discAnswerPrompt.textContent = 'Tap to listen, then select:';
    discAnswerPrompt.hidden = false;

    // Reset feedback
    discFeedback.hidden = true;
    discFeedback.className = 'feedback-banner';
    discAccuracy.hidden = true;
    discNextBtn.hidden = true;

    setPhase('disc_trial');
  }

  function playDiscOption(idx) {
    const option = state.discTrial.options[idx];
    if (!option || !option.recording_url) return;

    // Stop any current playback
    if (discCurrentAudio) {
      discCurrentAudio.pause();
      discCurrentAudio.src = '';
      discPlayA.classList.remove('playing');
      discPlayB.classList.remove('playing');
      discPlayA.querySelector('.disc-play-icon').textContent = '▶';
      discPlayB.querySelector('.disc-play-icon').textContent = '▶';
    }

    const btn = idx === 0 ? discPlayA : discPlayB;
    const icon = btn.querySelector('.disc-play-icon');
    const audio = new Audio(option.recording_url);
    discCurrentAudio = audio;

    btn.classList.add('playing');
    icon.textContent = '■';

    audio.addEventListener('ended', () => {
      btn.classList.remove('playing');
      icon.textContent = '▶';
      discCurrentAudio = null;
    });

    audio.play().catch(() => {
      btn.classList.remove('playing');
      icon.textContent = '▶';
    });

    // Track that this option was played
    if (idx === 0) state.discPlayed.a = true;
    else state.discPlayed.b = true;

    // Start response timer after first play
    if (!state.startTime) state.startTime = Date.now();
  }

  function submitDiscAnswer(idx) {
    if (state.phase !== 'disc_trial') return;

    const selected = state.discTrial.options[idx];
    const responseTime = state.startTime ? Date.now() - state.startTime : null;

    // Disable answer buttons
    discAnswerA.disabled = true;
    discAnswerB.disabled = true;

    fetch('/api/discrimination-trial', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        item_id: state.discTrial.item_id,
        target_word_id: state.discTrial.target_word_id,
        selected_word_id: selected.word_id,
        recording_id: selected.recording_id,
        response_time_ms: responseTime,
      }),
    })
      .then(r => r.json())
      .then(result => {
        if (result.trial_number) state.trialNumber = result.trial_number;
        if (result.trial_limit) state.trialLimit = result.trial_limit;
        updateTrialCounter();
        if (result.session_correct !== undefined) {
          state.sessionCorrect = result.session_correct;
          state.sessionTotal = result.session_total;
          updateSessionScore(result.session_correct, result.session_total);
        }

        // Show feedback
        const correctIdx = state.discTrial.options.findIndex(
          o => o.word_id === state.discTrial.target_word_id
        );

        // Style answer buttons
        const correctBtn = correctIdx === 0 ? discAnswerA : discAnswerB;
        const wrongBtn = correctIdx === 0 ? discAnswerB : discAnswerA;
        correctBtn.classList.add('correct');
        if (!result.correct) {
          (idx === 0 ? discAnswerA : discAnswerB).classList.add('wrong');
        }

        // Reveal labels on play buttons
        const optA = state.discTrial.options[0];
        const optB = state.discTrial.options[1];
        discLabelA.textContent = optA.label;
        discLabelB.textContent = optB.label;
        discLabelA.hidden = false;
        discLabelB.hidden = false;

        // Highlight play buttons
        const correctPlayBtn = correctIdx === 0 ? discPlayA : discPlayB;
        const wrongPlayBtn = correctIdx === 0 ? discPlayB : discPlayA;
        correctPlayBtn.classList.add('correct-reveal');
        wrongPlayBtn.classList.remove('correct-reveal', 'wrong-reveal');

        // Feedback banner
        discFeedback.hidden = false;
        if (result.correct) {
          discFeedback.textContent = '✓ Correct';
          discFeedback.classList.add('correct');
        } else {
          discFeedback.textContent = '✗ Incorrect';
          discFeedback.classList.add('incorrect');
        }

        // Item accuracy
        showItemAccuracyBadge(discAccuracy, result.item_accuracy, result.item_accuracy_trials);

        // Hide answer prompt, show next button
        discAnswerPrompt.hidden = true;
        discNextBtn.hidden = false;

        // Check discrimination mastery
        if (result.disc_mastered && !state.discMasteryShown) {
          state.discMasteryShown = true;
          // Show mastery modal after a brief delay
          setTimeout(() => {
            if (discMasteryModal) discMasteryModal.hidden = false;
          }, 600);
        }

        setPhase('disc_feedback');
      })
      .catch(() => showError('Could not submit answer. Please refresh.'));
  }

  // ── Phase transitions ───────────────────────────────────────────────────
  function setPhase(phase) {
    state.phase = phase;
    loadingDiv.hidden = (phase !== 'loading');
    doneDiv.hidden    = (phase !== 'done');

    if (IS_DISC) {
      // Discrimination mode: hide identification elements
      presentDiv.hidden = true;
      discrimDiv.hidden = true;
      discTrialDiv.hidden = (phase !== 'disc_trial' && phase !== 'disc_feedback');
    } else {
      // Identification mode: hide discrimination elements
      if (discTrialDiv) discTrialDiv.hidden = true;
      presentDiv.hidden = (phase !== 'presenting' && phase !== 'answering' && phase !== 'submitting' && phase !== 'discrimination');
      discrimDiv.hidden = (phase !== 'discrimination');
      if (phase === 'discrimination') replayBtn.disabled = true;
    }
  }

  // ── Error ───────────────────────────────────────────────────────────────
  function showError(msg) {
    loadingDiv.innerHTML = `<p class="loading-msg" style="color:var(--red)">${msg}</p>`;
    setPhase('loading');
  }

})();
