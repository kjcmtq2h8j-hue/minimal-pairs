/**
 * record.js — shared recording utilities + session page controller
 *
 * Used by:
 *   - superuser/session.html  (SESSION_PACK_ID, INITIAL_SPEAKERS must be defined)
 *   - superuser/word.html     (WORD_ID must be defined; initialises inline recorder)
 */

// ── MediaRecorder helpers ───────────────────────────────────────────────────

function getSupportedMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4',
  ];
  for (const t of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function mimeToExt(mime) {
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4')) return 'm4a';
  return 'webm';
}

class Recorder {
  constructor() {
    this.mediaRecorder = null;
    this.stream        = null;
    this.chunks        = [];
    this.blob          = null;
    this.mimeType      = getSupportedMimeType();
  }

  async requestMic() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      return true;
    } catch (err) {
      console.error('Microphone access denied:', err);
      return false;
    }
  }

  start() {
    if (!this.stream) throw new Error('No stream — call requestMic() first');
    this.chunks = [];
    this.blob   = null;
    const opts  = this.mimeType ? { mimeType: this.mimeType } : {};
    this.mediaRecorder = new MediaRecorder(this.stream, opts);
    this.mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.mediaRecorder.start();
  }

  stop() {
    return new Promise(resolve => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        resolve(null);
        return;
      }
      this.mediaRecorder.onstop = () => {
        const type = this.mimeType || 'audio/webm';
        this.blob  = new Blob(this.chunks, { type });
        resolve(URL.createObjectURL(this.blob));
      };
      this.mediaRecorder.stop();
    });
  }

  releaseMic() {
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
  }

  async save(wordId, speakerLabel) {
    if (!this.blob) return null;
    const ext      = mimeToExt(this.mimeType);
    const formData = new FormData();
    formData.append('audio', this.blob, `recording.${ext}`);
    if (speakerLabel) formData.append('speaker_label', speakerLabel);

    const res = await fetch(`/superuser/word/${wordId}/record`, {
      method: 'POST',
      body:   formData,
    });
    return res.ok ? await res.json() : null;
  }
}

// ── Session page controller ─────────────────────────────────────────────────
// Runs when SESSION_PACK_ID is defined (session.html)

