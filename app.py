import os
import io
import json
import base64
import random
import uuid
import zipfile
from datetime import datetime, date, timedelta

from flask import (Flask, render_template, request, redirect,
                   url_for, jsonify, session, flash, send_from_directory)

from database import get_db, init_db

app = Flask(__name__)
app.secret_key = 'minimal-pairs-local-secret-2024'

AUDIO_DIR = os.path.join(app.static_folder, 'audio')
os.makedirs(AUDIO_DIR, exist_ok=True)

# ── Training algorithm constants ──────────────────────────────────────────────
ACTIVE_TRIAL_LIMIT = 100   # trials per active training session
REVIEW_TRIAL_LIMIT = 30    # trials per review session
MASTERY_THRESHOLD = 0.85   # 85% accuracy over last 20 trials per item
MASTERY_LOSS_THRESHOLD = 0.75  # drop below 75% pack accuracy → re-enter active
MASTERY_WINDOW = 20        # last N trials per item for accuracy calculation
MIN_TRIALS_FOR_MASTERY = 20  # need at least this many trials per item before mastery


def ensure_directional_records(db, pack_id):
    """Create any missing directional records for a pack (called at session start)."""
    items = db.execute('SELECT id FROM item WHERE pack_id = ?', (pack_id,)).fetchall()
    for item in items:
        words = db.execute('SELECT id FROM word WHERE item_id = ?', (item['id'],)).fetchall()
        for word in words:
            db.execute('''
                INSERT OR IGNORE INTO directional_record
                    (item_id, stimulus_word_id)
                VALUES (?, ?)
            ''', (item['id'], word['id']))
    db.commit()


def get_eligible_item_ids(db, pack_id, phase):
    """Get item IDs eligible for training based on current phase."""
    if phase == 1:
        # Phase 1: only items where ALL words are synthetic
        item_ids = [r['id'] for r in db.execute('''
            SELECT i.id FROM item i
            WHERE i.pack_id = ?
              AND NOT EXISTS (
                  SELECT 1 FROM word w WHERE w.item_id = i.id AND w.word_type != 'synthetic'
              )
              AND EXISTS (
                  SELECT 1 FROM word w WHERE w.item_id = i.id
              )
        ''', (pack_id,)).fetchall()]
    else:
        item_ids = [r['id'] for r in
                    db.execute('SELECT id FROM item WHERE pack_id = ?', (pack_id,)).fetchall()]
    return item_ids


def get_item_accuracies(db, pack_id, item_ids):
    """Calculate rolling accuracy (last MASTERY_WINDOW trials) for each item.
    Returns {item_id: {'accuracy': float, 'total': int, 'correct': int}}
    Items with no trials get accuracy 0.5 (neutral weight).
    """
    accuracies = {}
    for item_id in item_ids:
        trials = db.execute('''
            SELECT correct FROM trial_log
            WHERE item_id = ?
            ORDER BY id DESC LIMIT ?
        ''', (item_id, MASTERY_WINDOW)).fetchall()
        total = len(trials)
        if total == 0:
            accuracies[item_id] = {'accuracy': 0.5, 'total': 0, 'correct': 0}
        else:
            correct_count = sum(t['correct'] for t in trials)
            accuracies[item_id] = {
                'accuracy': correct_count / total,
                'total': total,
                'correct': correct_count,
            }
    return accuracies


def check_pack_mastery(accuracies):
    """Check if all items have reached mastery threshold.
    Returns True only if every item has >= MASTERY_THRESHOLD accuracy
    AND has at least MIN_TRIALS_FOR_MASTERY trials.
    """
    if not accuracies:
        return False
    for item_id, data in accuracies.items():
        if data['total'] < MIN_TRIALS_FOR_MASTERY:
            return False
        if data['accuracy'] < MASTERY_THRESHOLD:
            return False
    return True


def get_pack_accuracy(accuracies):
    """Get overall pack accuracy (average of all item accuracies, weighted by trial count)."""
    if not accuracies:
        return 0.0
    items_with_data = [d for d in accuracies.values() if d['total'] > 0]
    if not items_with_data:
        return 0.0
    total_correct = sum(d['correct'] for d in items_with_data)
    total_trials = sum(d['total'] for d in items_with_data)
    return total_correct / total_trials if total_trials > 0 else 0.0


def get_or_create_training_state(db, pack_id):
    """Get or create training_state row for a pack. Handles weekly reset."""
    row = db.execute('SELECT * FROM training_state WHERE pack_id = ?', (pack_id,)).fetchone()
    today = date.today()
    # Monday of current week
    week_start = (today - timedelta(days=today.weekday())).isoformat()

    if not row:
        db.execute('''INSERT INTO training_state
                      (pack_id, phase, mastered, session_count_this_week, week_start)
                      VALUES (?, 1, 0, 0, ?)''', (pack_id, week_start))
        db.commit()
        row = db.execute('SELECT * FROM training_state WHERE pack_id = ?', (pack_id,)).fetchone()
    elif row['week_start'] != week_start:
        # New week — reset session count and time
        db.execute('UPDATE training_state SET session_count_this_week = 0, total_seconds_this_week = 0, week_start = ? WHERE pack_id = ?',
                   (week_start, pack_id))
        db.commit()
        row = db.execute('SELECT * FROM training_state WHERE pack_id = ?', (pack_id,)).fetchone()
    return row


