"""
One-off script: for every existing `images` row (currently storing a raw B2
key in `url`, from the prior migrate_to_b2.py migration), download its bytes
from B2 and upload them to Cloudinary using the same UUID as the Cloudinary
public_id, then repoint `images.url` at the new Cloudinary secure_url and set
`images.b2_backup_key` to the original B2 key.

The original B2 objects are left completely untouched — they become the
backup copy for the new Cloudinary-primary/B2-backup storage scheme.

Idempotent: only rows whose `url` doesn't already look like a Cloudinary URL
are touched, so a partially-failed run can be safely re-run.

Videos are NOT touched by this script — they remain B2-only.

Required env vars (same names the app itself uses):
    DATABASE_URL (or INTERNAL_POSTGRES_DATABASE_URL)
    B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_ENDPOINT_URL
    CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET

Usage:
    python migrate_to_cloudinary.py
"""
import os
import sys

import boto3
import cloudinary
import cloudinary.uploader
import psycopg2
import psycopg2.extras

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
if B2_ENDPOINT and not B2_ENDPOINT.startswith(('http://', 'https://')):
    B2_ENDPOINT = f'https://{B2_ENDPOINT}'
CLOUDINARY_CLOUD_NAME = os.environ.get('CLOUDINARY_CLOUD_NAME', '')
CLOUDINARY_API_KEY = os.environ.get('CLOUDINARY_API_KEY', '')
CLOUDINARY_API_SECRET = os.environ.get('CLOUDINARY_API_SECRET', '')

if not DB_URL:
    sys.exit("DATABASE_URL (or INTERNAL_POSTGRES_DATABASE_URL) is not set.")
if not (B2_KEY_ID and B2_APPLICATION_KEY and B2_BUCKET and B2_ENDPOINT):
    sys.exit("B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, and B2_ENDPOINT_URL must all be set.")
if not (CLOUDINARY_CLOUD_NAME and CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET):
    sys.exit("CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET must all be set.")

s3 = boto3.client(
    's3',
    endpoint_url=B2_ENDPOINT,
    aws_access_key_id=B2_KEY_ID,
    aws_secret_access_key=B2_APPLICATION_KEY,
)

cloudinary.config(
    cloud_name=CLOUDINARY_CLOUD_NAME,
    api_key=CLOUDINARY_API_KEY,
    api_secret=CLOUDINARY_API_SECRET,
    secure=True,
)


def migrate_images(conn):
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT id, collection_name, filename, url FROM images WHERE url NOT LIKE '%res.cloudinary.com%'")
    rows = cur.fetchall()
    cur.close()

    migrated, failed = 0, 0
    for row in rows:
        b2_key = row['url']  # currently a raw B2 key, per migrate_to_b2.py's convention
        uuid_part = row['filename'].rsplit('.', 1)[0]
        public_id = f"{row['collection_name']}/{uuid_part}" if row['collection_name'] else uuid_part
        label = f"images#{row['id']} ({b2_key})"
        try:
            obj = s3.get_object(Bucket=B2_BUCKET, Key=b2_key)
            result = cloudinary.uploader.upload(
                obj['Body'],
                public_id=public_id,
                resource_type='image',
                overwrite=False,
                unique_filename=False,
                use_filename=False,
            )

            update_cur = conn.cursor()
            update_cur.execute(
                "UPDATE images SET url = %s, b2_backup_key = %s WHERE id = %s",
                (result['secure_url'], b2_key, row['id'])
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
        ok, fail = migrate_images(conn)
    finally:
        conn.close()

    print(f"\nImages: {ok} migrated, {fail} failed")
    print("Original B2 objects were left untouched — they are now the backup copy "
          "(images.b2_backup_key points at them). Videos were not touched by this script.")


if __name__ == '__main__':
    main()
