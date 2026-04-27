import sqlite3
import json
import sys

DB = r'C:\Users\Administrator\AppData\Roaming\com.ai-canvas.app\data.db'

conn = sqlite3.connect(DB)
cur = conn.cursor()
cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = [r[0] for r in cur.fetchall()]
print('Tables:', tables)

for t in tables:
    print(f'\n--- {t} ---')
    cur.execute(f'PRAGMA table_info({t})')
    print('cols:', [r[1] for r in cur.fetchall()])
    try:
        cur.execute(f'SELECT * FROM {t} LIMIT 5')
        for row in cur.fetchall():
            s = str(row)
            if len(s) > 300:
                s = s[:300] + '...'
            print(s)
    except Exception as e:
        print('err:', e)