def get_next_trial(db, pack_id):
    """
    Pick the next item + direction for a training trial using accuracy-weighted selection.
    Returns a dict for the client, or None if the pack has no trainable items.
    Returns {'done': True} if session trial limit has been reached.

    Algorithm:
      - Items weighted by (1 - accuracy): weaker items appear more often
      - Direction chosen at random within the selected item
      - Choices shuffled server-side to prevent position-learning
    """
    # Get current training state
    ts = get_or_create_training_state(db, pack_id)
    current_phase = ts['phase']
    is_mastered = bool(ts['mastered'])

    # Check trial limit
    trial_count = session.get('trial_count', 0)
    trial_limit = REVIEW_TRIAL_LIMIT if is_mastered else ACTIVE_TRIAL_LIMIT
    if trial_count >= trial_limit:
        return {'done': True, 'trial_number': trial_count, 'trial_limit': trial_limit}

    # Get eligible items based on phase
    item_ids = get_eligible_item_ids(db, pack_id, current_phase)

    # If no synthetic items exist in phase 1, auto-advance to phase 2
    if current_phase == 1 and not item_ids:
        db.execute('UPDATE training_state SET phase = 2, phase_advanced_at = datetime(?) WHERE pack_id = ?',
                   (datetime.now().isoformat(), pack_id))
        db.commit()
        current_phase = 2
        item_ids = get_eligible_item_ids(db, pack_id, current_phase)

    if not item_ids:
        return None

    # Get accuracy data for weighting
    accuracies = get_item_accuracies(db, pack_id, item_ids)

    # Calculate selection weights: weaker items get higher weight
    weights = []
    for item_id in item_ids:
        acc = accuracies.get(item_id, {'accuracy': 0.5})['accuracy']
        weight = max(0.05, 1.0 - acc)
        weights.append(weight)

    # Weighted random item selection
    chosen_item_id = random.choices(item_ids, weights=weights, k=1)[0]

    # Pick a random direction (stimulus word) within the item
    words = db.execute(
        'SELECT id, label FROM word WHERE item_id = ?', (chosen_item_id,)
    ).fetchall()
    if not words:
        return None

    stimulus_word = random.choice(words)
    stimulus_word_id = stimulus_word['id']

    # Pick a random recording for the stimulus word
    recordings = db.execute(
        'SELECT * FROM recording WHERE word_id = ?', (stimulus_word_id,)
    ).fetchall()
    if not recordings:
        return None

    recording = random.choice(recordings)
    rec_filename = os.path.basename(recording['file_path'])

    # Shuffle choices (leakage prevention)
    choices = [{'word_id': w['id'], 'label': w['label']} for w in words]
    random.shuffle(choices)

    return {
        'item_id':          chosen_item_id,
        'stimulus_word_id': stimulus_word_id,
        'recording_id':     recording['id'],
        'recording_url':    url_for('static', filename=f'audio/{rec_filename}'),
        'choices':          choices,
        'phase':            current_phase,
        'trial_number':     trial_count + 1,
        'trial_limit':      trial_limit,
        'mastered':         is_mastered,
    }


# ── Home ─────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


# ── Superuser ────────────────────────────────────────────────────────────────

@app.route('/superuser/')
def su_index():
    db = get_db()
    packs = db.execute('SELECT * FROM pack ORDER BY created_at DESC').fetchall()
    db.close()
    return render_template('superuser/index.html', packs=packs)


@app.route('/superuser/import', methods=['POST'])
def su_import():
    if 'file' not in request.files or request.files['file'].filename == '':
        flash('No file selected.', 'error')
        return redirect(url_for('su_index'))

    f = request.files['file']
    try:
        data = json.load(f)
    except Exception:
        flash('Could not parse file — is it valid JSON?', 'error')
        return redirect(url_for('su_index'))

    errors = []
    name = (data.get('name') or '').strip()
    if not name:
        errors.append('Pack name is required.')

    items = data.get('items') or []
    if not items:
        errors.append('At least one item is required.')

    for idx, item in enumerate(items, 1):
        words = item.get('words') or []
        if len(words) < 2:
            errors.append(f'Item {idx}: needs at least 2 words.')
        non_empty = [w for w in words if isinstance(w, str) and w.strip()]
        if len(non_empty) != len(words):
            errors.append(f'Item {idx}: all words must be non-empty strings.')
        if len(set(w.strip() for w in non_empty)) != len(non_empty):
            errors.append(f'Item {idx}: duplicate word labels.')

    if errors:
        for e in errors:
            flash(e, 'error')
        return redirect(url_for('su_index'))

    db = get_db()
    if db.execute('SELECT id FROM pack WHERE name = ?', (name,)).fetchone():
        db.close()
        flash(f'A pack named "{name}" already exists. Delete it first, or import under a different name.', 'error')
        return redirect(url_for('su_index'))

    desc = (data.get('description') or '').strip() or None
    cur = db.execute('INSERT INTO pack (name, description, published) VALUES (?, ?, 0)',
                     (name, desc))
    pack_id = cur.lastrowid

    for item in items:
        cur2 = db.execute('INSERT INTO item (pack_id) VALUES (?)', (pack_id,))
        item_id = cur2.lastrowid
        # Detect word_type from notes field
        notes = (item.get('notes') or '').lower()
        if 'synthetic pair' in notes or notes.startswith('synthetic') or 'nonce pair' in notes or notes.startswith('nonce'):
            word_type = 'synthetic'
        elif 'real' in notes:
            word_type = 'real'
        elif 'mixed' in notes:
            word_type = 'mixed'
        else:
            word_type = 'real'
        for word_label in item['words']:
            db.execute('INSERT INTO word (item_id, label, word_type) VALUES (?, ?, ?)',
                       (item_id, word_label.strip(), word_type))

    db.commit()
    db.close()
    flash(f'Pack "{name}" imported successfully.', 'success')
    return redirect(url_for('su_pack', pack_id=pack_id))


