"""
Build script for Minimal Pairs Training standalone app.
Run: python3 build_app.py

Produces:
  dist/MinimalPairs.app  (macOS)
  dist/MinimalPairs.exe  (Windows)

Bundles the current database + audio files so the app is self-contained.
"""
import subprocess
import sys
import os

def main():
    project_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(project_dir)

    # Ensure PyInstaller is installed
    try:
        import PyInstaller
    except ImportError:
        print('Installing PyInstaller...')
        subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'pyinstaller'])

    # Create a clean copy of the database for bundling:
    # - Remove packs with no recordings
    # - Clear training history (trial_log, training_state, directional_record)
    import shutil
    import sqlite3
    build_db = os.path.join(project_dir, 'build_minimal_pairs.db')
    if os.path.exists(os.path.join(project_dir, 'minimal_pairs.db')):
        shutil.copy2(os.path.join(project_dir, 'minimal_pairs.db'), build_db)
        db = sqlite3.connect(build_db)
        # Find packs with no recordings
        empty_packs = db.execute('''
            SELECT p.id FROM pack p
            WHERE NOT EXISTS (
                SELECT 1 FROM recording r
                JOIN word w ON w.id = r.word_id
                JOIN item i ON i.id = w.item_id
                WHERE i.pack_id = p.id
            )
        ''').fetchall()
        for row in empty_packs:
            pid = row[0]
            print(f'  Excluding pack {pid} (no recordings)')
            db.execute('DELETE FROM word WHERE item_id IN (SELECT id FROM item WHERE pack_id = ?)', (pid,))
            db.execute('DELETE FROM item WHERE pack_id = ?', (pid,))
            db.execute('DELETE FROM pack WHERE id = ?', (pid,))
        # Clear user training history
        db.execute('DELETE FROM trial_log')
        db.execute('DELETE FROM training_state')
        db.execute('DELETE FROM directional_record')
        db.commit()
        remaining = db.execute('SELECT COUNT(*) FROM pack').fetchone()[0]
        print(f'  Bundling {remaining} pack(s) with recordings')
        db.close()
    else:
        print('WARNING: minimal_pairs.db not found.')

    # Collect data files
    datas = [
        ('templates', 'templates'),
        ('static/css', 'static/css'),
        ('static/js', 'static/js'),
    ]

    # Add audio files if they exist
    audio_dir = os.path.join('static', 'audio')
    if os.path.exists(audio_dir) and os.listdir(audio_dir):
        datas.append(('static/audio', 'static/audio'))

    # Add the clean database copy
    if os.path.exists(build_db):
        datas.append(('build_minimal_pairs.db', '.'))
    else:
        print('WARNING: No database to bundle. The app will start empty.')

    # Add database.py and app.py as data (imported at runtime by launcher)
    datas.append(('app.py', '.'))
    datas.append(('database.py', '.'))

    # Build --add-data arguments
    sep = ';' if sys.platform == 'win32' else ':'
    add_data_args = []
    for src, dest in datas:
        add_data_args.extend(['--add-data', f'{src}{sep}{dest}'])

    # App name
    name = 'MinimalPairs'

    cmd = [
        sys.executable, '-m', 'PyInstaller',
        '--onefile',
        '--windowed' if sys.platform == 'darwin' else '--console',
        '--name', name,
        *add_data_args,
        '--hidden-import', 'flask',
        '--hidden-import', 'jinja2',
        '--hidden-import', 'markupsafe',
        '--hidden-import', 'sqlite3',
        'launcher.py',
    ]

    print('Building...')
    print(' '.join(cmd))
    subprocess.check_call(cmd)

    print(f'\nDone! Find your app in: dist/{name}')
    if sys.platform == 'darwin':
        print(f'  macOS: dist/{name}.app')
    else:
        print(f'  Windows: dist/{name}.exe')

if __name__ == '__main__':
    main()