document.addEventListener('DOMContentLoaded', () => {
  if (typeof SESSION_PACK_ID === 'undefined') return;

  const recorder = new Recorder();

  // State
  let selectedSpeaker = null;   // { id, name }
  let queue           = [];     // prioritised word list from API
  let queueIndex      = 0;
  let isRecording     = false;
  let previewUrl      = null;

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const setupScreen      = document.getElementById('setup-screen');
  const recordScreen     = document.getElementById('record-screen');
  const doneScreen       = document.getElementById('done-screen');
  const speakerList      = document.getElementById('speaker-list');
  const newSpeakerInput  = document.getElementById('new-speaker-input');
  const createSpeakerBtn = document.getElementById('create-speaker-btn');
  const selectedIndicator= document.getElementById('selected-indicator');
  const selectedNameDisp = document.getElementById('selected-name-display');
  const startBtn         = document.getElementById('start-session-btn');

  const speakerChip      = document.getElementById('session-speaker-display');
  const progressLabel    = document.getElementById('session-progress');
  const tierHint         = document.getElementById('rec-tier-display');
  const wordDisplay      = document.getElementById('session-word-display');
  const recBtn           = document.getElementById('rec-btn');
  const recBtnLabel      = document.getElementById('rec-btn-label');
  const previewSection   = document.getElementById('preview-section');
  const previewAudio     = document.getElementById('preview-audio');
  const saveBtn          = document.getElementById('save-btn');
  const rerecordBtn      = document.getElementById('rerecord-btn');
  const statusMsg        = document.getElementById('status-msg');
  const skipBtn          = document.getElementById('skip-btn');
  const exitBtn          = document.getElementById('exit-btn');
  const doneMsg          = document.getElementById('done-msg');

  // ── Speaker helpers ───────────────────────────────────────────────────────

  function selectSpeaker(id, name) {
    selectedSpeaker = { id, name };
    // Highlight selected row
    document.querySelectorAll('.speaker-select-btn').forEach(btn => {
      const row = btn.closest('[data-speaker-id]');
      const active = row && String(row.dataset.speakerId) === String(id);
      btn.classList.toggle('selected', active);
    });
    selectedNameDisp.textContent = name;
    selectedIndicator.hidden = false;
    startBtn.disabled = false;
  }

  function addSpeakerRow(speaker) {
    // Remove "no speakers" placeholder if present
    const placeholder = document.getElementById('no-speakers-msg');
    if (placeholder) placeholder.remove();

    const row = document.createElement('div');
    row.className = 'speaker-profile-row';
    row.dataset.speakerId   = speaker.id;
    row.dataset.speakerName = speaker.name;
    row.innerHTML = `
      <button class="speaker-select-btn">${escHtml(speaker.name)}</button>
      <button class="speaker-delete-btn" data-id="${speaker.id}" title="Delete profile">✕</button>`;
    speakerList.appendChild(row);
  }

  // ── Speaker list interaction (event delegation) ───────────────────────────

  speakerList.addEventListener('click', async e => {
    const selectBtn = e.target.closest('.speaker-select-btn');
    const deleteBtn = e.target.closest('.speaker-delete-btn');

    if (selectBtn) {
      const row = selectBtn.closest('[data-speaker-id]');
      if (row) selectSpeaker(row.dataset.speakerId, row.dataset.speakerName);
    }

    if (deleteBtn) {
      const id   = deleteBtn.dataset.id;
      const row  = deleteBtn.closest('[data-speaker-id]');
      const name = row ? row.dataset.speakerName : 'this speaker';
      if (!confirm(`Delete profile "${name}"? Their recordings will be kept.`)) return;

      const res = await fetch(`/api/speaker/${id}/delete`, { method: 'POST' });
      if (!res.ok) { alert('Could not delete — please try again.'); return; }

      row.remove();

      // Deselect if the deleted speaker was selected
      if (selectedSpeaker && String(selectedSpeaker.id) === String(id)) {
        selectedSpeaker = null;
        selectedIndicator.hidden = true;
        startBtn.disabled = true;
      }

      // Show placeholder if list is now empty
      if (!speakerList.querySelector('[data-speaker-id]')) {
        speakerList.innerHTML =
          '<p class="text-muted" id="no-speakers-msg" style="margin:.25rem 0 .75rem;">No speakers yet — create one below.</p>';
      }
    }
  });

  // ── Create new speaker ────────────────────────────────────────────────────

  async function doCreateSpeaker() {
    const name = newSpeakerInput.value.trim();
    if (!name) { newSpeakerInput.focus(); return; }

    createSpeakerBtn.disabled = true;
    const res = await fetch('/api/speaker/create', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name }),
    });

    createSpeakerBtn.disabled = false;

    if (res.status === 409) {
      // Already exists — find and select the existing row
      const data = await res.json();
      const existing = speakerList.querySelector(`[data-speaker-id="${data.id}"]`);
      if (existing) selectSpeaker(data.id, data.name);
      newSpeakerInput.value = '';
      return;
    }

    if (!res.ok) { alert('Could not create speaker. Please try again.'); return; }

    const speaker = await res.json();
    addSpeakerRow(speaker);
    selectSpeaker(speaker.id, speaker.name);
    newSpeakerInput.value = '';
  }

  createSpeakerBtn.addEventListener('click', doCreateSpeaker);
  newSpeakerInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') doCreateSpeaker();
  });

  // Typing a name in the input also enables the Start button directly
  newSpeakerInput.addEventListener('input', () => {
    if (!selectedSpeaker && newSpeakerInput.value.trim()) {
      startBtn.disabled = false;
    } else if (!selectedSpeaker && !newSpeakerInput.value.trim()) {
      startBtn.disabled = true;
    }
  });

  // ── Start session ─────────────────────────────────────────────────────────

  startBtn.addEventListener('click', async () => {
    // If no speaker selected but name typed, create-and-select first
    if (!selectedSpeaker && newSpeakerInput.value.trim()) {
      await doCreateSpeaker();
      if (!selectedSpeaker) return; // creation failed
    }
    if (!selectedSpeaker) return;

    startBtn.disabled        = true;
    startBtn.textContent     = 'Loading queue…';

    // Fetch prioritised queue for this speaker
    const res = await fetch(
      `/api/session-queue/${SESSION_PACK_ID}?speaker=${encodeURIComponent(selectedSpeaker.name)}`
    );
    queue      = await res.json();
    queueIndex = 0;

    if (queue.length === 0) {
      doneMsg.textContent =
        `Every word already has a recording from ${selectedSpeaker.name}. Nothing to do!`;
      setupScreen.hidden = true;
      doneScreen.hidden  = false;
      return;
    }

    // Request mic
    const ok = await recorder.requestMic();
    if (!ok) {
      alert('Microphone access is required. Please allow it and try again.');
      startBtn.disabled    = false;
      startBtn.textContent = 'Start Recording →';
      return;
    }

    // Show speaker name in recording screen
    if (speakerChip) speakerChip.textContent = `🎙 ${selectedSpeaker.name}`;

    setupScreen.hidden  = true;
    recordScreen.hidden = false;
    showWord(0);
  });

  // ── Word display ──────────────────────────────────────────────────────────

  function showWord(idx) {
    if (idx >= queue.length) {
      recordScreen.hidden = true;
      doneScreen.hidden   = false;
      recorder.releaseMic();
      const name = selectedSpeaker ? selectedSpeaker.name : 'you';
      doneMsg.textContent =
        `All words in the queue now have a recording from ${name}.`;
      return;
    }

    const w = queue[idx];
    wordDisplay.textContent   = w.label;
    progressLabel.textContent = `Word ${idx + 1} of ${queue.length}`;

    if (tierHint) {
      if (w.tier === 1) {
        tierHint.textContent  = '⚠️ No recordings yet';
        tierHint.className    = 'rec-tier-hint tier-missing';
      } else {
        tierHint.textContent  =
          `${w.total_recs} recording${w.total_recs !== 1 ? 's' : ''} exist — none from you yet`;
        tierHint.className    = 'rec-tier-hint tier-needs-you';
      }
    }

    resetToIdle();
  }

  function resetToIdle() {
    isRecording           = false;
    previewUrl            = null;
    previewSection.hidden = true;
    recBtn.disabled       = false;
    recBtn.classList.remove('recording');
    recBtnLabel.textContent = '🎙 Record';
    saveBtn.disabled      = false;
    rerecordBtn.disabled  = false;
    setStatus('');
  }

  function setStatus(msg) {
    if (statusMsg) statusMsg.textContent = msg;
  }

  // ── Record button ─────────────────────────────────────────────────────────

  recBtn.addEventListener('click', async () => {
    if (!isRecording) {
      recorder.start();
      isRecording = true;
      recBtn.classList.add('recording');
      recBtnLabel.textContent = '⏹ Stop';
      setStatus('Recording…');
    } else {
      recBtn.disabled = true;
      setStatus('Processing…');
      previewUrl  = await recorder.stop();
      isRecording = false;

      if (previewUrl) {
        previewAudio.src      = previewUrl;
        previewSection.hidden = false;
        recBtn.classList.remove('recording');
        recBtnLabel.textContent = '🎙 Record again';
        recBtn.disabled = false;
        setStatus('Preview your recording, then save or re-record.');
      } else {
        recBtn.disabled = false;
        setStatus('Something went wrong — please try again.');
      }
    }
  });

  // ── Re-record ─────────────────────────────────────────────────────────────

  rerecordBtn.addEventListener('click', () => {
    previewSection.hidden   = true;
    previewUrl              = null;
    recBtnLabel.textContent = '🎙 Record';
    setStatus('');
  });

  // ── Save & Next ───────────────────────────────────────────────────────────

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled     = true;
    rerecordBtn.disabled = true;
    setStatus('Saving…');

    const wordId = queue[queueIndex].id;
    const result = await recorder.save(wordId, selectedSpeaker ? selectedSpeaker.name : '');

    if (result) {
      queueIndex++;
      showWord(queueIndex);
    } else {
      setStatus('Save failed — please try again.');
      saveBtn.disabled     = false;
      rerecordBtn.disabled = false;
    }
  });

  // ── Skip ──────────────────────────────────────────────────────────────────

  skipBtn.addEventListener('click', () => {
    queueIndex++;
    showWord(queueIndex);
  });

  // ── Exit ──────────────────────────────────────────────────────────────────

  exitBtn.addEventListener('click', () => {
    recorder.releaseMic();
    window.location.href = `/superuser/pack/${SESSION_PACK_ID}`;
  });
});