@app.route('/superuser/pack/<int:pack_id>')
def su_pack(pack_id):
    db = get_db()
    pack = db.execute('SELECT * FROM pack WHERE id = ?', (pack_id,)).fetchone()
    if not pack:
        db.close()
        return 'Pack not found', 404

    raw_items = db.execute(
        'SELECT * FROM item WHERE pack_id = ? ORDER BY id', (pack_id,)
    ).fetchall()

    items_data = []
    all_have_recordings = True
    for item in raw_items:
        raw_words = db.execute(
            'SELECT * FROM word WHERE item_id = ? ORDER BY id', (item['id'],)
        ).fetchall()
        words_data = []
        for w in raw_words:
            cnt = db.execute(
                'SELECT COUNT(*) as c FROM recording WHERE word_id = ?', (w['id'],)
            ).fetchone()['c']
            if cnt == 0:
                all_have_recordings = False
            words_data.append({'id': w['id'], 'label': w['label'], 'rec_count': cnt})
        items_data.append({'id': item['id'], 'words': words_data})

    db.close()
    return render_template('superuser/pack.html',
                           pack=pack,
                           items=items_data,
                           all_have_recordings=all_have_recordings)


@app.route('/superuser/pack/<int:pack_id>/publish', methods=['POST'])
def su_publish(pack_id):
    db = get_db()
    pack = db.execute('SELECT * FROM pack WHERE id = ?', (pack_id,)).fetchone()
    if not pack:
        db.close()
        return 'Not found', 404

    if pack['published']:
        db.execute('UPDATE pack SET published = 0 WHERE id = ?', (pack_id,))
        db.commit()
        db.close()
        flash('Pack unpublished.', 'success')
    else:
        missing = db.execute('''
            SELECT COUNT(*) as c FROM word w
            JOIN item i ON i.id = w.item_id
            WHERE i.pack_id = ?
              AND NOT EXISTS (SELECT 1 FROM recording r WHERE r.word_id = w.id)
        ''', (pack_id,)).fetchone()['c']

        if missing > 0:
            db.close()
            flash(f'Cannot publish: {missing} word(s) still have no recordings.', 'error')
        else:
            db.execute('UPDATE pack SET published = 1 WHERE id = ?', (pack_id,))
            db.commit()
            db.close()
            flash('Pack published.', 'success')

    return redirect(url_for('su_pack', pack_id=pack_id))


@app.route('/superuser/pack/<int:pack_id>/delete', methods=['POST'])
def su_delete_pack(pack_id):
    db = get_db()
    recs = db.execute('''
        SELECT r.file_path FROM recording r
        JOIN word w ON w.id = r.word_id
        JOIN item i ON i.id = w.item_id
        WHERE i.pack_id = ?
    ''', (pack_id,)).fetchall()
    for rec in recs:
        try:
            os.remove(rec['file_path'])
        except OSError:
            pass
    db.execute('DELETE FROM pack WHERE id = ?', (pack_id,))
    db.commit()
    db.close()
    flash('Pack deleted.', 'success')
    return redirect(url_for('su_index'))


@app.route('/superuser/item/<int:item_id>/delete', methods=['POST'])
def su_delete_item(item_id):
    db = get_db()
    item = db.execute('SELECT * FROM item WHERE id = ?', (item_id,)).fetchone()
    if not item:
        db.close()
        return 'Not found', 404
    pack_id = item['pack_id']

    recs = db.execute('''
        SELECT r.file_path FROM recording r
        JOIN word w ON w.id = r.word_id
        WHERE w.item_id = ?
    ''', (item_id,)).fetchall()
    for rec in recs:
        try:
            os.remove(rec['file_path'])
        except OSError:
            pass

    db.execute('DELETE FROM item WHERE id = ?', (item_id,))
    db.commit()

    # Unpublish pack if it has no items left
    remaining = db.execute(
        'SELECT COUNT(*) as c FROM item WHERE pack_id = ?', (pack_id,)
    ).fetchone()['c']
    if remaining == 0:
        db.execute('UPDATE pack SET published = 0 WHERE id = ?', (pack_id,))
        db.commit()
        flash('Item deleted. Pack has no items remaining and has been unpublished.', 'success')
    else:
        flash('Item deleted. Training progress for this item has been cleared.', 'success')

    db.close()
    return redirect(url_for('su_pack', pack_id=pack_id))


@app.route('/superuser/word/<int:word_id>')
def su_word(word_id):
    db = get_db()
    word = db.execute('''
        SELECT w.*, i.pack_id, i.id as item_id FROM word w
        JOIN item i ON i.id = w.item_id
        WHERE w.id = ?
    ''', (word_id,)).fetchone()
    if not word:
        db.close()
        return 'Not found', 404

    recordings = db.execute(
        'SELECT * FROM recording WHERE word_id = ? ORDER BY created_at', (word_id,)
    ).fetchall()
    pack = db.execute('SELECT * FROM pack WHERE id = ?', (word['pack_id'],)).fetchone()

    # Sibling words in the same item (for context)
    siblings = db.execute(
        'SELECT id, label FROM word WHERE item_id = ? ORDER BY id', (word['item_id'],)
    ).fetchall()

    db.close()
    return render_template('superuser/word.html',
                           word=word, recordings=recordings,
                           pack=pack, siblings=siblings)


@app.route('/superuser/word/<int:word_id>/record', methods=['POST'])
def su_save_recording(word_id):
    db = get_db()
    word = db.execute('SELECT id FROM word WHERE id = ?', (word_id,)).fetchone()
    if not word:
        db.close()
        return jsonify({'error': 'Not found'}), 404

    if 'audio' not in request.files:
        db.close()
        return jsonify({'error': 'No audio data'}), 400

    audio_file = request.files['audio']
    speaker_label = (request.form.get('speaker_label') or '').strip() or None

    ct = audio_file.content_type or ''
    if 'ogg' in ct:
        ext = 'ogg'
    elif 'mp4' in ct or 'm4a' in ct:
        ext = 'm4a'
    else:
        ext = 'webm'

    ts = int(datetime.now().timestamp() * 1000)
    filename = f'rec_{word_id}_{ts}.{ext}'
    filepath = os.path.join(AUDIO_DIR, filename)
    audio_file.save(filepath)

    cur = db.execute(
        'INSERT INTO recording (word_id, file_path, speaker_label) VALUES (?, ?, ?)',
        (word_id, filepath, speaker_label)
    )
    rec_id = cur.lastrowid
    db.commit()
    db.close()

    return jsonify({
        'id': rec_id,
        'url': url_for('static', filename=f'audio/{filename}'),
        'speaker_label': speaker_label,
    })


