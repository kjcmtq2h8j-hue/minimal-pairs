/**
 * browse.js — Superuser browse mode
 * Depends on record.js being loaded first (Recorder class, escHtml).
 */

// ── State ────────────────────────────────────────────────────────────────────

let allItems      = [];   // full dataset from API
let activePackId  = null; // null = all packs
let searchQuery   = '';
let showNoRecOnly = false;
let speakerFilter = '';

// Modal state
let modalWordId    = null;
let modalRecorder  = new Recorder();
let modalRecording = false;
let modalPreviewUrl= null;

// ── DOM refs ─────────────────────────────────────────────────────────────────

const tbody        = document.getElementById('browse-tbody');
const statsEl      = document.getElementById('browse-stats');
const searchInput  = document.getElementById('browse-search');
const noRecToggle  = document.getElementById('filter-no-rec');
const speakerSel   = document.getElementById('filter-speaker');
const sidebarBtns  = document.querySelectorAll('.sidebar-pack-btn');

const modalOverlay = document.getElementById('rec-modal-overlay');
const modalClose   = document.getElementById('modal-close-btn');
const modalWordLbl = document.getElementById('modal-word-label');
const modalSpkDisp = document.getElementById('modal-speaker-display');
const modalRecBtn  = document.getElementById('modal-rec-btn');
const modalRecLbl  = document.getElementById('modal-rec-label');
const modalStatus  = document.getElementById('modal-status');
const modalPreview = document.getElementById('modal-preview-section');
const modalAudio   = document.getElementById('modal-preview-audio');
const modalSave    = document.getElementById('modal-save-btn');
const modalRerecord= document.getElementById('modal-rerecord-btn');

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadData() {
  tbody.innerHTML = '<tr><td colspan="4" class="browse-loading">Loading…</td></tr>';
  const url = activePackId
    ? `/api/browse/data?pack_id=${activePackId}`
    : '/api/browse/data';
  const res  = await fetch(url);
  allItems   = await res.json();
  render();
}

// ── Filtering ─────────────────────────────────────────────────────────────────

