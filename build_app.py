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

    # Add database
    if os.path.exists('minimal_pairs.db'):
        datas.append(('minimal_pairs.db', '.'))
    else:
        print('WARNING: minimal_pairs.db not found. The app will start with an empty database.')

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