@app.route('/superuser/recording/<int:rec_id>/delete', methods=['POST'])
def su_delete_recording(rec_id):
    db = get_db()
    rec = db.execute('''
        SELECT r.*, w.id as word_id, w.item_id, i.pack_id
        FROM recording r
        JOIN word w ON w.id = r.word_id
        JOIN item i ON i.id = w.item_id
        WHERE r.id = ?
    ''', (rec_id,)).fetchone()
    if not rec:
        db.close()
        return 'Not found', 404

    word_id = rec['word_id']
    back = request.form.get('back', url_for('su_word', word_id=word_id))

    try:
        os.remove(rec['file_path'])
    except OSError:
        pass

    db.execute('DELETE FROM recording WHERE id = ?', (rec_id,))
    db.commit()
    db.close()
    return redirect(back)


@app.route('/superuser/pack/<int:pack_id>/session')
def su_session(pack_id):
    db = get_db()
    pack = db.execute('SELECT * FROM pack WHERE id = ?', (pack_id,)).fetchone()
    if not pack:
        db.close()
        return 'Not found', 404
    speakers = [dict(s) for s in
                db.execute('SELECT * FROM speaker ORDER BY name').fetchall()]
    db.close()
    return render_template('superuser/session.html', pack=pack, speakers=speakers)


# ── Speaker API ───────────────────────────────────────────────────────────────

@app.route('/api/speakers')
def api_speakers():
    db = get_db()
    speakers = [dict(s) for s in
                db.execute('SELECT * FROM speaker ORDER BY name').fetchall()]
    db.close()
    return jsonify(speakers)


@app.route('/api/speaker/create', methods=['POST'])
def api_create_speaker():
    data = request.get_json(force=True)
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'Name is required'}), 400
    db = get_db()
    existing = db.execute('SELECT * FROM speaker WHERE name = ?', (name,)).fetchone()
    if existing:
        db.close()
        return jsonify({'error': 'Name already exists', 'id': existing['id'],
                        'name': existing['name']}), 409
    cur = db.execute('INSERT INTO speaker (name) VALUES (?)', (name,))
    db.commit()
    speaker = db.execute('SELECT * FROM speaker WHERE id = ?', (cur.lastrowid,)).fetchone()
    db.close()
    return jsonify(dict(speaker))


@app.route('/api/speaker/<int:speaker_id>/delete', methods=['POST'])
def api_delete_speaker(speaker_id):
    db = get_db()
    db.execute('DELETE FROM speaker WHERE id = ?', (speaker_id,))
    db.commit()
    db.close()
    return jsonify({'ok': True})


@app.route('/api/session-queue/<int:pack_id>')
def api_session_queue(pack_id):
    """Return prioritised word queue for a recording session.
    Tier 1 — words with zero recordings (any speaker).
    Tier 2 — words with recordings but none from the given speaker.
    Words already recorded by this speaker are excluded.
    """
    speaker_name = request.args.get('speaker', '').strip()
    db = get_db()
    words = db.execute('''
        SELECT w.id, w.label,
               (SELECT COUNT(*) FROM recording r WHERE r.word_id = w.id)               AS total_recs,
               (SELECT COUNT(*) FROM recording r WHERE r.word_id = w.id
                AND r.speaker_label = ?)                                               AS my_recs
        FROM word w
        JOIN item i ON i.id = w.item_id
        WHERE i.pack_id = ?
        ORDER BY i.id, w.id
    ''', (speaker_name, pack_id)).fetchall()
    db.close()

    tier1 = [dict(w) | {'tier': 1} for w in words if w['total_recs'] == 0]
    tier2 = [dict(w) | {'tier': 2} for w in words
             if w['total_recs'] > 0 and w['my_recs'] == 0]
    return jsonify(tier1 + tier2)


# ── Browse Mode ──────────────────────────────────────────────────────────────

@app.route('/superuser/browse')
def su_browse():
    db = get_db()
    packs = db.execute('SELECT * FROM pack ORDER BY name').fetchall()
    speaker_labels = [r['speaker_label'] for r in db.execute(
        'SELECT DISTINCT speaker_label FROM recording WHERE speaker_label IS NOT NULL ORDER BY speaker_label'
    ).fetchall()]
    db.close()
    return render_template('superuser/browse.html', packs=packs, speaker_labels=speaker_labels)


