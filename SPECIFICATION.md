# Minimal Pairs Training Application — Specification

## Overview

A locally-run offline web application for auditory perception training using minimal pairs. Built with Flask + SQLite, designed for a single end-user with a superuser managing content. The primary use case is training perception of Malayalam rhotics (ര alveolar tap vs റ retroflex trill), but the architecture supports any language contrast.

---

## Architecture

- **Backend:** Python / Flask, SQLite database (`minimal_pairs.db`)
- **Frontend:** Vanilla JS, server-rendered Jinja2 templates
- **Audio:** Browser MediaRecorder API → stored as WebM/OGG/M4A in `static/audio/`
- **No network dependency:** runs entirely on localhost; no CDNs, no external APIs

---

## Database Schema

### `pack`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| name | TEXT NOT NULL UNIQUE | Pack display name |
| description | TEXT | Optional description |
| published | INTEGER DEFAULT 0 | 1 = visible to end user |
| created_at | TEXT | ISO datetime |

### `item`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| pack_id | INTEGER FK → pack | CASCADE delete |
| created_at | TEXT | ISO datetime |

An item represents one minimal pair (or tuple). Each item has 2+ words.

### `word`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| item_id | INTEGER FK → item | CASCADE delete |
| label | TEXT NOT NULL | Display label (e.g. "കര") |
| word_type | TEXT DEFAULT 'real' | `'real'`, `'synthetic'`, or `'mixed'` |

**Word types:**
- `real` — both words in the pair are real words in the target language
- `synthetic` — both words are nonsense/invented words (used for pure phonetic training)
- `mixed` — one word is real, the other is synthetic

### `recording`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| word_id | INTEGER FK → word | CASCADE delete |
| file_path | TEXT NOT NULL | Path to audio file on disk |
| speaker_label | TEXT | Name of the speaker who recorded this |
| session_id | TEXT | Import session identifier (deduplication) |
| created_at | TEXT | ISO datetime |

Multiple recordings per word are supported. During training, one is selected at random.

### `directional_record`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| item_id | INTEGER FK → item | CASCADE delete |
| stimulus_word_id | INTEGER FK → word | The word played as audio |
| last_reviewed_at | TEXT | Last review timestamp |
| UNIQUE(item_id, stimulus_word_id) | | One record per direction |

Tracks each **direction** independently. For a pair (A, B), "hear A, identify A" and "hear B, identify B" are separate records. Accuracy is computed from `trial_log`, not stored on this table.

**Note:** The SRS columns (`srs_interval`, `srs_ease`, `srs_due_date`, `srs_repetitions`) have been removed. The algorithm no longer uses spaced repetition intervals.

### `training_state`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| pack_id | INTEGER FK → pack UNIQUE | One row per pack |
| phase | INTEGER DEFAULT 1 | Current training phase (1 or 2) |
| phase_advanced_at | TEXT | When last phase change occurred |
| mastered | INTEGER DEFAULT 0 | 1 = pack has reached mastery |
| mastered_at | TEXT | When mastery was first achieved |
| session_count_this_week | INTEGER DEFAULT 0 | Sessions completed this Mon-Sun week |
| total_seconds_this_week | INTEGER DEFAULT 0 | Cumulative training seconds this week |
| week_start | TEXT | Monday ISO date of current tracking week |
| last_session_date | TEXT | Date of most recent session |
| last_session_seconds | INTEGER DEFAULT 0 | Duration of most recent session |

Weekly counters reset automatically when the current Monday changes.

**Mastery transitions:**
- When all items reach 85% over last 20 trials → `mastered = 1`, mode switches to review (30 trials/session, once weekly)
- If pack accuracy drops below 75% during a review session → `mastered = 0`, re-enters active training (100 trials/session)

### `trial_log`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| item_id | INTEGER NOT NULL | Which item was tested |
| pack_id | INTEGER NOT NULL | Which pack |
| stimulus_word_id | INTEGER NOT NULL | Word played as audio |
| recording_id | INTEGER NOT NULL | Which recording was used |
| response_word_id | INTEGER NOT NULL | User's response |
| correct | INTEGER NOT NULL | 1 = correct, 0 = incorrect |
| response_time_ms | INTEGER | Reaction time in milliseconds |
| created_at | TEXT | ISO datetime |

### `speaker`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| name | TEXT NOT NULL UNIQUE | Speaker display name |
| created_at | TEXT | ISO datetime |

---

## Training Algorithm

The training algorithm is designed specifically for perceptual learning (auditory discrimination), not declarative memory. Traditional SRS (spaced repetition) is optimised for fact recall and is a poor fit for minimal pairs training because:

