"""
One-off script: copy every existing image/video into the Cloudflare R2 bucket
and repoint the DB rows at their new R2 public URLs.

Run this once, manually, after the app itself has already been switched over
to R2 (app.py no longer talks to Cloudinary or Wasabi at all). Existing rows
still have whatever URL they last pointed at (Cloudinary, or Wasabi if that
migration ran first) until this script updates them, so re-running it is
safe/idempotent — it just re-fetches from whatever URL is currently stored
and re-uploads it, harmlessly overwriting the same R2 object on a second run.

Required env vars (same names the app itself uses):
    DATABASE_URL (or INTERNAL_POSTGRES_DATABASE_URL)
    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL

Usage:
    python migrate_to_r2.py
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
R2_ACCOUNT_ID = os.environ.get('R2_ACCOUNT_ID', '')
R2_BUCKET = os.environ.get('R2_BUCKET', 'gamecum')
R2_ENDPOINT = os.environ.get('R2_ENDPOINT_URL', f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com')
R2_PUBLIC_BASE_URL = os.environ.get('R2_PUBLIC_BASE_URL', '').rstrip('/')

if not DB_URL:
    sys.exit("DATABASE_URL (or INTERNAL_POSTGRES_DATABASE_URL) is not set.")
if not R2_PUBLIC_BASE_URL:
    sys.exit("R2_PUBLIC_BASE_URL is not set (the bucket's public custom-domain or r2.dev URL).")

s3 = boto3.client(
    's3',
    endpoint_url=R2_ENDPOINT,
    aws_access_key_id=os.environ.get('R2_ACCESS_KEY_ID'),
    aws_secret_access_key=os.environ.get('R2_SECRET_ACCESS_KEY'),
    region_name='auto',
)


def r2_public_url(key):
    return f"{R2_PUBLIC_BASE_URL}/{key}"


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
                resp.raw, R2_BUCKET, key,
                ExtraArgs={'ContentType': resp.headers.get('Content-Type', 'application/octet-stream')}
            )
            new_url = r2_public_url(key)

            update_cur = conn.cursor()
            if table == 'videos':
                update_cur.execute(
                    "UPDATE videos SET url = %s, thumbnail_url = NULL WHERE id = %s",
                    (new_url, row['id'])
                )
            else:
                update_cur.execute(
                    "UPDATE images SET url = %s WHERE id = %s",
                    (new_url, row['id'])
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
    print("\nOld Cloudinary/Wasabi assets were not deleted — verify everything renders "
          "correctly from R2 before purging them from those dashboards.")


if __name__ == '__main__':
    main()