@app.route('/api/browse/data')
def api_browse_data():
    pack_id_filter = request.args.get('pack_id', type=int)
    db = get_db()
    if pack_id_filter:
        items = db.execute('''
            SELECT i.*, p.name as pack_name, p.published as pack_published
            FROM item i JOIN pack p ON p.id = i.pack_id
            WHERE i.pack_id = ? ORDER BY i.id
        ''', (pack_id_filter,)).fetchall()
    else:
        items = db.execute('''
            SELECT i.*, p.name as pack_name, p.published as pack_published
            FROM item i JOIN pack p ON p.id = i.pack_id
            ORDER BY p.name, i.id
        ''').fetchall()

    # Get per-item accuracy data
    all_item_ids = [item['id'] for item in items]
    item_accuracies = get_item_accuracies(db, 0, all_item_ids) if all_item_ids else {}

    result = []
    for item in items:
        words = db.execute(
            'SELECT * FROM word WHERE item_id = ? ORDER BY id', (item['id'],)
        ).fetchall()
        words_data = []
        for w in words:
            recs = db.execute(
                'SELECT * FROM recording WHERE word_id = ? ORDER BY created_at', (w['id'],)
            ).fetchall()
            speakers = sorted({r['speaker_label'] for r in recs if r['speaker_label']})
            words_data.append({
                'id': w['id'],
                'label': w['label'],
                'word_type': w['word_type'] if 'word_type' in w.keys() else 'real',
                'rec_count': len(recs),
                'speakers': speakers,
                'recordings': [{
                    'id': r['id'],
                    'speaker_label': r['speaker_label'],
                    'created_at': (r['created_at'] or '')[:10],
                    'url': url_for('static', filename=f'audio/{os.path.basename(r["file_path"])}')
                } for r in recs]
            })
        acc_data = item_accuracies.get(item['id'], {'accuracy': None, 'total': 0, 'correct': 0})
        result.append({
            'id': item['id'],
            'pack_id': item['pack_id'],
            'pack_name': item['pack_name'],
            'pack_published': bool(item['pack_published']),
            'words': words_data,
            'accuracy': round(acc_data['accuracy'] * 100) if acc_data['accuracy'] is not None and acc_data['total'] > 0 else None,
            'accuracy_trials': acc_data['total'],
        })
    db.close()
    return jsonify(result)


@app.route('/api/word/<int:word_id>/rename', methods=['POST'])
def api_rename_word(word_id):
    data = request.get_json(force=True)
    new_label = (data.get('label') or '').strip()
    if not new_label:
        return jsonify({'error': 'Label cannot be empty'}), 400
    db = get_db()
    word = db.execute('''
        SELECT w.*, i.pack_id, i.id as item_id FROM word w
        JOIN item i ON i.id = w.item_id WHERE w.id = ?
    ''', (word_id,)).fetchone()
    if not word:
        db.close()
        return jsonify({'error': 'Not found'}), 404
    dup = db.execute(
        'SELECT id FROM word WHERE item_id = ? AND label = ? AND id != ?',
        (word['item_id'], new_label, word_id)
    ).fetchone()
    if dup:
        db.close()
        return jsonify({'error': 'A word with that label already exists in this item'}), 409
    db.execute('UPDATE word SET label = ? WHERE id = ?', (new_label, word_id))
    db.commit()
    db.close()
    return jsonify({'ok': True, 'label': new_label})


@app.route('/api/word/<int:word_id>/type', methods=['POST'])
def api_set_word_type(word_id):
    data = request.get_json(force=True)
    word_type = data.get('word_type', 'real')
    if word_type not in ('real', 'synthetic', 'mixed'):
        return jsonify({'error': 'Invalid word_type'}), 400
    db = get_db()
    db.execute('UPDATE word SET word_type = ? WHERE id = ?', (word_type, word_id))
    db.commit()
    db.close()
    return jsonify({'ok': True, 'word_type': word_type})


@app.route('/api/word/<int:word_id>/delete', methods=['POST'])
def api_delete_word(word_id):
    db = get_db()
    word = db.execute('''
        SELECT w.*, i.pack_id, i.id as item_id FROM word w
        JOIN item i ON i.id = w.item_id WHERE w.id = ?
    ''', (word_id,)).fetchone()
    if not word:
        db.close()
        return jsonify({'error': 'Not found'}), 404

    item_id = word['item_id']
    pack_id = word['pack_id']

    # Delete this word's audio files from disk
    for rec in db.execute('SELECT file_path FROM recording WHERE word_id = ?', (word_id,)).fetchall():
        try: os.remove(rec['file_path'])
        except OSError: pass

    db.execute('DELETE FROM word WHERE id = ?', (word_id,))
    db.commit()

    # If fewer than 2 words remain the item is no longer a valid minimal pair — delete it
    remaining = db.execute('SELECT id FROM word WHERE item_id = ?', (item_id,)).fetchall()
    item_deleted = False
    if len(remaining) < 2:
        for lone in remaining:
            for rec in db.execute('SELECT file_path FROM recording WHERE word_id = ?', (lone['id'],)).fetchall():
                try: os.remove(rec['file_path'])
                except OSError: pass
        db.execute('DELETE FROM item WHERE id = ?', (item_id,))
        db.commit()
        item_deleted = True

    # Unpublish pack if published and now has unrecorded words
    pack_unpublished = False
    pack = db.execute('SELECT published FROM pack WHERE id = ?', (pack_id,)).fetchone()
    if pack and pack['published']:
        missing = db.execute('''
            SELECT COUNT(*) as c FROM word w JOIN item i ON i.id = w.item_id
            WHERE i.pack_id = ? AND NOT EXISTS (SELECT 1 FROM recording r WHERE r.word_id = w.id)
        ''', (pack_id,)).fetchone()['c']
        if missing > 0:
            db.execute('UPDATE pack SET published = 0 WHERE id = ?', (pack_id,))
            db.commit()
            pack_unpublished = True

    db.close()
    return jsonify({'ok': True, 'item_deleted': item_deleted, 'pack_unpublished': pack_unpublished})


@app.route('/api/recording/<int:rec_id>/delete', methods=['POST'])
def api_delete_recording_json(rec_id):
    db = get_db()
    rec = db.execute('''
        SELECT r.*, w.id as word_id, w.item_id, i.pack_id
        FROM recording r JOIN word w ON w.id = r.word_id JOIN item i ON i.id = w.item_id
        WHERE r.id = ?
    ''', (rec_id,)).fetchone()
    if not rec:
        db.close()
        return jsonify({'error': 'Not found'}), 404
    try: os.remove(rec['file_path'])
    except OSError: pass
    db.execute('DELETE FROM recording WHERE id = ?', (rec_id,))
    db.commit()
    db.close()
    return jsonify({'ok': True})


# ── End User ─────────────────────────────────────────────────────────────────

