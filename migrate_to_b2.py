"""
One-off script: copy every existing image/video into the Backblaze B2 bucket
and repoint the DB rows at their new storage key.

Run this once, manually, after the app itself has already been switched over
to B2 (app.py no longer talks to Cloudinary, Wasabi, or R2). Existing rows
still have whatever URL they last pointed at (Cloudinary, Wasabi, or R2,
depending how far a prior migration got) until this script updates them, so
re-running it is safe/idempotent — it just re-fetches from whatever URL is
currently stored and re-uploads it. Note: B2's bucket is PRIVATE, so unlike
the R2/Wasabi scripts this one stores a raw object key in the DB, not a URL —
the app generates a fresh presigned URL at render time via _b2_sign_url().

Required env vars (same names the app itself uses):
    DATABASE_URL (or INTERNAL_POSTGRES_DATABASE_URL)
    B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_ENDPOINT_URL

Usage:
    python migrate_to_b2.py
"""
import os
import sys

import boto3
import psycopg2
import psycopg2.extras
import requests

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

DB_URL = os.environ.get('INTERNAL_POSTGRES_DATABASE_URL') or os.environ.get('DATABASE_URL', '')
B2_KEY_ID = os.environ.get('B2_KEY_ID', '')
B2_APPLICATION_KEY = os.environ.get('B2_APPLICATION_KEY', '')
B2_BUCKET = os.environ.get('B2_BUCKET', '')
B2_ENDPOINT = os.environ.get('B2_ENDPOINT_URL', '')

if not DB_URL:
    sys.exit("DATABASE_URL (or INTERNAL_POSTGRES_DATABASE_URL) is not set.")
if not (B2_KEY_ID and B2_APPLICATION_KEY and B2_BUCKET and B2_ENDPOINT):
    sys.exit("B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, and B2_ENDPOINT_URL must all be set.")

s3 = boto3.client(
    's3',
    endpoint_url=B2_ENDPOINT,
    aws_access_key_id=B2_KEY_ID,
    aws_secret_access_key=B2_APPLICATION_KEY,
)


def storage_key(collection, filename):
    return f"{collection}/{filename}" if collection else filename


def migrate_table(conn, table):
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(f"SELECT id, collection_name, filename, url FROM {table}")
    rows = cur.fetchall()
    cur.close()

    migrated, failed = 0, 0
    for row in rows:
        key = storage_key(row['collection_name'], row['filename'])
        label = f"{table}#{row['id']} ({key})"
        try:
            resp = requests.get(row['url'], timeout=120, stream=True)
            resp.raise_for_status()
            s3.upload_fileobj(
                resp.raw, B2_BUCKET, key,
                ExtraArgs={'ContentType': resp.headers.get('Content-Type', 'application/octet-stream')}
            )

            update_cur = conn.cursor()
            if table == 'videos':
                update_cur.execute(
                    "UPDATE videos SET url = %s, thumbnail_url = NULL WHERE id = %s",
                    (key, row['id'])
                )
            else:
                update_cur.execute(
                    "UPDATE images SET url = %s WHERE id = %s",
                    (key, row['id'])
                )
            conn.commit()
            update_cur.close()
            migrated += 1
            print(f"OK    {label}")
        except Exception as e:
            failed += 1
            print(f"FAIL  {label}: {e}")

    return migrated, failed


def main():
    conn = psycopg2.connect(DB_URL)
    try:
        img_ok, img_fail = migrate_table(conn, 'images')
        vid_ok, vid_fail = migrate_table(conn, 'videos')
    finally:
        conn.close()

    print(f"\nImages: {img_ok} migrated, {img_fail} failed")
    print(f"Videos: {vid_ok} migrated, {vid_fail} failed")
    print("\nOld Cloudinary/Wasabi/R2 assets were not deleted — verify everything renders "
          "correctly from B2 before purging them from those dashboards.")


if __name__ == '__main__':
    main()