- Perceptual learning benefits from dense initial exposure, not early spacing
- Binary correct/incorrect on a 50% baseline requires many trials for reliable accuracy estimates
- Item-level interval scheduling encourages memorising specific recordings rather than learning the phonetic contrast

Instead, the algorithm uses **accuracy-weighted item selection within sessions** and **mastery-gated progression across sessions**.

### Core Principles

1. **No SRS intervals or due dates** — items do not have scheduled review dates
2. **No difficulty adaptation** — the acoustic difficulty is identical across all items (same phonetic contrast)
3. **Accuracy affects item selection within a session** — weaker items appear more often
4. **Mastery is assessed across sessions** — rolling accuracy over the last 20 trials per item
5. **Hard stop per session** — training ends after a fixed number of trials

---

### Session Modes

| Mode | Trials per session | Trigger |
|------|-------------------|---------|
| **Active training** | 100 | Default mode; pack not yet mastered |
| **Review** | 30 | Pack is mastered; scheduled once per week |

---

### Mastery

**Per-item mastery:** ≥ 85% accuracy (17/20) over the last 20 trials for that item.

**Pack mastery:** All items in the eligible pool have reached per-item mastery.

When a pack reaches mastery:
- Training mode switches from active (100 trials) to review (30 trials, once weekly)
- UI shows a mastery celebration

**Mastery loss:** If pack-level accuracy drops below 75% during a review session, the pack re-enters active training (100 trials per session).

---

### Pool Expansion (Phases)

Phases control the **size of the eligible item pool**, not difficulty. Dense initial exposure on a small set builds the perceptual category; the pool then widens.

#### Phase 1: Synthetic Pairs Only
- **Eligible items:** Only items where ALL words have `word_type = 'synthetic'`
- **Purpose:** Concentrated exposure to the phonetic contrast on a small, controlled set
- **Auto-fallback:** If no synthetic items exist in the pack, automatically advances to Phase 2

#### Phase 2: All Pairs
- **Eligible items:** All items in the pack (synthetic + mixed + real)
- **Purpose:** Broaden exposure to the contrast in varied lexical contexts

#### Automatic Phase Advancement

| Transition | Criteria |
|-----------|----------|
| Phase 1 → 2 | All synthetic items have reached per-item mastery (85% over last 20 trials) |

When phase advances:
- `training_state.phase` is updated
- `training_state.phase_advanced_at` records the timestamp
- API response includes `phase_advanced: true` and `new_phase: N`
- UI shows a celebration modal before continuing
- Item mastery counters **do not reset** — synthetic items retain their history

---

### Item Selection Within a Session

Items are selected via **weighted random sampling** based on recent accuracy:

1. Calculate each item's accuracy over its last 20 trials (or all trials if < 20)
2. Assign a selection weight: `weight = 1 - accuracy` (items at 50% accuracy are weighted 0.5; items at 90% are weighted 0.1)
3. Floor weight at 0.05 so mastered items still occasionally appear (prevents total absence)
4. Select item via weighted random from the eligible pool
5. Within the chosen item, pick a direction (stimulus word) at random
6. Pick a random recording for the stimulus word
7. Shuffle choice buttons (prevents position-learning)

**No overtraining cap** — the weighting naturally spreads exposure. Weak items appear more, but randomness ensures variety.

---

### Per-Item Accuracy Display

Each item's rolling accuracy (last 20 trials) is visible on the browse page as a percentage or visual indicator. This gives the user insight into which pairs are strong/weak.

---

## Training Session

### Session Flow
1. **Load trial** → API returns item, stimulus word, recording URL, shuffled choices, current phase, trial count
2. **Present** → Audio plays automatically; choices disabled until audio ends
3. **Answer** → User taps a choice button; response submitted to API
4. **Feedback** → Correct/incorrect banner; correct button highlighted green, wrong in red
5. **Discrimination** → Both words shown with play buttons; user can listen to each as many times as desired
6. **Next** → User clicks "Next →"; if phase advanced, celebration modal appears first
7. **Loop** back to step 1 until trial limit reached
8. **Session complete** → "You're done for today" screen when all trials are served

### Session Length
- **Active training:** 100 trials, hard stop
- **Review mode:** 30 trials, hard stop
- Trial counter displayed: `Trial 42 / 100`
- When all trials are complete, a completion screen is shown — no more trials are served

### Session Timer
- Counts up from 0:00, displayed alongside the trial counter
- Used for weekly tracking, not as a session limiter

