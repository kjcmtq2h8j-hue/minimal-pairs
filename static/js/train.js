/**
 * train.js — End User training session controller
 *
 * Expects PACK_ID to be defined in the page.
 * Phases: loading → presenting → answering → submitting → discrimination
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
  };

  // ── DOM ───────────────────────────────────────────────────────────────────
  const shell        = document.getElementById('train-shell');
  const loadingDiv   = document.getElementById('phase-loading');
  const presentDiv   = document.getElementById('phase-present');
  const discrimDiv   = document.getElementById('phase-discrim');
  const doneDiv      = document.getElementById('phase-done');

  const audioStatus  = document.getElementById('audio-status');
  const replayBtn    = document.getElementById('replay-btn');
  const choicesDiv   = document.getElementById('choices');
  const feedbackBanner = document.getElementById('feedback-banner');

  const discrimGrid  = document.getElementById('discrim-grid');
  const nextBtn      = document.getElementById('next-btn');

  // ── Entry point ───────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    if (typeof PACK_ID === 'undefined') return;
    replayBtn.addEventListener('click', () => replayAudio());
    nextBtn.addEventListener('click', () => loadTrial());
    loadTrial();
  });

  // ── Load next trial ───────────────────────────────────────────────────────
  function loadTrial() {
    setPhase('loading');
    fetch(`/api/trial/${PACK_ID}`)
      .then(r => r.json())
      .then(data => {
        if (data.done) { setPhase('done'); return; }
        state.trial      = data;
        state.audioEnded = false;
        state.startTime  = null;
        buildChoiceButtons();
        setPhase('presenting');
        playAudio();
      })
      .catch(() => {
        showError('Could not load next trial. Please refresh the page.');
      });
  }

  // ── Audio ─────────────────────────────────────────────────────────────────
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
      enableChoices(); // still allow answering
    });

    el.play().catch(() => {
      // Autoplay blocked — require user gesture
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

  // ── Choices ───────────────────────────────────────────────────────────────
  function buildChoiceButtons() {
    choicesDiv.innerHTML = '';
    feedbackBanner.hidden = true;
    feedbackBanner.className = 'feedback-banner';

    for (const ch of state.trial.choices) {
      const btn = document.createElement('button');
      btn.className          = 'choice-btn';
      btn.textContent        = ch.label;
      btn.dataset.wordId     = ch.word_id;
      btn.disabled           = true;  // enabled after audio plays
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

  // ── Submit answer ─────────────────────────────────────────────────────────
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
        showFeedback(wordId, result);
        buildDiscrimination(result.discrimination);
        setPhase('discrimination');
      })
      .catch(() => showError('Could not submit answer. Please refresh.'));
  }

  // ── Feedback ──────────────────────────────────────────────────────────────
  function showFeedback(respondedId, result) {
    // Colour choice buttons
    choicesDiv.querySelectorAll('.choice-btn').forEach(btn => {
      const wid = parseInt(btn.dataset.wordId, 10);
      if (wid === result.stimulus_word_id) {
        btn.classList.add('correct');
      } else if (wid === respondedId && !result.correct) {
        btn.classList.add('wrong');
      }
    });

    // Banner
    feedbackBanner.hidden = false;
    if (result.correct) {
      feedbackBanner.textContent = '✓ Correct';
      feedbackBanner.classList.add('correct');
    } else {
      feedbackBanner.textContent = '✗ Incorrect';
      feedbackBanner.classList.add('incorrect');
    }
  }

  // ── Discrimination phase ──────────────────────────────────────────────────
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
            // Reset all buttons
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

  // ── Phase transitions ─────────────────────────────────────────────────────
  function setPhase(phase) {
    state.phase = phase;

    loadingDiv.hidden  = (phase !== 'loading');
    presentDiv.hidden  = (phase !== 'presenting' && phase !== 'answering' && phase !== 'submitting' && phase !== 'discrimination');
    discrimDiv.hidden  = (phase !== 'discrimination');
    doneDiv.hidden     = (phase !== 'done');

    if (phase === 'discrimination') {
      replayBtn.disabled = true;
    }

    if (phase === 'done') {
      // nothing extra
    }
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  function showError(msg) {
    loadingDiv.innerHTML = `<p class="loading-msg" style="color:var(--red)">${msg}</p>`;
    setPhase('loading');
  }

})();