@app.route('/user/')
def user_index():
    db = get_db()
    packs = db.execute('SELECT * FROM pack WHERE published = 1 ORDER BY name').fetchall()
    packs_data = []
    for p in packs:
        cnt = db.execute(
            'SELECT COUNT(*) as c FROM item WHERE pack_id = ?', (p['id'],)
        ).fetchone()['c']
        ts = get_or_create_training_state(db, p['id'])
        is_mastered = bool(ts['mastered'])
        total_stats = db.execute(
            'SELECT COUNT(*) as total, SUM(correct) as correct_count FROM trial_log WHERE pack_id = ?',
            (p['id'],)).fetchone()
        packs_data.append({
            'id': p['id'], 'name': p['name'],
            'description': p['description'], 'item_count': cnt,
            'phase': ts['phase'],
            'mastered': is_mastered,
            'sessions_this_week': ts['session_count_this_week'],
            'minutes_this_week': round(ts['total_seconds_this_week'] / 60),
            'total_trials': total_stats['total'] or 0,
            'session_target': 1 if is_mastered else 2,
            'mode': 'Review' if is_mastered else 'Active',
        })
    db.close()
    return render_template('user/index.html', packs=packs_data)


@app.route('/user/train/<int:pack_id>')
def user_train(pack_id):
    db = get_db()
    pack = db.execute(
        'SELECT * FROM pack WHERE id = ? AND published = 1', (pack_id,)
    ).fetchone()
    if not pack:
        db.close()
        return redirect(url_for('user_index'))

    ensure_directional_records(db, pack_id)
    ts = get_or_create_training_state(db, pack_id)
    is_mastered = bool(ts['mastered'])
    trial_limit = REVIEW_TRIAL_LIMIT if is_mastered else ACTIVE_TRIAL_LIMIT
    db.close()

    session['trial_count'] = 0
    session['session_correct'] = 0
    session['current_pack'] = pack_id
    return render_template('user/train.html', pack=pack, phase=ts['phase'],
                           mastered=is_mastered, trial_limit=trial_limit)


# ── Training API ─────────────────────────────────────────────────────────────

@app.route('/api/trial/<int:pack_id>')
def api_get_trial(pack_id):
    db = get_db()
    trial = get_next_trial(db, pack_id)
    db.close()
    if trial is None:
        return jsonify({'done': True})
    return jsonify(trial)