// ── Inline recorder for word detail page ────────────────────────────────────
// Runs when WORD_ID is defined (word.html)

document.addEventListener('DOMContentLoaded', () => {
  if (typeof WORD_ID === 'undefined') return;

  const recorder = new Recorder();
  let isRecording = false;
  let previewUrl  = null;

  const recBtn       = document.getElementById('inline-rec-btn');
  const previewSec   = document.getElementById('inline-preview-section');
  const previewAudio = document.getElementById('inline-preview-audio');
  const saveBtn      = document.getElementById('inline-save-btn');
  const rerecordBtn  = document.getElementById('inline-rerecord-btn');
  const statusEl     = document.getElementById('inline-status');
  const speakerInput = document.getElementById('inline-speaker-label');
  const recList      = document.getElementById('rec-list');

  if (!recBtn) return;

  async function ensureMic() {
    if (recorder.stream) return true;
    const ok = await recorder.requestMic();
    if (!ok) alert('Microphone access is required. Please allow it and try again.');
    return ok;
  }

  recBtn.addEventListener('click', async () => {
    if (!isRecording) {
      const ok = await ensureMic();
      if (!ok) return;
      recorder.start();
      isRecording = true;
      recBtn.textContent = '⏹ Stop Recording';
      recBtn.classList.add('recording');
      if (statusEl) statusEl.textContent = 'Recording…';
    } else {
      recBtn.disabled = true;
      if (statusEl) statusEl.textContent = 'Processing…';
      previewUrl  = await recorder.stop();
      isRecording = false;
      recBtn.disabled   = false;
      recBtn.textContent = '🎙 Record New';
      recBtn.classList.remove('recording');

      if (previewUrl) {
        previewAudio.src  = previewUrl;
        previewSec.hidden = false;
        if (statusEl) statusEl.textContent = 'Preview, then save or re-record.';
      } else {
        if (statusEl) statusEl.textContent = 'Something went wrong — please try again.';
      }
    }
  });

  rerecordBtn.addEventListener('click', () => {
    previewSec.hidden = true;
    previewUrl        = null;
    if (statusEl) statusEl.textContent = '';
  });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled     = true;
    rerecordBtn.disabled = true;
    if (statusEl) statusEl.textContent = 'Saving…';

    const label  = speakerInput ? speakerInput.value.trim() : '';
    const result = await recorder.save(WORD_ID, label);

    if (result) {
      // Append new row to list
      const li = document.createElement('li');
      li.className = 'rec-item';
      li.dataset.recId = result.id;
      li.innerHTML = `
        <audio controls src="${result.url}" class="preview-audio"></audio>
        <span class="rec-meta">${result.speaker_label ? '👤 ' + escHtml(result.speaker_label) : 'No speaker label'}</span>
        <form method="POST" action="/superuser/recording/${result.id}/delete" style="margin-left:auto">
          <input type="hidden" name="back" value="${window.location.pathname}">
          <button type="submit" class="btn btn-danger btn-sm"
            onclick="return confirm('Delete this recording?')">Delete</button>
        </form>`;
      recList.appendChild(li);

      previewSec.hidden    = true;
      previewUrl           = null;
      saveBtn.disabled     = false;
      rerecordBtn.disabled = false;
      if (statusEl) statusEl.textContent = 'Saved!';
      setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);

      const badge = document.getElementById('rec-count-badge');
      if (badge) {
        const cur = parseInt(badge.dataset.count || '0', 10) + 1;
        badge.dataset.count = cur;
        badge.textContent   = `${cur} recording${cur !== 1 ? 's' : ''}`;
        badge.className     = 'badge badge-green';
      }
    } else {
      if (statusEl) statusEl.textContent = 'Save failed — please try again.';
      saveBtn.disabled     = false;
      rerecordBtn.disabled = false;
    }
  });
});


function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