### Session End Tracking
- On page unload (`beforeunload`), `navigator.sendBeacon` sends elapsed time to `/api/end-session`
- Sessions ≥ 5 minutes (300 seconds) count toward the weekly session goal
- `total_seconds_this_week` accumulates regardless of session length
- Session also ends automatically when trial limit is reached

---

## Weekly Training Schedule

**Active training target:** 2 sessions × 100 trials per week
**Review target:** 1 session × 30 trials per week (after mastery)

### Display (End-User Home)
Each pack card shows:
- Phase badge (Phase 1/2 with colour coding: amber/blue; green for mastered)
- Mode indicator: "Active" or "Review"
- Session dots: filled = completed session (≥ 5 min)
- Text: `X / 2 sessions` (active) or `X / 1 sessions` (review)

### Weekly Reset
- Tracked via `training_state.week_start` (Monday ISO date)
- When the current Monday differs from stored value, `session_count_this_week` and `total_seconds_this_week` are reset to 0

---

## Content Targets: Malayalam ര vs റ

**Target split for training pairs:**

| Type | Count | Purpose |
|------|-------|---------|
| Synthetic | 18 pairs | Phase 1 — pure phonetic training |
| Mixed | 12 pairs | Transition material |
| Real | 30 pairs | Phase 2 — real-world application |
| **Total** | **60 pairs** | ~8–10 weeks of sustained training |

**Rationale:**
- 100 trials per active training session; 30 trials per review session
- 18 synthetic pairs × 2 directions = 36 directional records → each seen ~3× per Phase 1 session (100 trials)
- 60 total pairs × 2 directions = 120 directional records → sufficient variety to prevent memorisation
- Accuracy-weighted selection ensures weak pairs get more exposure without excluding strong ones

---

## JSON Import Format

```json
{
  "name": "Pack Name",
  "description": "Optional description",
  "items": [
    { "words": ["word1", "word2"], "notes": "real: meaning1 — meaning2" },
    { "words": ["word1", "word2"], "notes": "synthetic pair" },
    { "words": ["word1", "word2"], "notes": "mixed: real_meaning — synthetic" }
  ]
}
```

**Word type auto-detection from `notes` field:**
- Contains `"synthetic pair"` or starts with `"synthetic"` → `word_type = 'synthetic'`
- Contains `"real"` → `word_type = 'real'`
- Contains `"mixed"` → `word_type = 'mixed'`
- Default (no match) → `word_type = 'real'`

All words within an item share the same `word_type` (determined per-item, not per-word).

---

## API Routes

### Training

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/trial/<pack_id>` | Get next trial (returns `{done: true}` if session trial limit reached) |
| POST | `/api/trial` | Submit answer; returns correctness, discrimination data, phase info |
| POST | `/api/end-session` | Record session end (pack_id, elapsed_seconds) |
| GET | `/api/training-state/<pack_id>` | Get phase, schedule, trial stats |
| POST | `/api/reset-progress/<pack_id>` | Clear trial logs, training state, and directional records |

### Content Management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/browse/data` | Browse all items/words/recordings (optional `?pack_id=` filter) |
| POST | `/api/word/<word_id>/rename` | Rename a word label |
| POST | `/api/word/<word_id>/type` | Change word_type (real/synthetic/mixed) |
| POST | `/api/word/<word_id>/delete` | Delete word (auto-deletes item if <2 words remain) |
| POST | `/api/recording/<rec_id>/delete` | Delete a recording |
| POST | `/api/import-recordings` | Import recordings from ZIP |