function applyFilters(item) {
  const words = item.words.filter(w => {
    if (searchQuery   && !w.label.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    if (showNoRecOnly && w.rec_count > 0) return false;
    if (speakerFilter && !w.speakers.includes(speakerFilter)) return false;
    return true;
  });
  return words.length ? { ...item, words } : null;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function render() {
  const filtered = allItems.map(applyFilters).filter(Boolean);
  const totalWords = filtered.reduce((s, i) => s + i.words.length, 0);
  statsEl.textContent = `${filtered.length} item${filtered.length !== 1 ? 's' : ''} · ${totalWords} word${totalWords !== 1 ? 's' : ''}`;

  tbody.innerHTML = '';

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="browse-empty">No words match the current filters.</td></tr>';
    return;
  }

  filtered.forEach(item => {
    // ── Item group header ──
    const hdr = document.createElement('tr');
    hdr.className = 'browse-group-header';
    hdr.innerHTML = `
      <td colspan="4">
        <span class="browse-pack-name">${escHtml(item.pack_name)}</span>
        <span class="browse-item-id">Item #${item.id}</span>
        ${item.pack_published
          ? '<span class="badge badge-green">Published</span>'
          : '<span class="badge badge-grey">Draft</span>'}
      </td>`;
    tbody.appendChild(hdr);

    // ── Word rows ──
    item.words.forEach(word => {
      const recClass = word.rec_count === 0 ? 'badge-red' : 'badge-green';
      const spkText  = word.speakers.length
        ? word.speakers.map(escHtml).join(', ')
        : '<span class="text-muted">—</span>';

      const tr = document.createElement('tr');
      tr.className = 'browse-word-row';
      tr.dataset.wordId = word.id;
      tr.dataset.itemId = item.id;
      tr.innerHTML = `
        <td>
          <span class="browse-word-label" data-word-id="${word.id}"
                title="Click to rename">${escHtml(word.label)}</span>
        </td>
        <td>
          <span class="badge ${recClass}" id="rec-badge-${word.id}">${word.rec_count} rec${word.rec_count !== 1 ? 's' : ''}</span>
        </td>
        <td class="browse-speakers" id="speakers-cell-${word.id}">${spkText}</td>
        <td>
          <div class="browse-actions">
            <button class="btn btn-outline btn-sm expand-rec-btn"
                    data-word-id="${word.id}" title="Show/hide recordings">🔊</button>
            <button class="btn btn-primary btn-sm add-rec-btn"
                    data-word-id="${word.id}"
                    data-label="${escHtml(word.label)}"
                    title="Add recording">🎤 Add</button>
            <button class="btn btn-danger btn-sm delete-word-btn"
                    data-word-id="${word.id}"
                    data-label="${escHtml(word.label)}"
                    data-item-id="${item.id}"
                    title="Delete word">🗑</button>
          </div>
        </td>`;
      tbody.appendChild(tr);

      // ── Recordings sub-row ──
      const subTr = document.createElement('tr');
      subTr.className = 'browse-rec-subrow';
      subTr.dataset.wordId = word.id;
      subTr.hidden = true;
      subTr.innerHTML = `
        <td colspan="4">
          <ul class="rec-sub-list" data-word-id="${word.id}">
            ${word.recordings.map(renderRecLi).join('')}
            ${!word.recordings.length
              ? '<li class="rec-sub-empty">No recordings yet.</li>'
              : ''}
          </ul>
        </td>`;
      tbody.appendChild(subTr);
    });
  });
}

function renderRecLi(rec) {
  const spkText = rec.speaker_label
    ? `👤 ${escHtml(rec.speaker_label)}`
    : '<em>no speaker label</em>';
  return `
    <li class="rec-sub-item" data-rec-id="${rec.id}">
      <audio controls src="${escHtml(rec.url)}" class="rec-sub-audio"></audio>
      <span class="rec-meta">${spkText} · ${escHtml(rec.created_at)}</span>
      <button class="btn btn-danger btn-sm delete-rec-btn"
              data-rec-id="${rec.id}" style="margin-left:auto;">Delete</button>
    </li>`;
}

// ── Table event delegation ────────────────────────────────────────────────────

tbody.addEventListener('click', async e => {

  // Expand / collapse recordings
  const expandBtn = e.target.closest('.expand-rec-btn');
  if (expandBtn) {
    const wordId = expandBtn.dataset.wordId;
    const subRow = tbody.querySelector(`.browse-rec-subrow[data-word-id="${wordId}"]`);
    if (subRow) {
      subRow.hidden = !subRow.hidden;
      expandBtn.textContent = subRow.hidden ? '🔊' : '🔼';
    }
    return;
  }

  // Add recording → open modal
  const addBtn = e.target.closest('.add-rec-btn');
  if (addBtn) {
    openModal(parseInt(addBtn.dataset.wordId, 10), addBtn.dataset.label);
    return;
  }

  // Delete word
  const delWordBtn = e.target.closest('.delete-word-btn');
  if (delWordBtn) {
    const label  = delWordBtn.dataset.label;
    if (!confirm(`Delete "${label}" and all its recordings? This cannot be undone.`)) return;
    const res  = await fetch(`/api/word/${delWordBtn.dataset.wordId}/delete`, { method: 'POST' });
    const data = await res.json();
    if (!data.ok) { showToast('Delete failed — please try again.', 'error'); return; }
    if (data.pack_unpublished) showToast('Pack auto-unpublished: some words now have no recordings.', 'warning');
    if (data.item_deleted)     showToast('Item removed: fewer than 2 words remained.', 'info');
    await loadData();
    return;
  }

  // Delete recording
  const delRecBtn = e.target.closest('.delete-rec-btn');
  if (delRecBtn) {
    if (!confirm('Delete this recording?')) return;
    const res  = await fetch(`/api/recording/${delRecBtn.dataset.recId}/delete`, { method: 'POST' });
    const data = await res.json();
    if (!data.ok) { showToast('Delete failed — please try again.', 'error'); return; }
    await loadData();
    return;
  }

  // Inline rename (click on word label)
  const wordLabelEl = e.target.closest('.browse-word-label');
  if (wordLabelEl) {
    startInlineRename(wordLabelEl);
  }
});

// ── Inline rename ─────────────────────────────────────────────────────────────

function startInlineRename(labelEl) {
  const wordId  = labelEl.dataset.wordId;
  const original = labelEl.textContent;

  const input = document.createElement('input');
  input.type      = 'text';
  input.value     = original;
  input.className = 'browse-inline-rename';
  labelEl.replaceWith(input);
  input.focus();
  input.select();

  async function commit() {
    const newLabel = input.value.trim();
    if (!newLabel || newLabel === original) {
      input.replaceWith(labelEl);
      return;
    }
    const res  = await fetch(`/api/word/${wordId}/rename`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ label: newLabel }),
    });
    const data = await res.json();
    if (data.ok) {
      labelEl.textContent = newLabel;
      // Keep in-memory data in sync so filters still work
      allItems.forEach(item =>
        item.words.forEach(w => { if (String(w.id) === String(wordId)) w.label = newLabel; })
      );
      showToast('Word renamed.', 'success');
    } else {
      showToast(data.error || 'Rename failed.', 'error');
    }
    input.replaceWith(labelEl);
  }

  input.addEventListener('blur',    commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.replaceWith(labelEl); }
  });
}

