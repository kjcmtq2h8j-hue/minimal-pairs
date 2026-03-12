import os
import json
import random
from datetime import datetime, date, timedelta

from flask import (Flask, render_template, request, redirect,
                   url_for, jsonify, session, flash)

from database import get_db, init_db

app = Flask(__name__)
app.secret_key = 'minimal-pairs-local-secret-2024'

AUDIO_DIR = os.path.join(app.static_folder, 'audio')
os.makedirs(AUDIO_DIR, exist_ok=True)

# ── SRS constants ────────────────────────────────────────────────────────────
MASTERY_INTERVAL = 21   # days; item is mastered when all directions reach this
INITIAL_EASE = 2.5
MIN_EASE = 1.3


def sm2_update(interval, ease, repetitions, correct):
    """SM-2 derivative. Returns (new_interval, new_ease, new_repetitions)."""
    if correct:
        if repetitions == 0:
            new_interval = 1
        elif repetitions == 1:
            new_interval = 6
        else:
            new_interval = max(1, round(interval * ease))
        new_ease = max(MIN_EASE, ease + 0.1)
        new_repetitions = repetitions + 1
    else:
        new_interval = 1
        new_ease = max(MIN_EASE, ease - 0.2)
        new_repetitions = 0
    return new_interval, new_ease, new_repetitions


def ensure_directional_records(db, pack_id):
    """Create any missing directional records for a pack (called at session start)."""
    items = db.execute('SELECT id FROM item WHERE pack_id = ?', (pack_id,)).fetchall()
    for item in items:
        words = db.execute('SELECT id FROM word WHERE item_id = ?', (item['id'],)).fetchall()
        for word in words:
            db.execute('''
                INSERT OR IGNORE INTO directional_record
                    (item_id, stimulus_word_id, srs_interval, srs_ease, srs_due_date, srs_repetitions)
                VALUES (?, ?, 1, 2.5, date('now'), 0)
            ''', (item['id'], word['id']))
    db.commit()


def get_next_trial(db, pack_id):
    """
    Pick the next item + direction for a training trial.
    Returns a dict for the client, or None if the pack has no trainable items.
    SRS leakage prevention:
      - direction chosen randomly at trial time (weighted by weakness)
      - choices shuffled server-side
    """
    today = date.today().isoformat()

    item_ids = [r['id'] for r in
                db.execute('SELECT id FROM item WHERE pack_id = ?', (pack_id,)).fetchall()]
    if not item_ids:
        return None

    ph = ','.join('?' * len(item_ids))

    # All directional records for this pack, ordered by due date ascending
    all_records = db.execute(f'''
        SELECT dr.*
        FROM directional_record dr
        WHERE dr.item_id IN ({ph})
        ORDER BY dr.srs_due_date ASC
    ''', item_ids).fetchall()

    if not all_records:
        return None

    # Due = overdue or due today
    due = [r for r in all_records if r['srs_due_date'] <= today]
    if not due:
        # Nothing strictly due — surface the earliest upcoming item so sessions
        # are never completely empty
        due = [all_records[0]]

    # Group by item_id
    due_by_item: dict[int, list] = {}
    for r in due:
        due_by_item.setdefault(r['item_id'], []).append(r)

    # Avoid repeating items already seen this session
    seen = session.get('shown_items', [])
    available = {k: v for k, v in due_by_item.items() if k not in seen}
    if not available:
        # All due items have been shown this pass — reset and loop
        session['shown_items'] = []
        available = due_by_item

    chosen_item_id = random.choice(list(available.keys()))
    directions = available[chosen_item_id]

    # Weighted random direction: lower ease → higher weight (weaker direction)
    weights = [1.0 / r['srs_ease'] for r in directions]
    total_w = sum(weights)
    norm_weights = [w / total_w for w in weights]
    chosen_dir = random.choices(directions, weights=norm_weights, k=1)[0]
    stimulus_word_id = chosen_dir['stimulus_word_id']

    # Pick a random recording for the stimulus word
    recordings = db.execute(
        'SELECT * FROM recording WHERE word_id = ?', (stimulus_word_id,)
    ).fetchall()
    if not recordings:
        return None

    recording = random.choice(recordings)
    rec_filename = os.path.basename(recording['file_path'])

    # All words in the item (shuffled — leakage prevention)
    words = db.execute(
        'SELECT id, label FROM word WHERE item_id = ?', (chosen_item_id,)
    ).fetchall()
    choices = [{'word_id': w['id'], 'label': w['label']} for w in words]
    random.shuffle(choices)

    return {
        'item_id':             chosen_item_id,
        'stimulus_word_id':    stimulus_word_id,
        'recording_id':        recording['id'],
        'recording_url':       url_for('static', filename=f'audio/{rec_filename}'),
        'choices':             choices,
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
        for word_label in item['words']:
            db.execute('INSERT INTO word (item_id, label) VALUES (?, ?)',
                       (item_id, word_label.strip()))

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
        flash('Item deleted. SRS progress for this item has been cleared.', 'success')

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


# ── End User ─────────────────────────────────────────────────────────────────

@app.route('/user/')
def user_index():
    db = get_db()
    packs = db.execute('SELECT * FROM pack WHERE published = 1 ORDER BY name').fetchall()
    # Attach item count for display
    packs_data = []
    for p in packs:
        cnt = db.execute(
            'SELECT COUNT(*) as c FROM item WHERE pack_id = ?', (p['id'],)
        ).fetchone()['c']
        packs_data.append({'id': p['id'], 'name': p['name'],
                           'description': p['description'], 'item_count': cnt})
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
    db.close()

    session['shown_items'] = []
    session['current_pack'] = pack_id
    return render_template('user/train.html', pack=pack)


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

    # Update SRS for the stimulus direction
    dr = db.execute('''
        SELECT * FROM directional_record
        WHERE item_id = ? AND stimulus_word_id = ?
    ''', (item_id, stimulus_word_id)).fetchone()

    if dr:
        new_int, new_ease, new_reps = sm2_update(
            dr['srs_interval'], dr['srs_ease'], dr['srs_repetitions'], correct
        )
        new_due = (date.today() + timedelta(days=new_int)).isoformat()
        db.execute('''
            UPDATE directional_record
               SET srs_interval = ?, srs_ease = ?, srs_repetitions = ?,
                   srs_due_date = ?, last_reviewed_at = datetime('now')
             WHERE id = ?
        ''', (new_int, new_ease, new_reps, new_due, dr['id']))

    # Mark item seen this session
    seen = session.get('shown_items', [])
    if item_id not in seen:
        seen.append(item_id)
    session['shown_items'] = seen

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

    db.commit()
    db.close()

    return jsonify({
        'correct':          correct,
        'stimulus_word_id': stimulus_word_id,
        'discrimination':   discrimination,
    })


# ── Entry point ──────────────────────────────────────────────────────────────

if __name__ == '__main__':
    init_db()
    app.run(debug=True, port=5001)
