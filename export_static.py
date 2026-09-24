#!/usr/bin/env python3
"""Export published packs to JSON for the static training site.
Run: python3 export_static.py
"""
import json
import os
from database import get_db


def export_pack(db, pack):
    items = db.execute('SELECT * FROM item WHERE pack_id = ? ORDER BY id', (pack['id'],)).fetchall()
    items_data = []
    for item in items:
        words = db.execute('SELECT * FROM word WHERE item_id = ? ORDER BY id', (item['id'],)).fetchall()
        words_data = []
        for word in words:
            recs = db.execute(
                'SELECT * FROM recording WHERE word_id = ? ORDER BY created_at', (word['id'],)
            ).fetchall()
            recs_data = []
            for rec in recs:
                filename = os.path.basename(rec['file_path'])
                recs_data.append({
                    'id': rec['id'],
                    'speaker': rec['speaker_label'],
                    'url': f'../static/audio/{filename}',
                })
            words_data.append({
                'id': word['id'],
                'label': word['label'],
                'type': word['word_type'] if 'word_type' in word.keys() else 'real',
                'recordings': recs_data,
            })
        items_data.append({
            'id': item['id'],
            'words': words_data,
        })
    return {
        'id': pack['id'],
        'name': pack['name'],
        'description': pack['description'],
        'items': items_data,
    }


def main():
    db = get_db()
    packs = db.execute('SELECT * FROM pack WHERE published = 1 ORDER BY name').fetchall()

    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'train', 'data')
    os.makedirs(out_dir, exist_ok=True)

    manifest = []
    total_items = 0
    total_recs = 0
    for pack in packs:
        pack_data = export_pack(db, pack)
        filename = f'pack_{pack["id"]}.json'
        with open(os.path.join(out_dir, filename), 'w', encoding='utf-8') as f:
            json.dump(pack_data, f, ensure_ascii=False, indent=2)
        item_count = len(pack_data['items'])
        rec_count = sum(
            len(r) for item in pack_data['items'] for w in item['words'] for r in [w['recordings']]
        )
        total_items += item_count
        total_recs += rec_count
        manifest.append({
            'id': pack['id'],
            'name': pack['name'],
            'description': pack['description'],
            'file': filename,
            'itemCount': item_count,
        })
        print(f'  {pack["name"]}: {item_count} items, {rec_count} recordings')

    with open(os.path.join(out_dir, 'packs.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    db.close()
    print(f'\nExported {len(manifest)} pack(s), {total_items} items, {total_recs} recordings to {out_dir}')


if __name__ == '__main__':
    main()