// ── Recording modal ───────────────────────────────────────────────────────────

function openModal(wordId, wordLabel) {
  modalWordId     = wordId;
  modalRecording  = false;
  modalPreviewUrl = null;

  modalWordLbl.textContent      = wordLabel;
  modalSpkDisp.textContent      = '';
  modalSpkDisp.hidden           = true;
  modalStatus.textContent       = '';
  modalPreview.hidden           = true;
  modalRecLbl.textContent       = '🎙';
  modalRecBtn.classList.remove('recording');
  modalRecBtn.disabled          = false;
  modalSave.disabled            = false;
  modalRerecord.disabled        = false;

  modalOverlay.hidden = false;
}

function closeModal() {
  modalOverlay.hidden = true;
  modalRecorder.releaseMic();
  modalWordId     = null;
  modalRecording  = false;
  modalPreviewUrl = null;
}

modalClose.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e => {
  if (e.target === modalOverlay) closeModal();
});

// Record button inside modal
modalRecBtn.addEventListener('click', async () => {
  if (!modalRecording) {
    // Start recording
    if (!modalRecorder.stream) {
      const ok = await modalRecorder.requestMic();
      if (!ok) {
        modalStatus.textContent = 'Microphone access denied.';
        return;
      }
    }
    modalRecorder.start();
    modalRecording = true;
    modalRecBtn.classList.add('recording');
    modalRecLbl.textContent  = '⏹';
    modalStatus.textContent  = 'Recording…';
  } else {
    // Stop recording
    modalRecBtn.disabled    = true;
    modalStatus.textContent = 'Processing…';
    modalPreviewUrl         = await modalRecorder.stop();
    modalRecording          = false;
    modalRecBtn.disabled    = false;
    modalRecBtn.classList.remove('recording');
    modalRecLbl.textContent = '🎙';

    if (modalPreviewUrl) {
      modalAudio.src          = modalPreviewUrl;
      modalPreview.hidden     = false;
      modalStatus.textContent = 'Preview, then save or re-record.';
    } else {
      modalStatus.textContent = 'Something went wrong — try again.';
    }
  }
});

modalRerecord.addEventListener('click', () => {
  modalPreview.hidden     = true;
  modalPreviewUrl         = null;
  modalStatus.textContent = '';
});

modalSave.addEventListener('click', async () => {
  if (!modalPreviewUrl) return;
  modalSave.disabled     = true;
  modalRerecord.disabled = true;
  modalStatus.textContent = 'Saving…';

  const result = await modalRecorder.save(modalWordId, '');
  if (result) {
    showToast('Recording saved.', 'success');
    closeModal();
    await loadData();
  } else {
    modalStatus.textContent = 'Save failed — please try again.';
    modalSave.disabled      = false;
    modalRerecord.disabled  = false;
  }
});

// ── Sidebar pack filter ───────────────────────────────────────────────────────

sidebarBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    sidebarBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activePackId = btn.dataset.packId ? parseInt(btn.dataset.packId, 10) : null;
    loadData();
  });
});

// ── Filter controls ───────────────────────────────────────────────────────────

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  render();
});

noRecToggle.addEventListener('change', () => {
  showNoRecOnly = noRecToggle.checked;
  render();
});

speakerSel.addEventListener('change', () => {
  speakerFilter = speakerSel.value;
  render();
});

// ── Toast notifications ───────────────────────────────────────────────────────

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `browse-toast browse-toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  // Trigger animation
  requestAnimationFrame(() => toast.classList.add('browse-toast-show'));
  setTimeout(() => {
    toast.classList.remove('browse-toast-show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ── Init ──────────────────────────────────────────────────────────────────────

loadData();
