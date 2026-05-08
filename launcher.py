"""
Minimal Pairs Training — Standalone Launcher
Opens the training app in the default browser. No superuser features.
"""
import os
import sys
import shutil
import webbrowser
import threading

def get_data_dir():
    """Get a writable directory for the database and audio files."""
    if sys.platform == 'darwin':
        base = os.path.expanduser('~/Library/Application Support/MinimalPairs')
    elif sys.platform == 'win32':
        base = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), 'MinimalPairs')
    else:
        base = os.path.expanduser('~/.minimal-pairs')
    os.makedirs(base, exist_ok=True)
    return base

def get_bundle_dir():
    """Get the directory where bundled resources live (works for PyInstaller)."""
    if getattr(sys, 'frozen', False):
        return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))

def setup_data():
    """Copy bundled DB and audio to writable data dir on first run."""
    data_dir = get_data_dir()
    bundle_dir = get_bundle_dir()

    db_dest = os.path.join(data_dir, 'minimal_pairs.db')
    audio_dest = os.path.join(data_dir, 'audio')

    # Copy database if not present (first run)
    # Build script creates build_minimal_pairs.db; fall back to minimal_pairs.db
    bundled_db = os.path.join(bundle_dir, 'build_minimal_pairs.db')
    if not os.path.exists(bundled_db):
        bundled_db = os.path.join(bundle_dir, 'minimal_pairs.db')
    if not os.path.exists(db_dest) and os.path.exists(bundled_db):
        shutil.copy2(bundled_db, db_dest)

    # Copy audio files if not present
    bundled_audio = os.path.join(bundle_dir, 'static', 'audio')
    if os.path.exists(bundled_audio):
        os.makedirs(audio_dest, exist_ok=True)
        for f in os.listdir(bundled_audio):
            dest_file = os.path.join(audio_dest, f)
            if not os.path.exists(dest_file):
                shutil.copy2(os.path.join(bundled_audio, f), dest_file)

    return data_dir

def main():
    data_dir = setup_data()

    # Set environment so the app uses the writable data dir
    os.environ['MINIMAL_PAIRS_DATA_DIR'] = data_dir
    os.environ['MINIMAL_PAIRS_STANDALONE'] = '1'

    # Import app after setting env
    bundle_dir = get_bundle_dir()
    sys.path.insert(0, bundle_dir)

    from app import app, init_db

    # Point database and audio to writable location
    app.config['DATABASE'] = os.path.join(data_dir, 'minimal_pairs.db')

    init_db()

    # Open browser after short delay
    def open_browser():
        import time
        time.sleep(1.5)
        webbrowser.open('http://localhost:5001/user/')

    threading.Thread(target=open_browser, daemon=True).start()

    print(f'Minimal Pairs Training running at http://localhost:5001/user/')
    print(f'Data stored in: {data_dir}')
    print('Close this window to stop.')

    app.run(host='127.0.0.1', port=5001, debug=False)

if __name__ == '__main__':
    main()