@app.route('/api/trial', methods=['POST'])
def api_submit_trial():
    data = request.get_json(force=True)
    item_id          = data['item_id']
    stimulus_word_id = data['stimulus_word_id']
    recording_id     = data['recording_id']
    response_word_id = data['response_word_id']
    response_time_ms = data.get('response_time_ms')

    correct = (stimulus_word_id == response_word_id)

    db = get_db()
    item = db.execute('SELECT pack_id FROM item WHERE id = ?', (item_id,)).fetchone()
    pack_id = item['pack_id']

    # Log trial
    db.execute('''
        INSERT INTO trial_log
            (item_id, pack_id, stimulus_word_id, recording_id,
             response_word_id, correct, response_time_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', (item_id, pack_id, stimulus_word_id, recording_id,
          response_word_id, 1 if correct else 0, response_time_ms))

    # Update last_reviewed_at on directional record
    db.execute('''
        UPDATE directional_record
           SET last_reviewed_at = datetime('now')
         WHERE item_id = ? AND stimulus_word_id = ?
    ''', (item_id, stimulus_word_id))

    # Increment session trial count and track session accuracy
    trial_count = session.get('trial_count', 0) + 1
    session['trial_count'] = trial_count
    session_correct = session.get('session_correct', 0) + (1 if correct else 0)
    session['session_correct'] = session_correct

    # ── Check for phase advancement and mastery ───────────────────────────
    ts = get_or_create_training_state(db, pack_id)
    phase_advanced = False
    pack_mastered = False
    new_phase = ts['phase']
    was_mastered = bool(ts['mastered'])

    # Get eligible items and their accuracies
    item_ids = get_eligible_item_ids(db, pack_id, ts['phase'])
    accuracies = get_item_accuracies(db, pack_id, item_ids)

    if ts['phase'] == 1:
        # Phase 1 → 2: all synthetic items at mastery threshold
        if check_pack_mastery(accuracies):
            new_phase = 2
            db.execute('UPDATE training_state SET phase = 2, phase_advanced_at = datetime(?) WHERE pack_id = ?',
                       (datetime.now().isoformat(), pack_id))
            phase_advanced = True
            # Recalculate with full pool for mastery check below
            item_ids = get_eligible_item_ids(db, pack_id, 2)
            accuracies = get_item_accuracies(db, pack_id, item_ids)

    # Check pack mastery (all items in current pool at threshold)
    if not was_mastered and check_pack_mastery(accuracies):
        pack_mastered = True
        db.execute('UPDATE training_state SET mastered = 1, mastered_at = datetime(?) WHERE pack_id = ?',
                   (datetime.now().isoformat(), pack_id))

    # Check mastery loss during review
    if was_mastered and not pack_mastered:
        pack_acc = get_pack_accuracy(accuracies)
        if pack_acc < MASTERY_LOSS_THRESHOLD:
            db.execute('UPDATE training_state SET mastered = 0, mastered_at = NULL WHERE pack_id = ?',
                       (pack_id,))
            was_mastered = False

    trial_limit = REVIEW_TRIAL_LIMIT if (was_mastered or pack_mastered) else ACTIVE_TRIAL_LIMIT

    # Discrimination phase data: one random recording per word
    words = db.execute(
        'SELECT id, label FROM word WHERE item_id = ? ORDER BY id', (item_id,)
    ).fetchall()
    discrimination = []
    for w in words:
        rec = db.execute(
            'SELECT * FROM recording WHERE word_id = ? ORDER BY RANDOM() LIMIT 1',
            (w['id'],)
        ).fetchone()
        rec_url = None
        if rec:
            fname = os.path.basename(rec['file_path'])
            rec_url = url_for('static', filename=f'audio/{fname}')
        discrimination.append({
            'word_id': w['id'],
            'label':   w['label'],
            'recording_url': rec_url,
        })

    # Per-item accuracy (rolling last 20) for the item just answered
    item_acc_data = get_item_accuracies(db, pack_id, [item_id])
    item_acc = item_acc_data.get(item_id, {'accuracy': 0.5, 'total': 0, 'correct': 0})

    db.commit()
    db.close()

    result = {
        'correct':          correct,
        'stimulus_word_id': stimulus_word_id,
        'discrimination':   discrimination,
        'phase':            new_phase,
        'trial_number':     trial_count,
        'trial_limit':      trial_limit,
        'session_correct':  session_correct,
        'session_total':    trial_count,
        'item_accuracy':    round(item_acc['accuracy'] * 100) if item_acc['total'] > 0 else None,
        'item_accuracy_trials': item_acc['total'],
    }
    if phase_advanced:
        result['phase_advanced'] = True
        result['new_phase'] = new_phase
    if pack_mastered:
        result['pack_mastered'] = True
    return jsonify(result)


# ── Session tracking + Reset ─────────────────────────────────────────────────

@app.route('/api/end-session', methods=['POST'])
def api_end_session():
    """Record that a training session has ended. Counts session if >= 5 min."""
    data = request.get_json(force=True)
    pack_id = data['pack_id']
    elapsed_seconds = data.get('elapsed_seconds', 0)

    db = get_db()
    ts = get_or_create_training_state(db, pack_id)
    today = date.today().isoformat()

    new_total_secs = ts['total_seconds_this_week'] + elapsed_seconds
    updates = {
        'last_session_date': today,
        'last_session_seconds': elapsed_seconds,
        'total_seconds_this_week': new_total_secs,
    }
    if elapsed_seconds >= 300:  # 5 minutes = counts as a session
        updates['session_count_this_week'] = ts['session_count_this_week'] + 1

    set_clause = ', '.join(f'{k} = ?' for k in updates)
    db.execute(f'UPDATE training_state SET {set_clause} WHERE pack_id = ?',
               list(updates.values()) + [pack_id])
    db.commit()
    db.close()
    return jsonify({'ok': True, 'session_counted': elapsed_seconds >= 300})


@app.route('/api/reset-progress/<int:pack_id>', methods=['POST'])
def api_reset_progress(pack_id):
    """Reset all training progress and state for a pack."""
    db = get_db()
    # Delete directional records
    item_ids = [r['id'] for r in
                db.execute('SELECT id FROM item WHERE pack_id = ?', (pack_id,)).fetchall()]
    if item_ids:
        ph = ','.join('?' * len(item_ids))
        db.execute(f'DELETE FROM directional_record WHERE item_id IN ({ph})', item_ids)
    # Delete trial logs
    db.execute('DELETE FROM trial_log WHERE pack_id = ?', (pack_id,))
    # Reset training state
    db.execute('DELETE FROM training_state WHERE pack_id = ?', (pack_id,))
    db.commit()
    db.close()
    return jsonify({'ok': True})


@app.route('/api/training-state/<int:pack_id>')
def api_training_state(pack_id):
    """Get current phase + schedule + mastery info for a pack."""
    db = get_db()
    ts = get_or_create_training_state(db, pack_id)
    is_mastered = bool(ts['mastered'])

    # Count total trials + accuracy for progress display
    stats = db.execute('''
        SELECT COUNT(*) as total, SUM(correct) as correct_count
        FROM trial_log WHERE pack_id = ?
    ''', (pack_id,)).fetchone()

    # Per-item accuracy for browse display
    item_ids = get_eligible_item_ids(db, pack_id, ts['phase'])
    accuracies = get_item_accuracies(db, pack_id, item_ids)

    db.close()
    return jsonify({
        'phase': ts['phase'],
        'phase_advanced_at': ts['phase_advanced_at'],
        'mastered': is_mastered,
        'mastered_at': ts['mastered_at'],
        'session_count_this_week': ts['session_count_this_week'],
        'week_start': ts['week_start'],
        'last_session_date': ts['last_session_date'],
        'total_trials': stats['total'] or 0,
        'total_correct': stats['correct_count'] or 0,
        'trial_limit': REVIEW_TRIAL_LIMIT if is_mastered else ACTIVE_TRIAL_LIMIT,
        'item_accuracies': {str(k): v for k, v in accuracies.items()},
    })


# ── Remote Recording ─────────────────────────────────────────────────────────

@app.route('/recorder')
def recorder_page():
    """Serve the self-contained speaker recorder page (also deployable to GitHub Pages)."""
    return send_from_directory(
        os.path.join(app.static_folder, 'recorder'), 'index.html'
    )


@app.route('/superuser/pack/<int:pack_id>/export-session')
def su_export_session(pack_id):
    db = get_db()
    pack = db.execute('SELECT * FROM pack WHERE id = ?', (pack_id,)).fetchone()
    if not pack:
        db.close()
        return 'Pack not found', 404

    words = db.execute('''
        SELECT w.id AS word_id, w.label AS word_label, i.id AS item_id
        FROM word w
        JOIN item i ON i.id = w.item_id
        WHERE i.pack_id = ?
        ORDER BY i.id, w.id
    ''', (pack_id,)).fetchall()
    db.close()

    # Build item labels from their words: "കര / കറ"
    from collections import defaultdict
    item_word_map = defaultdict(list)
    for w in words:
        item_word_map[w['item_id']].append(w['word_label'])
    item_labels = {iid: ' / '.join(lbls) for iid, lbls in item_word_map.items()}

    session_id = f"sess_{int(datetime.now().timestamp())}_{uuid.uuid4().hex[:6]}"

    manifest = {
        'session_id':  session_id,
        'pack_id':     pack_id,
        'pack_name':   pack['name'],
        'exported_at': datetime.now().isoformat(),
        'words': [
            {
                'word_id':    w['word_id'],
                'word_label': w['word_label'],
                'item_id':    w['item_id'],
                'item_label': item_labels.get(w['item_id'], f'Item {w["item_id"]}'),
            }
            for w in words
        ],
    }

    # Upload manifest to GitHub so the recorder can fetch it by session ID
    import subprocess
    manifest_json = json.dumps(manifest, ensure_ascii=False, indent=2)
    manifest_b64  = base64.b64encode(manifest_json.encode('utf-8')).decode('ascii')

    gh_repo  = 'kjcmtq2h8j-hue/minimal-pairs'
    gh_path  = f'sessions/{session_id}.json'

    upload_err = None
    try:
        # Write manifest to a temp file, commit via gh CLI (avoids SSL issues)
        import tempfile, os
        tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
        tmp.write(manifest_json)
        tmp.close()
        # Use gh api to upload
        req_body = json.dumps({
            'message': f'Add recording session for {pack["name"]}',
            'content': manifest_b64,
        })
        result = subprocess.run(
            [os.path.expanduser('~/.local/bin/gh'), 'api',
             f'repos/{gh_repo}/contents/{gh_path}',
             '-X', 'PUT',
             '--input', '-'],
            input=req_body, capture_output=True, text=True, timeout=30
        )
        os.unlink(tmp.name)
        if result.returncode != 0:
            raise Exception(result.stderr.strip() or f'gh exited with code {result.returncode}')
    except Exception as e:
        upload_err = str(e)

    public_url = f'https://kjcmtq2h8j-hue.github.io/minimal-pairs/static/recorder/#{session_id}'
    local_url  = url_for('recorder_page', _external=True) + '#' + session_id

    return render_template('superuser/export_session.html',
                           pack=pack,
                           session_id=session_id,
                           local_url=local_url,
                           public_url=public_url,
                           upload_err=upload_err,
                           word_count=len(words))


@app.route('/superuser/import-recordings')
def su_import_recordings_page():
    db = get_db()
    packs = db.execute('SELECT id, name FROM pack ORDER BY name').fetchall()
    db.close()
    return render_template('superuser/import_recordings.html', packs=packs)


@app.route('/api/import-recordings', methods=['POST'])
def api_import_recordings():
    if 'zip_file' not in request.files or request.files['zip_file'].filename == '':
        return jsonify({'error': 'No zip file uploaded'}), 400

    zip_bytes    = request.files['zip_file'].read()
    speaker_override = (request.form.get('speaker_name') or '').strip()

    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            names = zf.namelist()

            # ── Read manifest ─────────────────────────────────────────────
            if 'manifest.json' not in names:
                return jsonify({'error': 'zip does not contain manifest.json'}), 400

            manifest = json.loads(zf.read('manifest.json'))
            words_by_id = {w['word_id']: w for w in manifest.get('words', [])}
            speaker_name = speaker_override or manifest.get('speaker_name') or 'Unknown'
            session_id   = manifest.get('session_id', '')

            db = get_db()

            # ── Guard: block re-import of the same session ────────────────
            if session_id:
                already = db.execute(
                    'SELECT COUNT(*) FROM recording WHERE session_id = ?', (session_id,)
                ).fetchone()[0]
                if already:
                    db.close()
                    return jsonify({
                        'error': f'This recording session has already been imported '
                                 f'({already} recording(s) on file). '
                                 f'To re-import, first delete the existing recordings in Browse mode.'
                    }), 409

            imported, skipped, errors = 0, 0, []

            for filename in names:
                if filename == 'manifest.json':
                    continue
                stem, _, ext = filename.rpartition('.')
                ext = ext.lower()
                if ext not in ('webm', 'ogg', 'mp4', 'm4a', 'wav'):
                    continue  # ignore non-audio files

                # Filename pattern: word_<id>.<ext>
                try:
                    parts  = stem.split('_')
                    word_id = int(parts[1])
                except (IndexError, ValueError):
                    errors.append(f'Skipped "{filename}" — could not parse word ID')
                    continue

                if word_id not in words_by_id:
                    errors.append(f'Skipped "{filename}" — word ID {word_id} not in manifest')
                    continue

                # Check word exists in DB
                word_row = db.execute('SELECT id FROM word WHERE id = ?', (word_id,)).fetchone()
                if not word_row:
                    errors.append(f'Skipped word {word_id} — not found in database')
                    skipped += 1
                    continue

                # Save audio file to AUDIO_DIR
                audio_data  = zf.read(filename)
                ts          = int(datetime.now().timestamp() * 1000)
                safe_ext    = ext if ext in ('webm', 'ogg', 'mp4', 'm4a', 'wav') else 'webm'
                new_filename = f'rec_{word_id}_{ts}_{uuid.uuid4().hex[:6]}.{safe_ext}'
                filepath     = os.path.join(AUDIO_DIR, new_filename)

                with open(filepath, 'wb') as f:
                    f.write(audio_data)

                db.execute(
                    'INSERT INTO recording (word_id, file_path, speaker_label, session_id, created_at) VALUES (?, ?, ?, ?, ?)',
                    (word_id, filepath, speaker_name, session_id, datetime.now().isoformat())
                )
                db.commit()
                imported += 1

            db.close()

    except zipfile.BadZipFile:
        return jsonify({'error': 'File is not a valid zip archive'}), 400
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    return jsonify({
        'imported': imported,
        'skipped':  skipped,
        'errors':   errors,
        'speaker':  speaker_name,
    })


# ── Entry point ──────────────────────────────────────────────────────────────

if __name__ == '__main__':
    init_db()
    app.run(debug=True, port=5001)
