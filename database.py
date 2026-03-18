import sqlite3

DB_PATH = 'minimal_pairs.db'


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_db()
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS pack (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            description TEXT,
            published INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS item (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pack_id INTEGER NOT NULL REFERENCES pack(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS word (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
            label TEXT NOT NULL,
            word_type TEXT NOT NULL DEFAULT 'real'
        );

        CREATE TABLE IF NOT EXISTS recording (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            word_id INTEGER NOT NULL REFERENCES word(id) ON DELETE CASCADE,
            file_path TEXT NOT NULL,
            speaker_label TEXT,
            session_id TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS directional_record (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
            stimulus_word_id INTEGER NOT NULL REFERENCES word(id) ON DELETE CASCADE,
            last_reviewed_at TEXT,
            UNIQUE(item_id, stimulus_word_id)
        );

        CREATE TABLE IF NOT EXISTS speaker (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS training_state (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pack_id INTEGER NOT NULL REFERENCES pack(id) ON DELETE CASCADE,
            phase INTEGER NOT NULL DEFAULT 1,
            phase_advanced_at TEXT,
            mastered INTEGER NOT NULL DEFAULT 0,
            mastered_at TEXT,
            session_count_this_week INTEGER NOT NULL DEFAULT 0,
            total_seconds_this_week INTEGER NOT NULL DEFAULT 0,
            week_start TEXT,
            last_session_date TEXT,
            last_session_seconds INTEGER NOT NULL DEFAULT 0,
            UNIQUE(pack_id)
        );

        CREATE TABLE IF NOT EXISTS trial_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id INTEGER NOT NULL,
            pack_id INTEGER NOT NULL,
            stimulus_word_id INTEGER NOT NULL,
            recording_id INTEGER NOT NULL,
            response_word_id INTEGER NOT NULL,
            correct INTEGER NOT NULL,
            response_time_ms INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    ''')
    conn.commit()
    conn.close()