### Speakers

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/speakers` | List all speakers |
| POST | `/api/speaker/create` | Create a speaker |
| POST | `/api/speaker/<id>/delete` | Delete a speaker |
| GET | `/api/session-queue/<pack_id>` | Get recording queue for a speaker session |

---

## Pages

### End User
| Path | Description |
|------|-------------|
| `/user/` | Choose a pack to practise; shows phase, schedule, trial stats |
| `/user/train/<pack_id>` | Training session with accuracy-weighted trials |

### Superuser
| Path | Description |
|------|-------------|
| `/superuser/` | Pack list; JSON import |
| `/superuser/pack/<id>` | Pack detail; items, recordings, publish, reset progress |
| `/superuser/pack/<id>/session` | In-browser recording session |
| `/superuser/pack/<id>/export-session` | Generate shareable recording link for remote speakers |
| `/superuser/word/<id>` | Manage recordings for a word |
| `/superuser/browse` | Browse mode — search, rename, re-type, manage across packs |
| `/superuser/import-recordings` | Import ZIP of recordings from remote speaker sessions |

### Recorder
| Path | Description |
|------|-------------|
| `/recorder` | Self-contained recorder page (also deployable to GitHub Pages) |

---

## Recording System

### In-App Recording
- Superuser navigates to pack → Recording Session
- Speaker selection (create/switch speakers)
- Two-tier queue: Tier 1 = words with zero recordings; Tier 2 = words missing this speaker
- MediaRecorder captures audio; preview before accepting

### Remote Recording
- Superuser exports a session link containing a base64-encoded manifest in the URL hash
- Speaker opens link in any browser, records all words, downloads a ZIP
- Superuser imports the ZIP via the import-recordings page
- `session_id` field on recordings prevents duplicate imports

### Recording Selection During Training
- When a word has multiple recordings, one is chosen **at random** per trial
- The algorithm does not track which recording was used — accuracy is direction-level only

---

## Progress Reset

Available from the superuser pack detail page:
- Deletes all `directional_record` rows for the pack's items
- Deletes all `trial_log` rows for the pack
- Deletes the `training_state` row (recreated fresh on next access)
- **Does NOT delete recordings or words**
- Resets phase to 1, clears all weekly session counts

---

## File Structure

```
minimal_pairs/
├── app.py                          # Flask application, all routes
├── database.py                     # Schema definition, init_db()
├── minimal_pairs.db                # SQLite database (gitignored)
├── templates/
│   ├── base.html                   # Base layout
│   ├── index.html                  # Home page (superuser / end user split)
│   ├── user/
│   │   ├── index.html              # Pack chooser with schedule display
│   │   └── train.html              # Training session UI
│   └── superuser/
│       ├── index.html              # Pack list + import
│       ├── pack.html               # Pack detail + reset progress
│       ├── word.html               # Word recordings management
│       ├── session.html            # In-browser recording session
│       ├── browse.html             # Browse mode
│       ├── export_session.html     # Export recording link
│       └── import_recordings.html  # Import recordings ZIP
├── static/
│   ├── css/style.css               # All styles
│   ├── js/
│   │   ├── train.js                # Training session controller
│   │   ├── browse.js               # Browse mode controller
│   │   └── jszip.min.js            # JSZip library (local copy)
│   ├── audio/                      # Stored recordings (gitignored)
│   ├── recorder/
│   │   └── index.html              # Self-contained remote recorder (JSZip embedded)
│   └── sample_packs/
│       ├── malayalam_ra_rra.json   # ര vs റ pack definition
│       └── malayalam_na_nna.json   # ന vs ണ pack definition
├── recorder-deploy/
│   └── index.html                  # Recorder for static hosting (GitHub Pages / Netlify)
└── SPECIFICATION.md                # This document
```

---

## Design Decisions

1. **No user authentication:** Single end-user assumed. Training state is global per pack.
2. **No SRS / spaced repetition:** Traditional SRS is designed for declarative memory (facts, vocabulary). Perceptual learning — training auditory discrimination — is a different cognitive process. Dense exposure with accuracy-weighted item selection is more appropriate than interval-based scheduling.
3. **Accuracy-weighted selection, not difficulty adaptation:** The acoustic difficulty is the same across all items (same phonetic contrast). Rather than adjusting difficulty, the algorithm gives more exposure to weaker items within each session.
4. **Hard stop after fixed trial count:** 100 trials for active training, 30 for review. Prevents overtraining and keeps sessions focused. No items are "due" — the algorithm selects from the full eligible pool each session.
5. **Direction-level tracking, not recording-level:** Prevents gaming by memorising speaker voice rather than phonetic contrast.
6. **Random recording selection:** Each trial picks a random recording, building speaker-independent perception. Minimum 5 recordings per word before publishing.
7. **Phase = pool expansion, not difficulty:** Phases control how many items are in play. Phase 1 (synthetic only) provides concentrated initial exposure; Phase 2 (all items) broadens the training set. This is not a difficulty progression.
8. **Phase auto-advancement:** No manual intervention needed; user is informed via celebration modal.
9. **Offline-first:** JSZip embedded inline in recorder HTML; no CDN dependencies.
10. **Notes-based word type detection:** Keeps the JSON import format simple while supporting automatic classification.
11. **Discrimination phase after every trial:** Regardless of correctness, the user gets to compare both words, reinforcing the phonetic contrast.
12. **Mastery and review cycle:** Pack mastery (all items at 85%+ over 20 trials) triggers a shift to weekly 30-trial review sessions. If accuracy drops below 75%, the pack re-enters active training. This supports long-term retention without the false precision of SRS intervals.
