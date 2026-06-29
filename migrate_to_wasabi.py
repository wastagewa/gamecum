"""
One-off script: copy every existing image/video from Cloudinary to Wasabi and
repoint the DB rows at their new Wasabi URLs.

Run this once, manually, after the app itself has already been switched over
to Wasabi (app.py no longer talks to Cloudinary at all). Existing rows still
have their old Cloudinary `url` value until this script updates them, so
re-running it is safe/idempotent — it just re-fetches from whatever URL is
currently stored (Cloudinary the first time, Wasabi on any later re-run, which
becomes a harmless re-upload of the same bytes).

Required env vars (same names the app itself uses):
    DATABASE_URL (or INTERNAL_POSTGRES_DATABASE_URL)
    WASABI_ACCESS_KEY, WASABI_SECRET_KEY, WASABI_BUCKET, WASABI_REGION

Usage:
    python migrate_to_wasabi.py
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
WASABI_BUCKET = os.environ.get('WASABI_BUCKET', 'gamecum')
WASABI_REGION = os.environ.get('WASABI_REGION', 'us-east-1')
WASABI_ENDPOINT = os.environ.get('WASABI_ENDPOINT_URL', f'https://s3.{WASABI_REGION}.wasabisys.com')

if not DB_URL:
    sys.exit("DATABASE_URL (or INTERNAL_POSTGRES_DATABASE_URL) is not set.")

s3 = boto3.client(
    's3',
    endpoint_url=WASABI_ENDPOINT,
    aws_access_key_id=os.environ.get('WASABI_ACCESS_KEY'),
    aws_secret_access_key=os.environ.get('WASABI_SECRET_KEY'),
    region_name=WASABI_REGION,
)


def wasabi_public_url(key):
    return f"{WASABI_ENDPOINT}/{WASABI_BUCKET}/{key}"


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
                resp.raw, WASABI_BUCKET, key,
                ExtraArgs={'ACL': 'public-read', 'ContentType': resp.headers.get('Content-Type', 'application/octet-stream')}
            )
            new_url = wasabi_public_url(key)

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
    print("\nCloudinary assets were not deleted — verify everything renders "
          "correctly from Wasabi before purging them from the Cloudinary dashboard.")


if __name__ == '__main__':
    main()
