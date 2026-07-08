import os

# Render sets RENDER=true in every service's environment. Only there do we
# monkey-patch for gevent (must happen before anything else is imported) so
# WebSocket connections run on cooperative greenlets instead of blocking an
# OS thread — that's what let gunicorn's worker-timeout watchdog mistake a
# held-open WebSocket for a hung worker and SIGKILL it. Local Windows dev
# skips this and keeps the already-verified 'threading' async_mode.
ON_RENDER = os.environ.get('RENDER') == 'true'
if ON_RENDER:
    from gevent import monkey
    monkey.patch_all()
    from psycogreen.gevent import patch_psycopg
    patch_psycopg()

from flask import Flask, render_template, request, jsonify, send_from_directory, redirect, url_for, session, Response
from flask_socketio import SocketIO, emit, join_room as sio_join_room
import json
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
import uuid
import random
import re
import string
import time as _time
from functools import wraps
import io
import boto3
import cloudinary
import cloudinary.uploader
import cloudinary.api
import psycopg2
import psycopg2.pool
import psycopg2.extras
from PIL import Image, ImageFilter
from flask_login import LoginManager, UserMixin, login_user, logout_user, current_user, login_required
from authlib.integrations.flask_client import OAuth

# Load .env file if present (python-dotenv)
try:
    from dotenv import load_dotenv
    load_dotenv()          # reads .env in the project root into os.environ
except ImportError:
    pass                   # dotenv not installed — env vars must be set externally

try:
    import requests as _http
    _HTTP_AVAILABLE = True
except ImportError:
    _HTTP_AVAILABLE = False

app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = os.path.join('static', 'uploads')
app.config['MAX_CONTENT_LENGTH'] = 300 * 1024 * 1024  # 300MB max file size (raised for video uploads)
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp'}
ALLOWED_VIDEO_EXTENSIONS = {'mp4', 'mov', 'webm', 'mkv'}

BODY_PARTS = ['boobs', 'pussy', 'butt', 'face', 'legs', 'belly', 'abs', 'chest', 'penis', 'feet']
VALID_RATINGS = {'h', 'c', 'sn', 'n', 'x'}

# Default AI-quote system prompt — admin-editable via /manage-quote-prompt, stored in
# app_settings under key 'ai_quote_system_prompt'. This constant is only the seed value
# and the fallback if that setting is ever missing. Must contain the literal
# "{name_instruction}" placeholder — it's substituted per-image with either an
# instruction to address the featured model by name, or to keep the quote generic.
DEFAULT_AI_QUOTE_SYSTEM_PROMPT = (
    "You write short, flirty, playful one-line captions for photos on an adult image "
    "board, based only on the descriptive tags/details you're given. "
    "{name_instruction} Keep it to one or two sentences, under 30 words total. "
    "Be suggestive and fun, not vulgar or crude. Do not repeat the raw tag list "
    "verbatim, add disclaimers, or break character with any meta-commentary — "
    "reply with ONLY the quote text itself, no quotation marks."
)

socketio = SocketIO(app, async_mode='gevent' if ON_RENDER else 'threading')

# ── Backblaze B2 (S3-compatible) storage ────────────────────────────────────────
# The bucket is PRIVATE (no card required for B2 unless you want a public bucket),
# so there is no permanent public URL — DB rows store the raw object key, and a
# fresh presigned URL is generated via _b2_sign_url() every time one is needed.

B2_KEY_ID = os.environ.get('B2_KEY_ID', '')
B2_APPLICATION_KEY = os.environ.get('B2_APPLICATION_KEY', '')
B2_BUCKET = os.environ.get('B2_BUCKET', '')
B2_ENDPOINT = os.environ.get('B2_ENDPOINT_URL', '')
if B2_ENDPOINT and not B2_ENDPOINT.startswith(('http://', 'https://')):
    B2_ENDPOINT = f'https://{B2_ENDPOINT}'
B2_URL_EXPIRY_SECONDS = int(os.environ.get('B2_URL_EXPIRY_SECONDS', 21600))  # 6 hours

# B2 endpoints encode their region (e.g. s3.eu-central-003.backblazeb2.com) — the
# presigned-URL signature must be scoped to that same region or B2 rejects it with
# a signature mismatch, even though the URL looks well-formed. Derive it from the
# endpoint unless explicitly overridden.
B2_REGION = os.environ.get('B2_REGION', '')
if not B2_REGION and B2_ENDPOINT:
    _host_parts = B2_ENDPOINT.split('://', 1)[-1].split('.')
    if len(_host_parts) >= 2 and _host_parts[0] == 's3':
        B2_REGION = _host_parts[1]

_s3 = boto3.client(
    's3',
    endpoint_url=B2_ENDPOINT,
    aws_access_key_id=B2_KEY_ID,
    aws_secret_access_key=B2_APPLICATION_KEY,
    region_name=B2_REGION or 'us-east-1',
)

def _b2_sign_url(key: str, expires_in: int = B2_URL_EXPIRY_SECONDS):
    """Generate a time-limited URL for a private B2 object. Pass-through falsy keys unchanged."""
    if not key:
        return key
    return _s3.generate_presigned_url(
        'get_object', Params={'Bucket': B2_BUCKET, 'Key': key}, ExpiresIn=expires_in
    )

def _b2_upload_fileobj(fileobj, key: str, content_type: str = None):
    """Upload a file-like object to the B2 bucket, return its storage key (not a URL)."""
    extra_args = {}
    if content_type:
        extra_args['ContentType'] = content_type
    _s3.upload_fileobj(fileobj, B2_BUCKET, key, ExtraArgs=extra_args)
    return key

def _b2_delete_object(key: str):
    _s3.delete_object(Bucket=B2_BUCKET, Key=key)

def _b2_delete_prefix(prefix: str):
    """Delete every object under a folder prefix (a whole collection's images and videos)."""
    paginator = _s3.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=B2_BUCKET, Prefix=prefix):
        objects = [{'Key': obj['Key']} for obj in page.get('Contents', [])]
        if objects:
            _s3.delete_objects(Bucket=B2_BUCKET, Delete={'Objects': objects})

def _b2_move_object(old_key: str, new_key: str):
    """Copy an object to a new key and delete the old one (used for collection rename); returns the new key."""
    _s3.copy_object(
        Bucket=B2_BUCKET,
        CopySource={'Bucket': B2_BUCKET, 'Key': old_key},
        Key=new_key,
    )
    _s3.delete_object(Bucket=B2_BUCKET, Key=old_key)
    return new_key

# ── Cloudinary (primary image storage) ──────────────────────────────────────────
# Images are served exclusively from Cloudinary as their original bytes (no
# f_auto/q_auto transforms — this app has pixel-zoom minigames that need exact
# fidelity to the uploaded file). B2 is kept as a synchronous, best-effort backup
# copy only — it is never read from for images again once uploaded.

CLOUDINARY_CLOUD_NAME = os.environ.get('CLOUDINARY_CLOUD_NAME', '')
CLOUDINARY_API_KEY = os.environ.get('CLOUDINARY_API_KEY', '')
CLOUDINARY_API_SECRET = os.environ.get('CLOUDINARY_API_SECRET', '')

cloudinary.config(
    cloud_name=CLOUDINARY_CLOUD_NAME,
    api_key=CLOUDINARY_API_KEY,
    api_secret=CLOUDINARY_API_SECRET,
    secure=True,
)

def _cloudinary_upload(fileobj, public_id: str):
    """Upload a file-like object to Cloudinary as-is (no transformation). Returns secure_url."""
    result = cloudinary.uploader.upload(
        fileobj,
        public_id=public_id,
        resource_type='image',
        overwrite=False,
        unique_filename=False,
        use_filename=False,
    )
    return result['secure_url']

def _cloudinary_delete(public_id: str):
    """Hard-delete a Cloudinary image asset by public_id."""
    cloudinary.uploader.destroy(public_id, resource_type='image')

def _cloudinary_rename(old_public_id: str, new_public_id: str):
    """Rename (move) a Cloudinary image asset in place. Returns the new secure_url.
    Raises on failure — callers must not silently swallow this, since (unlike B2 keys)
    the resulting URL is stored and rendered directly with no re-signing step to fall
    back on."""
    result = cloudinary.uploader.rename(old_public_id, new_public_id, resource_type='image')
    return result['secure_url']

def _cloudinary_delete_prefix(prefix: str):
    """Delete every Cloudinary image asset under a folder prefix (used for whole-collection delete)."""
    cloudinary.api.delete_resources_by_prefix(prefix, resource_type='image')

# ── Auth setup ────────────────────────────────────────────────────────────────

app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'dev-key-change-in-production')
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'

login_manager = LoginManager(app)
login_manager.login_view = 'login_page'
login_manager.login_message = ''

_oauth = OAuth(app)
google_oauth = _oauth.register(
    name='google',
    client_id=os.environ.get('GOOGLE_CLIENT_ID'),
    client_secret=os.environ.get('GOOGLE_CLIENT_SECRET'),
    server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
    client_kwargs={'scope': 'openid email profile'},
)

# ── Database layer ────────────────────────────────────────────────────────────

_db_pool = None

def _db_url():
    return (os.environ.get('INTERNAL_POSTGRES_DATABASE_URL') or
            os.environ.get('DATABASE_URL', ''))

def _get_db():
    global _db_pool
    if _db_pool is None:
        _db_pool = psycopg2.pool.ThreadedConnectionPool(1, 10, dsn=_db_url())
    return _db_pool.getconn()

def _release_db(conn):
    global _db_pool
    if _db_pool and conn:
        try:
            _db_pool.putconn(conn)
        except Exception:
            pass

def init_db():
    """Create tables if they don't exist. Uses a direct connection, not the pool."""
    conn = psycopg2.connect(_db_url())
    try:
        conn.autocommit = True
        cur = conn.cursor()
        cur.execute("""
            CREATE TABLE IF NOT EXISTS collections (
                name VARCHAR(255) PRIMARY KEY
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS images (
                id          SERIAL PRIMARY KEY,
                collection_name VARCHAR(255) NOT NULL
                    REFERENCES collections(name) ON DELETE CASCADE,
                filename    VARCHAR(500) NOT NULL,
                url         TEXT NOT NULL,
                tags        TEXT[]  DEFAULT '{}',
                locked      BOOLEAN DEFAULT FALSE,
                created_at  TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(collection_name, filename)
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS scores (
                id              SERIAL PRIMARY KEY,
                collection_name VARCHAR(255) NOT NULL,
                game_type       VARCHAR(100) NOT NULL,
                data            JSONB NOT NULL DEFAULT '{}',
                user_id         INTEGER,
                created_at      TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id                  SERIAL PRIMARY KEY,
                email               VARCHAR(255) UNIQUE NOT NULL,
                username            VARCHAR(100) NOT NULL,
                password_hash       VARCHAR(255),
                google_id           VARCHAR(255) UNIQUE,
                is_admin            BOOLEAN DEFAULT FALSE,
                is_permanent_admin  BOOLEAN DEFAULT FALSE,
                avatar_url          TEXT,
                created_at          TIMESTAMPTZ DEFAULT NOW(),
                last_seen           TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS user_sessions (
                id              SERIAL PRIMARY KEY,
                user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                ip_address      VARCHAR(100),
                user_agent      TEXT,
                logged_in_at    TIMESTAMPTZ DEFAULT NOW(),
                last_seen_at    TIMESTAMPTZ DEFAULT NOW(),
                logged_out_at   TIMESTAMPTZ,
                is_active       BOOLEAN DEFAULT TRUE
            )
        """)
        # Add uploaded_by to images if not present (safe on existing DBs)
        cur.execute("""
            ALTER TABLE images
            ADD COLUMN IF NOT EXISTS uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL
        """)
        # Add body_parts JSONB column for structured body-part tagging
        cur.execute("""
            ALTER TABLE images
            ADD COLUMN IF NOT EXISTS body_parts JSONB DEFAULT '{}'::jsonb
        """)
        # Cached AI-generated quote (built once from tags/body_parts/model name,
        # regenerated only when the user explicitly asks for a new one)
        cur.execute("""
            ALTER TABLE images
            ADD COLUMN IF NOT EXISTS ai_quote TEXT
        """)
        # B2 backup key for the dual-write Cloudinary/B2 image storage scheme —
        # Cloudinary is the live/served copy (images.url), B2 is a write-only backup
        # never read from directly. NULL if the best-effort backup upload failed.
        cur.execute("""
            ALTER TABLE images
            ADD COLUMN IF NOT EXISTS b2_backup_key TEXT
        """)
        # Soft-delete marker: NULL = active image, non-null = deleted (and shows up
        # in the /admin/orphaned-images backup-recovery page). The Cloudinary asset
        # is actually deleted at delete time; the B2 backup is kept until an admin
        # purges it from that page.
        cur.execute("""
            ALTER TABLE images
            ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ
        """)
        # Generic admin-editable key/value settings (currently just the AI quote
        # system prompt, kept here rather than a dedicated column so future settings
        # don't each need their own migration).
        cur.execute("""
            CREATE TABLE IF NOT EXISTS app_settings (
                key   VARCHAR(255) PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)
        cur.execute(
            "INSERT INTO app_settings (key, value) VALUES (%s, %s) ON CONFLICT DO NOTHING",
            ('ai_quote_system_prompt', DEFAULT_AI_QUOTE_SYSTEM_PROMPT)
        )
        # Add user_id FK to scores if not present
        cur.execute("""
            ALTER TABLE scores
            ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS videos (
                id              SERIAL PRIMARY KEY,
                collection_name VARCHAR(255) NOT NULL
                    REFERENCES collections(name) ON DELETE CASCADE,
                filename        VARCHAR(500) NOT NULL,
                url             TEXT NOT NULL,
                thumbnail_url   TEXT,
                duration        REAL,
                locked          BOOLEAN DEFAULT FALSE,
                uploaded_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at      TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(collection_name, filename)
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS video_collection_access (
                id              SERIAL PRIMARY KEY,
                collection_name VARCHAR(255) NOT NULL
                    REFERENCES collections(name) ON DELETE CASCADE,
                user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                granted_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
                granted_at      TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(collection_name, user_id)
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS video_item_access (
                id          SERIAL PRIMARY KEY,
                video_id    INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
                user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                granted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
                granted_at  TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(video_id, user_id)
            )
        """)
        # Models = subject/person names appearing in an image (many-to-many, since
        # multiple people can appear in one image). Kept as a proper lookup table
        # (not a free-text array like `images.tags`) so admins can rename/delete a
        # canonical name without rewriting every image row that references it.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS models (
                id          SERIAL PRIMARY KEY,
                name        VARCHAR(255) NOT NULL,
                created_at  TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_models_name_lower ON models (LOWER(name))
        """)
        # Gender feeds the AI-quote prompt (correct pronoun/framing) — admin-set,
        # defaults to 'unspecified' so existing models keep working unmodified.
        cur.execute("""
            ALTER TABLE models
            ADD COLUMN IF NOT EXISTS gender VARCHAR(20) NOT NULL DEFAULT 'unspecified'
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS image_models (
                image_id  INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
                model_id  INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
                PRIMARY KEY (image_id, model_id)
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_image_models_model_id ON image_models (model_id)
        """)
        # Per-user, per-collection blocks on a specific body_part:rating pair — the
        # opposite of video access (images are visible by default; a block hides one
        # exact tag pair from one specific user). See _effective_blocked_pairs().
        cur.execute("""
            CREATE TABLE IF NOT EXISTS image_tag_blocks (
                id              SERIAL PRIMARY KEY,
                user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                collection_name VARCHAR(255) NOT NULL REFERENCES collections(name) ON DELETE CASCADE,
                body_part       VARCHAR(50) NOT NULL,
                rating          VARCHAR(10) NOT NULL,
                blocked_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at      TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(user_id, collection_name, body_part, rating)
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_image_tag_blocks_collection
                ON image_tag_blocks (collection_name, body_part, rating)
        """)
        cur.close()
        print("DB tables ready.")
    except Exception as e:
        print(f"WARNING: init_db failed: {e}")
    finally:
        conn.close()

# ── Collections ───────────────────────────────────────────────────────────────

def _load_collections():
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("SELECT name FROM collections ORDER BY name")
        return [r[0] for r in cur.fetchall()]
    finally:
        _release_db(conn)

def _save_collections(collections: list):
    pass  # no-op — use _ensure_collection() for inserts, direct DELETE for removes

def _ensure_collection(safe_name: str):
    """Insert collection into DB if it doesn't exist yet."""
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO collections (name) VALUES (%s) ON CONFLICT DO NOTHING",
            (safe_name,)
        )
        conn.commit()
    finally:
        _release_db(conn)

def _collection_exists(safe_name: str):
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM collections WHERE name = %s", (safe_name,))
        return cur.fetchone() is not None
    finally:
        _release_db(conn)

# ── Images / Tags ─────────────────────────────────────────────────────────────

def _get_image_key(collection: str, filename: str):
    return f"{collection}/{filename}" if collection else filename

def _load_tags():
    """Return all images as a dict keyed by 'collection/filename'."""
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT collection_name, filename, url, tags, locked, body_parts FROM images WHERE deleted_at IS NULL"
        )
        result = {}
        for coll, fname, url, tags, locked, body_parts in cur.fetchall():
            result[f"{coll}/{fname}"] = {
                'tags':       list(tags) if tags else [],
                'locked':     bool(locked),
                'url':        url,
                'body_parts': dict(body_parts) if body_parts else {},
            }
        return result
    finally:
        _release_db(conn)

def _save_tags(tags: dict):
    """UPSERT image rows from dict. Does not delete — use _db_delete_image() for that."""
    if not tags:
        return
    conn = _get_db()
    try:
        cur = conn.cursor()
        for key, value in tags.items():
            if '/' not in key or not isinstance(value, dict) or not value.get('url'):
                continue
            coll, fname = key.split('/', 1)
            cur.execute("""
                INSERT INTO images (collection_name, filename, url, tags, locked, body_parts)
                VALUES (%s, %s, %s, %s, %s, %s::jsonb)
                ON CONFLICT (collection_name, filename) DO UPDATE
                  SET url        = EXCLUDED.url,
                      tags       = EXCLUDED.tags,
                      locked     = EXCLUDED.locked,
                      body_parts = EXCLUDED.body_parts
            """, (coll, fname, value['url'],
                  value.get('tags', []),
                  value.get('locked', False),
                  json.dumps(value.get('body_parts', {}))))
        conn.commit()
    finally:
        _release_db(conn)

def _db_insert_image(collection: str, filename: str, url: str, user_id: int = None, b2_backup_key: str = None):
    """Insert a new image row, ensuring its collection exists first."""
    _ensure_collection(collection)
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO images (collection_name, filename, url, tags, locked, uploaded_by, b2_backup_key)
            VALUES (%s, %s, %s, '{}', FALSE, %s, %s)
            ON CONFLICT (collection_name, filename) DO UPDATE
                SET url = EXCLUDED.url,
                    uploaded_by = COALESCE(EXCLUDED.uploaded_by, images.uploaded_by),
                    b2_backup_key = EXCLUDED.b2_backup_key
        """, (collection, filename, url, user_id, b2_backup_key))
        conn.commit()
    finally:
        _release_db(conn)

def _db_delete_image(collection: str, filename: str):
    """Hard-delete an image row. Only used by the orphaned-images purge action —
    normal image deletion goes through _db_soft_delete_image() instead."""
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM images WHERE collection_name = %s AND filename = %s",
            (collection, filename)
        )
        conn.commit()
    finally:
        _release_db(conn)

def _db_soft_delete_image(collection: str, filename: str):
    """Mark an image row deleted without removing it — the Cloudinary asset is
    deleted separately by the caller, but the B2 backup (and this row, for
    admin visibility) is kept until purged from /admin/orphaned-images."""
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE images SET deleted_at = NOW() WHERE collection_name = %s AND filename = %s",
            (collection, filename)
        )
        conn.commit()
    finally:
        _release_db(conn)

def _find_image_collection(filename: str):
    """Look up which collection an image belongs to by its (UUID) filename alone —
    used by the legacy collection-less /delete-image/<filename> route. Returns
    None if no active image with that filename exists."""
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT collection_name FROM images WHERE filename = %s AND deleted_at IS NULL LIMIT 1",
            (filename,)
        )
        row = cur.fetchone()
        return row[0] if row else None
    finally:
        _release_db(conn)

def _image_exists_in_tags(safe_name: str, filename: str):
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT 1 FROM images WHERE collection_name = %s AND filename = %s AND deleted_at IS NULL",
            (safe_name, filename)
        )
        return cur.fetchone() is not None
    finally:
        _release_db(conn)

def _get_image_tags(collection: str, filename: str):
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT tags FROM images WHERE collection_name = %s AND filename = %s",
            (collection, filename)
        )
        row = cur.fetchone()
        return list(row[0]) if row and row[0] else []
    finally:
        _release_db(conn)

def _get_image_locked_status(collection: str, filename: str):
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT locked FROM images WHERE collection_name = %s AND filename = %s",
            (collection, filename)
        )
        row = cur.fetchone()
        return bool(row[0]) if row else False
    finally:
        _release_db(conn)

def _set_image_tags(collection: str, filename: str, tags: list, locked: bool = None):
    cleaned = [str(t).strip() for t in tags if t]
    conn = _get_db()
    try:
        cur = conn.cursor()
        if locked is not None:
            cur.execute("""
                UPDATE images SET tags = %s, locked = %s
                WHERE collection_name = %s AND filename = %s
            """, (cleaned, locked, collection, filename))
        else:
            cur.execute("""
                UPDATE images SET tags = %s
                WHERE collection_name = %s AND filename = %s
            """, (cleaned, collection, filename))
        conn.commit()
    finally:
        _release_db(conn)

def _set_image_body_parts_and_tags(collection: str, filename: str, body_parts: dict, tags: list):
    """Update body_parts and tags for an image in a single round-trip."""
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE images SET body_parts = %s::jsonb, tags = %s WHERE collection_name = %s AND filename = %s",
            (json.dumps(body_parts), tags, collection, filename)
        )
        conn.commit()
    finally:
        _release_db(conn)

def _set_image_locked(collection: str, filename: str, locked: bool):
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE images SET locked = %s WHERE collection_name = %s AND filename = %s",
            (locked, collection, filename)
        )
        conn.commit()
    finally:
        _release_db(conn)

# ── Models (subject/person names appearing in an image) ───────────────────────
# Kept as a proper lookup table + many-to-many join (not a free-text array like
# images.tags) because admins need to rename/delete a canonical name without
# rewriting every image row that references it, and an image can show multiple
# people at once.

def _get_all_models():
    """Every model as {id, name, gender}, alphabetical — feeds the tagger's autocomplete."""
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("SELECT id, name, gender FROM models ORDER BY name")
        return [{'id': r[0], 'name': r[1], 'gender': r[2]} for r in cur.fetchall()]
    finally:
        _release_db(conn)

def _get_models_with_counts():
    """Every model as {id, name, gender, count}, sorted by image count desc then name."""
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT m.id, m.name, m.gender, COUNT(im.image_id)
            FROM models m
            LEFT JOIN image_models im ON im.model_id = m.id
            GROUP BY m.id, m.name, m.gender
            ORDER BY COUNT(im.image_id) DESC, m.name ASC
        """)
        return [{'id': r[0], 'name': r[1], 'gender': r[2], 'count': r[3]} for r in cur.fetchall()]
    finally:
        _release_db(conn)

def _create_model(name: str, gender: str = 'unspecified'):
    """Insert a new model. Returns its id, or None if the name already exists (case-insensitive)."""
    name = (name or '').strip()
    if not name:
        return None
    if gender not in VALID_MODEL_GENDERS:
        gender = 'unspecified'
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("SELECT id FROM models WHERE LOWER(name) = LOWER(%s)", (name,))
        if cur.fetchone():
            return None
        try:
            cur.execute("INSERT INTO models (name, gender) VALUES (%s, %s) RETURNING id", (name, gender))
            model_id = cur.fetchone()[0]
            conn.commit()
            return model_id
        except psycopg2.IntegrityError:
            # Another request created the same name (case-insensitively) between our
            # SELECT and INSERT — roll back so the pooled connection isn't left mid-transaction.
            conn.rollback()
            return None
    finally:
        _release_db(conn)

def _set_model_gender(model_id: int, gender: str):
    """Update a model's gender. Returns False if not found or gender is invalid."""
    if gender not in VALID_MODEL_GENDERS:
        return False
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("UPDATE models SET gender = %s WHERE id = %s", (gender, model_id))
        updated = cur.rowcount > 0
        conn.commit()
        return updated
    finally:
        _release_db(conn)

def _rename_model(model_id: int, new_name: str):
    """Rename a model in place. Returns False if not found or the name collides with another model."""
    new_name = (new_name or '').strip()
    if not new_name:
        return False
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("SELECT id FROM models WHERE LOWER(name) = LOWER(%s) AND id != %s", (new_name, model_id))
        if cur.fetchone():
            return False
        cur.execute("UPDATE models SET name = %s WHERE id = %s", (new_name, model_id))
        updated = cur.rowcount > 0
        conn.commit()
        return updated
    finally:
        _release_db(conn)

def _delete_model(model_id: int):
    """Delete a model. Cascades via FK to unlink it from every image that had it."""
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM models WHERE id = %s", (model_id,))
        deleted = cur.rowcount > 0
        conn.commit()
        return deleted
    finally:
        _release_db(conn)

def _get_image_model_ids(collection: str, filename: str):
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT im.model_id FROM image_models im
            JOIN images i ON i.id = im.image_id
            WHERE i.collection_name = %s AND i.filename = %s
        """, (collection, filename))
        return [r[0] for r in cur.fetchall()]
    finally:
        _release_db(conn)

def _set_image_models(collection: str, filename: str, model_ids: list):
    """Replace the full set of models linked to one image."""
    # Validate/clean before touching the DB — if this raised after the DELETE below,
    # the pooled connection would go back with an uncommitted DELETE and no rollback.
    clean_ids = sorted({int(m) for m in model_ids if m is not None})
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT id FROM images WHERE collection_name = %s AND filename = %s",
            (collection, filename)
        )
        row = cur.fetchone()
        if not row:
            return
        image_id = row[0]
        cur.execute("DELETE FROM image_models WHERE image_id = %s", (image_id,))
        if clean_ids:
            psycopg2.extras.execute_values(
                cur,
                "INSERT INTO image_models (image_id, model_id) VALUES %s ON CONFLICT DO NOTHING",
                [(image_id, mid) for mid in clean_ids]
            )
        conn.commit()
    finally:
        _release_db(conn)

def _bulk_add_image_models(collection: str, filenames: list, model_ids: list):
    """Add (union, non-destructive) a set of models to many images at once."""
    clean_ids = sorted({int(m) for m in model_ids if m is not None})
    if not filenames or not clean_ids:
        return
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT id FROM images WHERE collection_name = %s AND filename = ANY(%s)",
            (collection, list(filenames))
        )
        image_ids = [r[0] for r in cur.fetchall()]
        pairs = [(iid, mid) for iid in image_ids for mid in clean_ids]
        if pairs:
            psycopg2.extras.execute_values(
                cur,
                "INSERT INTO image_models (image_id, model_id) VALUES %s ON CONFLICT DO NOTHING",
                pairs
            )
        conn.commit()
    finally:
        _release_db(conn)

def _count_existing_images(collection: str, filenames: list):
    """How many of the given filenames actually exist in this collection right now."""
    if not filenames:
        return 0
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT COUNT(*) FROM images WHERE collection_name = %s AND filename = ANY(%s)",
            (collection, list(filenames))
        )
        return cur.fetchone()[0]
    finally:
        _release_db(conn)

def _bulk_add_image_tags(collection: str, filenames: list, tags: list):
    """Add (union, non-destructive) free-text tags to many images at once."""
    clean_tags = [str(t).strip() for t in tags if t and str(t).strip()]
    if not filenames or not clean_tags:
        return
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            UPDATE images
            SET tags = (SELECT ARRAY(SELECT DISTINCT UNNEST(tags || %s)))
            WHERE collection_name = %s AND filename = ANY(%s)
        """, (clean_tags, collection, list(filenames)))
        conn.commit()
    finally:
        _release_db(conn)

def _get_collection_image_model_map(collection: str):
    """Return {filename: [{'id':.., 'name':..}, ...]} for every image in a collection."""
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT i.filename, m.id, m.name
            FROM images i
            JOIN image_models im ON im.image_id = i.id
            JOIN models m ON m.id = im.model_id
            WHERE i.collection_name = %s
        """, (collection,))
        result = {}
        for filename, model_id, model_name in cur.fetchall():
            result.setdefault(filename, []).append({'id': model_id, 'name': model_name})
        return result
    finally:
        _release_db(conn)

def _get_images_by_model_ids(model_ids: list, match_all: bool = False):
    """Image rows (across all collections) associated with any/all of the given model ids."""
    if not model_ids:
        return []
    conn = _get_db()
    try:
        cur = conn.cursor()
        if match_all:
            cur.execute("""
                SELECT i.collection_name, i.filename, i.url, i.tags, i.body_parts
                FROM images i
                JOIN image_models im ON im.image_id = i.id
                WHERE im.model_id = ANY(%s) AND i.deleted_at IS NULL
                GROUP BY i.id
                HAVING COUNT(DISTINCT im.model_id) = %s
            """, (model_ids, len(set(model_ids))))
        else:
            cur.execute("""
                SELECT DISTINCT i.collection_name, i.filename, i.url, i.tags, i.body_parts
                FROM images i
                JOIN image_models im ON im.image_id = i.id
                WHERE im.model_id = ANY(%s) AND i.deleted_at IS NULL
            """, (model_ids,))
        return cur.fetchall()
    finally:
        _release_db(conn)

def _get_image_ai_quote(collection: str, filename: str):
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT ai_quote FROM images WHERE collection_name = %s AND filename = %s",
            (collection, filename)
        )
        row = cur.fetchone()
        return row[0] if row and row[0] else None
    finally:
        _release_db(conn)

def _set_image_ai_quote(collection: str, filename: str, quote: str):
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE images SET ai_quote = %s WHERE collection_name = %s AND filename = %s",
            (quote, collection, filename)
        )
        conn.commit()
    finally:
        _release_db(conn)

# Human-readable labels for the body_parts rating codes, used only in the AI quote prompt
_BODY_PART_RATING_LABELS = {'h': 'hidden', 'c': 'covered', 'sn': 'semi-nude', 'n': 'nude'}
_QUOTE_HF_MODEL = os.environ.get('QUOTE_HF_MODEL', 'Qwen/Qwen2.5-72B-Instruct').strip()
# "Thinking"/reasoning models (e.g. GLM, DeepSeek-R1-style) spend a chunk of the token
# budget on hidden reasoning before the final answer, so they need far more headroom
# than a direct-answer model — left admin-tunable per model instead of a fixed guess.
_QUOTE_HF_MAX_TOKENS = int(os.environ.get('QUOTE_HF_MAX_TOKENS', '500'))
# The AI-quote feature's own chat-completions endpoint/token — separate from the
# general chatbot feature's HF_TOKEN (chat.js), so quotes can point at a different,
# less-restrictive OpenAI-chat-compatible provider (e.g. Venice.ai) without affecting
# the general chatbot. Defaults preserve the original HF-router behavior untouched.
_QUOTE_CHAT_API_BASE_URL = os.environ.get(
    'QUOTE_CHAT_API_BASE_URL', 'https://router.huggingface.co/v1/chat/completions'
).strip()
_QUOTE_CHAT_API_TOKEN = os.environ.get('QUOTE_CHAT_API_TOKEN', '').strip() or os.environ.get('HF_TOKEN', '').strip()

# Model gender — admin-set on the Manage Models page, used only to pick the correct
# pronoun/framing for the AI quote prompt below.
VALID_MODEL_GENDERS = {'female', 'male', 'unspecified'}
_MODEL_GENDER_PRONOUNS = {
    'female': 'her',
    'male':   'him',
}
_MODEL_GENDER_NEUTRAL_PRONOUN = 'them'

def _get_setting(key: str, default=None):
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("SELECT value FROM app_settings WHERE key = %s", (key,))
        row = cur.fetchone()
        return row[0] if row else default
    finally:
        _release_db(conn)

def _set_setting(key: str, value: str):
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO app_settings (key, value) VALUES (%s, %s)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        """, (key, value))
        conn.commit()
    finally:
        _release_db(conn)

def _build_ai_quote_prompt(collection: str, filename: str):
    """
    Build the system/user prompt for generating a flirty, tag/model-aware quote
    for one image. Returns None if the image doesn't exist.
    """
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, tags, body_parts FROM images WHERE collection_name = %s AND filename = %s",
            (collection, filename)
        )
        row = cur.fetchone()
        if not row:
            return None
        image_id, tags, body_parts = row
        tags = list(tags) if tags else []
        body_parts = dict(body_parts) if body_parts else {}

        cur.execute("""
            SELECT m.name, m.gender FROM image_models im
            JOIN models m ON m.id = im.model_id
            WHERE im.image_id = %s
        """, (image_id,))
        models_data = cur.fetchall()

        cur.execute("SELECT value FROM app_settings WHERE key = 'ai_quote_system_prompt'")
        setting_row = cur.fetchone()
        template = setting_row[0] if setting_row else DEFAULT_AI_QUOTE_SYSTEM_PROMPT
    finally:
        _release_db(conn)

    featured_model, featured_gender = random.choice(models_data) if models_data else (None, None)

    details = []
    if tags:
        details.append(f"Tags: {', '.join(tags)}")
    part_descriptions = [
        f"{part} ({_BODY_PART_RATING_LABELS[rating]})"
        for part, rating in body_parts.items()
        if rating in _BODY_PART_RATING_LABELS
    ]
    if part_descriptions:
        details.append(f"Body details: {', '.join(part_descriptions)}")
    if featured_model:
        details.append(f"Featured model: {featured_model}")
        if featured_gender in _MODEL_GENDER_PRONOUNS:
            details.append(f"Subject gender: {featured_gender}")

    if not details:
        return None  # nothing to work with — caller should fall back to the static quote bank

    pronoun = _MODEL_GENDER_PRONOUNS.get(featured_gender, _MODEL_GENDER_NEUTRAL_PRONOUN)
    name_instruction = (
        f'Address {pronoun} directly by name ("{featured_model}") in the quote.'
        if featured_model else
        "This image has no named model — keep the quote generic, don't invent a name."
    )
    # Plain substring replace (not str.format) so stray '{'/'}' an admin might type in
    # the template can't raise a KeyError — only the exact placeholder is substituted.
    system_prompt = template.replace('{name_instruction}', name_instruction)
    user_message = "Write the caption for a photo with these details:\n" + "\n".join(details)

    return {
        'system_prompt': system_prompt,
        'user_message': user_message,
        'model': _QUOTE_HF_MODEL,
        'max_tokens': _QUOTE_HF_MAX_TOKENS,
        'api_base': _QUOTE_CHAT_API_BASE_URL,
        'featured_model': featured_model,
    }

# ── Videos / Access control ────────────────────────────────────────────────────

def _db_insert_video(collection: str, filename: str, url: str, thumbnail_url: str = None,
                      duration: float = None, user_id: int = None):
    """Insert a new video row, ensuring its collection exists first."""
    _ensure_collection(collection)
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO videos (collection_name, filename, url, thumbnail_url, duration, uploaded_by)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (collection_name, filename) DO UPDATE
                SET url = EXCLUDED.url, thumbnail_url = EXCLUDED.thumbnail_url,
                    duration = EXCLUDED.duration,
                    uploaded_by = COALESCE(EXCLUDED.uploaded_by, videos.uploaded_by)
        """, (collection, filename, url, thumbnail_url, duration, user_id))
        conn.commit()
    finally:
        _release_db(conn)

def _db_delete_video(video_id: int):
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM videos WHERE id = %s", (video_id,))
        conn.commit()
    finally:
        _release_db(conn)

def _load_collection_videos(collection: str):
    """Return all video rows for a collection as a list of dicts, with signed, directly-usable URLs."""
    conn = _get_db()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT id, collection_name, filename, url, thumbnail_url, duration,
                   locked, uploaded_by, created_at
            FROM videos WHERE collection_name = %s ORDER BY created_at DESC
        """, (collection,))
        rows = [dict(r) for r in cur.fetchall()]
    finally:
        _release_db(conn)
    for row in rows:
        row['url'] = _b2_sign_url(row['url'])
        row['thumbnail_url'] = _b2_sign_url(row['thumbnail_url'])
    return rows

def _video_capable_collections():
    """Return {collection_name: video_count} for collections that contain at least one video."""
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT collection_name, COUNT(*) FROM videos
            GROUP BY collection_name ORDER BY collection_name
        """)
        return {row[0]: row[1] for row in cur.fetchall()}
    finally:
        _release_db(conn)

def _user_has_collection_video_access(user_id: int, collection: str):
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT 1 FROM video_collection_access WHERE collection_name = %s AND user_id = %s",
            (collection, user_id)
        )
        return cur.fetchone() is not None
    finally:
        _release_db(conn)

def _user_accessible_video_ids(user_id: int, collection: str):
    """Return the set of video ids in this collection individually granted to the user."""
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT v.id FROM video_item_access a
            JOIN videos v ON v.id = a.video_id
            WHERE a.user_id = %s AND v.collection_name = %s
        """, (user_id, collection))
        return {row[0] for row in cur.fetchall()}
    finally:
        _release_db(conn)

def _user_can_view_any_video_in_collection(user, collection: str):
    """True if this user (object with is_authenticated/is_admin/id) can see at least one video here."""
    if not user or not user.is_authenticated:
        return False
    if user.is_admin:
        return True
    if _user_has_collection_video_access(user.id, collection):
        return True
    return len(_user_accessible_video_ids(user.id, collection)) > 0

def _visible_videos_for_user(user, collection: str):
    """Return the list of video dicts this user is allowed to see in this collection."""
    videos = _load_collection_videos(collection)
    if not user or not user.is_authenticated:
        return []
    if user.is_admin or _user_has_collection_video_access(user.id, collection):
        return videos
    allowed_ids = _user_accessible_video_ids(user.id, collection)
    return [v for v in videos if v['id'] in allowed_ids]

def _grant_collection_video_access(collection: str, user_id: int, granted_by: int):
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO video_collection_access (collection_name, user_id, granted_by)
            VALUES (%s, %s, %s)
            ON CONFLICT (collection_name, user_id) DO NOTHING
        """, (collection, user_id, granted_by))
        conn.commit()
    finally:
        _release_db(conn)

def _revoke_collection_video_access(collection: str, user_id: int):
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM video_collection_access WHERE collection_name = %s AND user_id = %s",
            (collection, user_id)
        )
        conn.commit()
    finally:
        _release_db(conn)

def _grant_video_item_access(video_id: int, user_id: int, granted_by: int):
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO video_item_access (video_id, user_id, granted_by)
            VALUES (%s, %s, %s)
            ON CONFLICT (video_id, user_id) DO NOTHING
        """, (video_id, user_id, granted_by))
        conn.commit()
    finally:
        _release_db(conn)

def _revoke_video_item_access(video_id: int, user_id: int):
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM video_item_access WHERE video_id = %s AND user_id = %s",
            (video_id, user_id)
        )
        conn.commit()
    finally:
        _release_db(conn)

# ── Image tag blocks (per-user, per-collection content blocking) ──────────────
# Opposite model from video access: images are visible by default, and a block
# hides one exact body_part:rating pair from one specific user in one collection.

def _user_blocked_pairs(user_id: int, collection: str):
    """{(body_part, rating), ...} this user is blocked from in this collection."""
    if not user_id:
        return set()
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT body_part, rating FROM image_tag_blocks WHERE user_id = %s AND collection_name = %s",
            (user_id, collection)
        )
        return {(row[0], row[1]) for row in cur.fetchall()}
    finally:
        _release_db(conn)

def _effective_blocked_pairs(user, collection: str):
    """Blocked pairs for this viewer — admins/unauthenticated always get an empty set."""
    if not user or not getattr(user, 'is_authenticated', False) or getattr(user, 'is_admin', False):
        return set()
    return _user_blocked_pairs(user.id, collection)

def _user_blocked_pairs_by_collection(user_id: int):
    """{collection_name: {(body_part, rating), ...}} for every collection this user has blocks in."""
    if not user_id:
        return {}
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("SELECT collection_name, body_part, rating FROM image_tag_blocks WHERE user_id = %s", (user_id,))
        result = {}
        for coll, part, rating in cur.fetchall():
            result.setdefault(coll, set()).add((part, rating))
        return result
    finally:
        _release_db(conn)

def _effective_blocked_pairs_by_collection(user):
    """Same as _user_blocked_pairs_by_collection, but safe for anonymous/admin viewers
    (mirrors _effective_blocked_pairs' bypass, for callers spanning all collections)."""
    if not user or not getattr(user, 'is_authenticated', False) or getattr(user, 'is_admin', False):
        return {}
    return _user_blocked_pairs_by_collection(user.id)

def _image_visible_to_user(body_parts: dict, blocked_pairs: set):
    """False if this image has any body_part:rating pair the viewer is blocked from."""
    if not blocked_pairs or not body_parts:
        return True
    return not any((part, rating) in blocked_pairs for part, rating in body_parts.items())

def _union_blocked_pairs(user_ids, collection: str):
    """Union of blocked pairs across several users in one collection — used by the
    multiplayer games to make sure NEITHER player in a room is shown an image either
    of them is blocked from."""
    union = set()
    for uid in user_ids:
        if uid:
            union |= _user_blocked_pairs(uid, collection)
    return union

def _globally_sensitive_pairs(collection: str):
    """{(body_part, rating), ...} with an active block for ANYONE in this collection —
    used only to decide which images route through the blurred image proxy (§ image_proxy),
    not for per-viewer visibility."""
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT DISTINCT body_part, rating FROM image_tag_blocks WHERE collection_name = %s",
            (collection,)
        )
        return {(row[0], row[1]) for row in cur.fetchall()}
    finally:
        _release_db(conn)

def _grant_content_block(collection: str, body_part: str, rating: str, user_id: int, granted_by: int):
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO image_tag_blocks (collection_name, body_part, rating, user_id, blocked_by)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (user_id, collection_name, body_part, rating) DO NOTHING
        """, (collection, body_part, rating, user_id, granted_by))
        conn.commit()
    finally:
        _release_db(conn)

def _revoke_content_block(collection: str, body_part: str, rating: str, user_id: int):
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM image_tag_blocks WHERE collection_name = %s AND body_part = %s AND rating = %s AND user_id = %s",
            (collection, body_part, rating, user_id)
        )
        conn.commit()
    finally:
        _release_db(conn)

def _collection_body_part_pairs_with_counts(collection: str):
    """[(body_part, rating, count), ...] for every pair actually present in this collection's images."""
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT kv.key, kv.value, COUNT(*)
            FROM images i, jsonb_each_text(i.body_parts) AS kv
            WHERE i.collection_name = %s AND i.deleted_at IS NULL
            GROUP BY kv.key, kv.value
            ORDER BY kv.key, kv.value
        """, (collection,))
        return cur.fetchall()
    finally:
        _release_db(conn)

def _normalize_tags_entry(entry):
    """Normalize a tags entry dict — kept for callers that use _load_tags() output."""
    if isinstance(entry, list):
        return {'tags': entry, 'locked': False, 'body_parts': {}}
    elif isinstance(entry, dict):
        if 'tags' in entry:
            return {
                'tags':       entry['tags'] if isinstance(entry['tags'], list) else [],
                'locked':     entry.get('locked', False),
                'body_parts': entry.get('body_parts', {}),
            }
        elif 'tag' in entry:
            return {'tags': [entry['tag']], 'locked': False, 'body_parts': {}}
        else:
            return {'tags': [str(v) for v in entry.values() if isinstance(v, str)], 'locked': False, 'body_parts': {}}
    return {'tags': [], 'locked': False, 'body_parts': {}}

# ── Scores ────────────────────────────────────────────────────────────────────

def _load_scores():
    """Return {collection: {game_type: [entries sorted desc by score]}}."""
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT collection_name, game_type, data
            FROM scores
            ORDER BY collection_name, game_type,
                     (data->>'score')::int DESC,
                     (data->>'time')::int  ASC  NULLS LAST
        """)
        result = {}
        for coll, gtype, data in cur.fetchall():
            result.setdefault(coll, {}).setdefault(gtype, []).append(data)
        return result
    finally:
        _release_db(conn)

def _save_scores(scores: dict):
    pass  # no-op — scores are written directly in submit_score()

# ── User model ────────────────────────────────────────────────────────────────

class User(UserMixin):
    def __init__(self, row: dict):
        self.id                 = row['id']
        self.email              = row['email']
        self.username           = row['username']
        self.is_admin           = bool(row.get('is_admin', False))
        self.is_permanent_admin = bool(row.get('is_permanent_admin', False))
        self.avatar_url         = row.get('avatar_url')

    def get_id(self):
        return str(self.id)

@login_manager.user_loader
def load_user(user_id):
    conn = _get_db()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM users WHERE id = %s", (int(user_id),))
        row = cur.fetchone()
        return User(dict(row)) if row else None
    except Exception:
        return None
    finally:
        _release_db(conn)

# ── Auth decorators ───────────────────────────────────────────────────────────

def admin_required(f):
    """For API routes — returns JSON 403 if not admin."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not current_user.is_authenticated:
            return jsonify({'error': 'Authentication required'}), 401
        if not current_user.is_admin:
            return jsonify({'error': 'Admin access required'}), 403
        return f(*args, **kwargs)
    return decorated

# ── Auth helpers ──────────────────────────────────────────────────────────────

def _seed_admin():
    """Ensure the permanent admin account exists."""
    conn = psycopg2.connect(_db_url())
    try:
        conn.autocommit = True
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO users (email, username, password_hash, is_admin, is_permanent_admin)
            VALUES (%s, %s, %s, TRUE, TRUE)
            ON CONFLICT (email) DO UPDATE
                SET is_admin           = TRUE,
                    is_permanent_admin = TRUE,
                    password_hash      = EXCLUDED.password_hash
        """, ('wastagemail2@gmail.com', 'Admin',
               generate_password_hash('LoveGunOSM@123')))
        cur.close()
    except Exception as e:
        print(f"Admin seed failed: {e}")
    finally:
        conn.close()

def _record_login(user_id: int):
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO user_sessions (user_id, ip_address, user_agent)
            VALUES (%s, %s, %s)
        """, (user_id, request.remote_addr,
               (request.user_agent.string or '')[:500]))
        cur.execute("UPDATE users SET last_seen = NOW() WHERE id = %s", (user_id,))
        conn.commit()
    finally:
        _release_db(conn)

def _record_logout(user_id: int):
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            UPDATE user_sessions
            SET is_active = FALSE, logged_out_at = NOW()
            WHERE user_id = %s AND is_active = TRUE
        """, (user_id,))
        conn.commit()
    finally:
        _release_db(conn)

def _get_image_key(collection: str, filename: str):
    """Generate a unique key for an image."""
    return f"{collection}/{filename}" if collection else filename

def _is_better_score(candidate: dict, current: dict):
    """Return True if candidate is better than current.
    Ranking: fastest time first, then least wrong steps."""
    if not current:
        return True
    ct = current.get('time', 10**9)
    cw = current.get('wrong', 10**9)
    nt = candidate.get('time', 10**9)
    nw = candidate.get('wrong', 10**9)
    if nt < ct:
        return True
    if nt == ct and nw < cw:
        return True
    return False

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def allowed_video_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_VIDEO_EXTENSIONS

def _get_collection_image_urls(collection: str):
    """Return signed, directly-usable image URLs for a collection, excluding
    anything the current viewer is blocked from (see _effective_blocked_pairs)."""
    tags_data = _load_tags()
    blocked = _effective_blocked_pairs(current_user, collection)
    prefix = f"{collection}/"
    urls = []
    for key, value in tags_data.items():
        if key.startswith(prefix) and isinstance(value, dict) and value.get('url'):
            if _image_visible_to_user(value.get('body_parts', {}), blocked):
                urls.append(value['url'])
    return urls

# ── Secure blurred image proxy ──────────────────────────────────────────────────
# Cloudinary delivery is public/unsigned, so a CSS blur or a Cloudinary transform
# URL can both be trivially undone by editing the URL — this route is the only
# way to guarantee a blocked viewer's browser never receives the original bytes.
# Only images whose tags are "globally sensitive" (blocked for SOMEONE, not
# necessarily this viewer) are routed through here at all — see collection_view().

_blur_cache = {}  # f"{collection}/{filename}" -> (bytes, content_type) — not per-viewer,
                  # the blurred bytes are identical regardless of who's blocked.

def _blur_image_bytes(raw_bytes: bytes):
    """Downsample-then-blur-then-upsample: guarantees no recoverable detail and is
    cheap regardless of source resolution (blurring a 32px image is near-instant)."""
    img = Image.open(io.BytesIO(raw_bytes)).convert('RGB')
    original_size = img.size
    img.thumbnail((32, 32), Image.BILINEAR)
    img = img.filter(ImageFilter.GaussianBlur(radius=4))
    img = img.resize(original_size, Image.BILINEAR)
    out = io.BytesIO()
    img.save(out, format='JPEG', quality=80)
    return out.getvalue()

@app.route('/img/<collection>/<filename>')
@login_required
def image_proxy(collection, filename):
    safe_name = _safe_collection_name(collection)
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT url, body_parts FROM images WHERE collection_name = %s AND filename = %s AND deleted_at IS NULL",
            (safe_name, filename)
        )
        row = cur.fetchone()
    finally:
        _release_db(conn)

    if not row:
        return "Image not found", 404
    image_url, body_parts = row
    body_parts = dict(body_parts) if body_parts else {}

    blocked = _effective_blocked_pairs(current_user, safe_name)
    if _image_visible_to_user(body_parts, blocked):
        # Not blocked for this viewer — nothing to protect, send them straight to
        # the real asset rather than paying a server round-trip for no reason.
        return redirect(image_url)

    cache_key = _get_image_key(safe_name, filename)
    cached = _blur_cache.get(cache_key)
    if cached is None:
        if not _HTTP_AVAILABLE:
            return "Image temporarily unavailable", 503
        try:
            resp = _http.get(image_url, timeout=15)
            resp.raise_for_status()
            blurred = _blur_image_bytes(resp.content)
        except Exception:
            return "Image temporarily unavailable", 503
        cached = (blurred, 'image/jpeg')
        _blur_cache[cache_key] = cached

    blurred_bytes, content_type = cached
    return Response(blurred_bytes, mimetype=content_type, headers={'Cache-Control': 'private, max-age=300'})

@app.route('/')
@login_required
def index():
    # Render a home page that lists collections and image counts, plus top scores.
    scores_data = _load_scores()
    leaderboards = {}
    for coll, entries in scores_data.items():
        if isinstance(entries, list):
            leaderboards[coll] = entries[:5]
        else:
            leaderboards[coll] = []

    # Count images per collection from tags.json, excluding whatever this
    # viewer is blocked from so the count matches what they'll actually see.
    tags_data = _load_tags()
    blocked_by_collection = _effective_blocked_pairs_by_collection(current_user)
    collections = {}
    for key, value in tags_data.items():
        if '/' in key and isinstance(value, dict) and value.get('url'):
            coll_name = key.split('/')[0]
            if _image_visible_to_user(value.get('body_parts', {}), blocked_by_collection.get(coll_name, set())):
                collections[coll_name] = collections.get(coll_name, 0) + 1

    # Include empty collections
    for coll_name in _load_collections():
        collections.setdefault(coll_name, 0)

    return render_template('home.html', collections=collections, leaderboards=leaderboards)


def _safe_collection_name(name: str):
    # allow alphanumeric, dash, underscore only
    if not name:
        return ''
    if re.match(r'^[A-Za-z0-9_-]+$', name):
        return name
    return ''


@app.route('/collection/<collection_name>')
@login_required
def collection_view(collection_name):
    collection = _safe_collection_name(collection_name)
    tags_data = _load_tags()
    images = []      # list of filenames (used as keys for tags/delete operations)
    image_urls = {}  # filename -> displayable URL (direct Cloudinary, or /img/ proxy for sensitive tags)
    image_tags = {}
    image_blocked = {}  # filename -> True if THIS viewer specifically is blocked (drives the lock overlay)

    # Images with a tag blocked for anyone (not just this viewer) are routed through
    # the blurred proxy so the URL shape never reveals which images are "sensitive"
    # for a specific person — the proxy itself decides sharp-vs-blurred per viewer.
    sensitive_pairs = _globally_sensitive_pairs(collection)
    blocked = _effective_blocked_pairs(current_user, collection)

    prefix = f"{collection}/"
    for key, value in tags_data.items():
        if not key.startswith(prefix):
            continue
        filename = key[len(prefix):]
        if not isinstance(value, dict) or not value.get('url'):
            continue
        images.append(filename)
        body_parts = value.get('body_parts', {}) or {}
        is_globally_sensitive = any((k, v) in sensitive_pairs for k, v in body_parts.items())
        if is_globally_sensitive:
            image_urls[filename] = url_for('image_proxy', collection=collection, filename=filename)
        else:
            image_urls[filename] = value['url']
        image_blocked[filename] = not _image_visible_to_user(body_parts, blocked)
        raw_tags = value.get('tags', [])
        if isinstance(raw_tags, list):
            image_tags[filename] = [str(t) for t in raw_tags if isinstance(t, (str, int, float))]
        else:
            image_tags[filename] = []

    videos = _visible_videos_for_user(current_user, collection) if _user_can_view_any_video_in_collection(current_user, collection) else None

    return render_template('index.html', images=images, collection=collection,
                           image_tags=image_tags, image_urls=image_urls, videos=videos,
                           image_blocked=image_blocked)

@app.route('/upload', methods=['POST'])
@app.route('/upload/<collection>', methods=['POST'])
def upload_file(collection=None):
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400

    if file and allowed_file(file.filename):
        collection = _safe_collection_name(collection or '')
        ext = os.path.splitext(secure_filename(file.filename))[1].lower()
        img_uuid = str(uuid.uuid4())
        filename = img_uuid + ext
        key = _get_image_key(collection, filename)  # B2 backup key
        public_id = f"{collection}/{img_uuid}" if collection else img_uuid  # Cloudinary, no extension

        buf = io.BytesIO(file.stream.read())  # read once, reused for both uploads

        try:
            buf.seek(0)
            cloudinary_url = _cloudinary_upload(buf, public_id)
        except Exception as e:
            return jsonify({'error': f'Upload failed: {str(e)}'}), 500

        b2_backup_key = None
        try:
            buf.seek(0)
            _b2_upload_fileobj(buf, key, file.mimetype)
            b2_backup_key = key
        except Exception as e:
            app.logger.warning(f'B2 backup upload failed for {key}: {e}')

        if collection:
            user_id = current_user.id if current_user.is_authenticated else None
            _db_insert_image(collection, filename, cloudinary_url, user_id=user_id, b2_backup_key=b2_backup_key)

        return jsonify({
            'success': True,
            'filename': filename,
            'url': cloudinary_url,
            'tags': []
        })

    return jsonify({'error': 'Invalid file type'}), 400

@app.route('/upload-video/<collection>', methods=['POST'])
@admin_required
def upload_video(collection):
    """Admin-only: upload a video into a collection's B2 folder. Hidden from
    all users by default — access must be granted separately via the video access APIs."""
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400

    if not allowed_video_file(file.filename):
        return jsonify({'error': 'Invalid file type'}), 400

    safe_name = _safe_collection_name(collection)
    if not safe_name:
        return jsonify({'error': 'Invalid collection name'}), 400

    ext = os.path.splitext(secure_filename(file.filename))[1].lower()
    filename = str(uuid.uuid4()) + ext
    key = _get_image_key(safe_name, filename)

    try:
        _b2_upload_fileobj(file.stream, key, file.mimetype)
    except Exception as e:
        return jsonify({'error': f'Upload failed: {str(e)}'}), 500

    # B2 has no Cloudinary-style auto thumbnail/duration probe (would need ffmpeg) —
    # videos uploaded from here on simply have no poster image / duration metadata.
    _db_insert_video(safe_name, filename, key, thumbnail_url=None,
                      duration=None, user_id=current_user.id)

    return jsonify({
        'success': True,
        'filename': filename,
        'url': _b2_sign_url(key),
        'thumbnail_url': None,
    })

@app.route('/get-quote')
def get_quote():
    """
    Get a quote based on image tags with flexible matching.
    Expects query param 'collection' and 'filename' to look up tags.
    Falls back to random quote from 'default' if no tags or no match.
    Uses gquotes.json for collections starting with 'G', otherwise quotes.json.
    """
    try:
        # Try to get image tags
        collection = request.args.get('collection', '')
        
        # Load quotes from JSON - use gquotes.json for collections starting with 'G'
        if collection and collection.lower().startswith('g'):
            quotes_path = os.path.join('static', 'gquotes.json')
        else:
            quotes_path = os.path.join('static', 'quotes.json')
        
        with open(quotes_path, 'r', encoding='utf-8') as f:
            quotes_data = json.load(f)
        filename = request.args.get('filename', '')
        
        if collection and filename:
            all_tags = _load_tags()
            image_key = _get_image_key(collection, filename)
            image_data = all_tags.get(image_key)
            
            # Handle both new format (list of strings) and old format (dict with 'detailed')
            image_tag_names = []
            if isinstance(image_data, list):
                # New format: direct list of tag strings
                image_tag_names = [tag.lower().strip() for tag in image_data if isinstance(tag, str)]
            elif isinstance(image_data, dict):
                # Old format: dict with 'detailed' or 'tags' key
                detailed_tags = image_data.get('detailed', [])
                if detailed_tags:
                    image_tag_names = [tag_obj.get('tag', '').lower().strip() for tag_obj in detailed_tags if tag_obj.get('tag')]
                else:
                    # Fallback to 'tags' key if 'detailed' is empty
                    simple_tags = image_data.get('tags', [])
                    image_tag_names = [tag.lower().strip() for tag in simple_tags if isinstance(tag, str)]
            
            if image_tag_names:
                # Filter out internal tags (those starting with prefixes like "c ", "sn ", "n ", etc.)
                # Internal tags are used for classification but shouldn't be matched to quotes
                internal_prefixes = ('c ', 'sn ', 'n ', 'c_', 'sn_', 'n_')
                filtered_tags = [
                    tag for tag in image_tag_names 
                    if not any(tag.startswith(prefix) for prefix in internal_prefixes)
                ]
                
                # If all tags are internal, use them anyway to try to find a match
                tags_to_match = filtered_tags if filtered_tags else image_tag_names
                
                # Iterate through quote keys in order (preserving JSON order)
                # Skip 'default' key in priority matching
                for quote_key in quotes_data.keys():
                    if quote_key == 'default':
                        continue
                    
                    # Check if any image tag matches this quote key
                    for tag in tags_to_match:
                        if _tags_match(tag, quote_key):
                            quote = random.choice(quotes_data[quote_key])
                            return jsonify({'quote': quote, 'matched_tag': quote_key})
        
        # Fall back to default
        if 'default' in quotes_data:
            quote = random.choice(quotes_data['default'])
            return jsonify({'quote': quote, 'matched_tag': 'default'})
        
        return jsonify({'quote': 'No quotes available.'}), 404
        
    except Exception as e:
        print(f"[get-quote] Error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


def _tags_match(tag, quote_key):
    """
    Check if a tag matches a quote key using flexible matching:
    1. Exact match (normalized: spaces/underscores/hyphens)
    2. Tag contains quote key
    3. Quote key contains tag
    Returns True if match found, False otherwise.
    """
    # Normalize for comparison
    tag_normalized = tag.replace('_', ' ').replace('-', ' ').lower().strip()
    key_normalized = quote_key.replace('_', ' ').replace('-', ' ').lower().strip()
    
    # Exact match
    if tag_normalized == key_normalized:
        return True
    
    # Tag contains key (e.g., tag="long black hair", key="black hair")
    if key_normalized in tag_normalized:
        return True
    
    # Key contains tag (e.g., tag="black", key="black_hair")
    if tag_normalized in key_normalized:
        return True
    
    return False

def _find_matching_quote_key(tag, quote_keys):
    """
    Flexible tag matching:
    1. Exact match (normalized: spaces/underscores)
    2. Tag contains quote key
    3. Quote key contains tag
    Returns the first matching quote key or None.
    """
    # Normalize for comparison
    tag_normalized = tag.replace('_', ' ').replace('-', ' ').lower().strip()
    
    for key in quote_keys:
        if key == 'default':
            continue
            
        key_normalized = key.replace('_', ' ').replace('-', ' ').lower().strip()
        
        # Exact match
        if tag_normalized == key_normalized:
            return key
        
        # Tag contains key (e.g., tag="long black hair", key="black hair")
        if key_normalized in tag_normalized:
            return key
        
        # Key contains tag (e.g., tag="black", key="black_hair")
        if tag_normalized in key_normalized:
            return key

    return None


@app.route('/api/images/<collection_name>/<filename>/ai-quote', methods=['GET'])
def api_get_ai_quote(collection_name, filename):
    """
    Return the cached AI-generated quote for an image, if one has been generated yet.
    The actual HF call happens client-side (the server has no outbound path to
    huggingface.co — see _call_hf_inference's comments / chat.js), so this endpoint
    only ever reads/writes the cache; it never calls the model itself.
    """
    safe_name = _safe_collection_name(collection_name)
    quote = _get_image_ai_quote(safe_name, filename)
    return jsonify({'success': True, 'quote': quote, 'cached': bool(quote)})


@app.route('/api/images/<collection_name>/<filename>/ai-quote-prompt', methods=['GET'])
def api_get_ai_quote_prompt(collection_name, filename):
    """
    Build the system/user prompt the client should send to HuggingFace to generate
    a quote for this image. Returns 422 if there's not enough tag/body-part/model
    data on the image yet to build a meaningful prompt (caller should keep using
    the static quote bank in that case).
    """
    safe_name = _safe_collection_name(collection_name)
    prompt = _build_ai_quote_prompt(safe_name, filename)
    if prompt is None:
        return jsonify({'success': False, 'error': 'Not enough tag data for this image yet'}), 422
    return jsonify({'success': True, **prompt})


@app.route('/api/images/<collection_name>/<filename>/ai-quote', methods=['POST'])
def api_save_ai_quote(collection_name, filename):
    """Cache a client-generated quote for an image (used for first-generation and regenerate)."""
    if not current_user.is_authenticated:
        return jsonify({'success': False, 'error': 'Authentication required'}), 401

    safe_name = _safe_collection_name(collection_name)
    data = request.get_json() or {}
    quote = str(data.get('quote', '')).strip()

    if not quote:
        return jsonify({'success': False, 'error': 'quote is required'}), 400
    if len(quote) > 500:
        return jsonify({'success': False, 'error': 'quote is too long'}), 400
    if not _image_exists_in_tags(safe_name, filename):
        return jsonify({'success': False, 'error': 'Image not found'}), 404

    _set_image_ai_quote(safe_name, filename, quote)
    return jsonify({'success': True, 'quote': quote})


@app.route('/api/settings/ai-quote-prompt', methods=['GET'])
@admin_required
def api_get_ai_quote_prompt_setting():
    """Admin: read the current (or default) AI-quote system prompt template."""
    template = _get_setting('ai_quote_system_prompt', DEFAULT_AI_QUOTE_SYSTEM_PROMPT)
    return jsonify({
        'success':   True,
        'template':  template,
        'default':   DEFAULT_AI_QUOTE_SYSTEM_PROMPT,
        'model':     _QUOTE_HF_MODEL,
        'maxTokens': _QUOTE_HF_MAX_TOKENS,
        'apiBase':   _QUOTE_CHAT_API_BASE_URL,
    })


@app.route('/api/settings/ai-quote-prompt', methods=['POST'])
@admin_required
def api_save_ai_quote_prompt_setting():
    """Admin: update the AI-quote system prompt template. Takes effect on the next generation — already-cached quotes are unaffected until regenerated."""
    data = request.get_json() or {}
    template = str(data.get('template', '')).strip()

    if not template:
        return jsonify({'success': False, 'error': 'Template is required'}), 400
    if len(template) > 4000:
        return jsonify({'success': False, 'error': 'Template is too long (max 4000 characters)'}), 400
    if '{name_instruction}' not in template:
        return jsonify({'success': False, 'error': 'Template must include the {name_instruction} placeholder'}), 400

    _set_setting('ai_quote_system_prompt', template)
    return jsonify({'success': True, 'template': template})


@app.route('/manage-quote-prompt')
def manage_quote_prompt_view():
    """Admin page for editing the AI-quote system prompt template."""
    if not current_user.is_authenticated or not current_user.is_admin:
        return redirect(url_for('login_page'))
    return render_template('manage-quote-prompt.html')


@app.route('/create-collection', methods=['POST'])
@admin_required
def create_collection():
    try:
        data = request.get_json() or {}
        name = data.get('name') or request.form.get('name')
        if not name:
            return jsonify({'error': 'Collection name required'}), 400
        safe = _safe_collection_name(name)
        if not safe:
            return jsonify({'error': 'Invalid collection name'}), 400
        if _collection_exists(safe):
            return jsonify({'error': 'Collection already exists'}), 409
        _ensure_collection(safe)
        return jsonify({'success': True, 'name': safe})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

def _calculate_score(time_val: int, wrong_val: int, pairs: int, match_size: int):
    """Calculate score based on game parameters.
    Formula:
    - Base: pairs × match_size × 1000 (reward difficulty and match complexity)
    - Time penalty: -time in seconds
    - Wrong penalty: -wrong × 50
    - Minimum score: 0
    Higher difficulty (more pairs) and larger match sizes yield higher scores.
    Faster times and fewer mistakes maximize score.
    """
    base_score = pairs * match_size * 1000
    time_penalty = time_val
    wrong_penalty = wrong_val * 50
    final_score = max(0, base_score - time_penalty - wrong_penalty)
    return final_score

@app.route('/api/submit-score', methods=['POST'])
def submit_score():
    """Accept a finished game score."""
    if not current_user.is_authenticated:
        return jsonify({'success': False, 'error': 'Authentication required'}), 401
    try:
        data = request.get_json() or {}
        collection = _safe_collection_name(str(data.get('collection') or ''))
        if not collection:
            return jsonify({'error': 'Invalid or missing collection'}), 400
        
        game_type = str(data.get('gameType', 'memory')).lower()
        allowed_games = ['memory', 'flashcards', 'hunt', 'puzzle', 'sequence', 'zoom', 'whack', 'recall', 'missing', 'trail', 'remix', 'tag-match', 'oddoneout', 'speedsort', 'snap', 'spotlight', 'flashmemory', 'whoisthat', 'bracket', 'scratch', 'behindblur', 'silhouette', 'towerdefense', 'heatmap', 'gallerywalk', 'breakout', 'bubbleburst', 'shootinggallery', 'orbitingvault', 'cargobay', 'timeloop', 'heistdrone', 'versuszoom', 'memorymatch']
        if game_type not in allowed_games:
            game_type = 'memory'
        
        username = str(data.get('username') or 'Anonymous').strip()[:30]

        # Build entry based on game type
        entry = {
            'username': username,
            'gameType': game_type
        }

        # Add game-specific metrics
        if game_type == 'memory':
            time_val = int(data.get('time', 0))
            wrong_val = int(data.get('wrong', 0))
            moves_val = int(data.get('moves', 0))
            pairs = int(data.get('pairs', 8))
            match_size = int(data.get('matchSize', 2))
            score = _calculate_score(time_val, wrong_val, pairs, match_size)
            entry.update({
                'score': score,
                'time': time_val,
                'wrong': wrong_val,
                'moves': moves_val,
                'pairs': pairs,
                'matchSize': match_size
            })
        elif game_type == 'flashcards':
            score = int(data.get('score', 0))
            level = int(data.get('level', 1))
            time_val = int(data.get('time', 0))
            entry.update({
                'score': score,
                'level': level,
                'time': time_val
            })
        elif game_type == 'hunt':
            score = int(data.get('score', 0))
            time_val = int(data.get('time', 0))
            entry.update({
                'score': score,
                'time': time_val
            })
        elif game_type == 'zoom':
            score = int(data.get('score', 0))
            rounds = int(data.get('rounds', 0))
            time_val = int(data.get('time', 0))
            entry.update({
                'score': score,
                'rounds': rounds,
                'time': time_val
            })
        elif game_type == 'whack':
            score = int(data.get('score', 0))
            time_val = int(data.get('time', 0))
            clicks = int(data.get('clicks', 0))
            entry.update({
                'score': score,
                'time': time_val,
                'clicks': clicks
            })
        else:  # puzzle, sequence, etc.
            score = int(data.get('score', 0))
            time_val = int(data.get('time', 0))
            entry.update({
                'score': score,
                'time': time_val
            })

        conn = _get_db()
        try:
            cur = conn.cursor()
            # Insert new score row
            cur.execute(
                "INSERT INTO scores (collection_name, game_type, data, user_id) VALUES (%s, %s, %s, %s)",
                (collection, game_type, json.dumps(entry), current_user.id)
            )
            # Keep only top 10 for this (collection, game_type)
            cur.execute("""
                DELETE FROM scores
                WHERE collection_name = %s AND game_type = %s
                  AND id NOT IN (
                      SELECT id FROM scores
                      WHERE collection_name = %s AND game_type = %s
                      ORDER BY (data->>'score')::int DESC,
                               (data->>'time')::int  ASC NULLS LAST
                      LIMIT 10
                  )
            """, (collection, game_type, collection, game_type))
            # Fetch current top 5 for the response
            cur.execute("""
                SELECT data FROM scores
                WHERE collection_name = %s AND game_type = %s
                ORDER BY (data->>'score')::int DESC,
                         (data->>'time')::int  ASC NULLS LAST
                LIMIT 5
            """, (collection, game_type))
            leaderboard = [r[0] for r in cur.fetchall()]
            conn.commit()
        finally:
            _release_db(conn)

        is_top = any(e == entry for e in leaderboard)
        return jsonify({'success': True, 'updated': is_top, 'score': entry.get('score', 0), 'leaderboard': leaderboard})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/high-scores/<collection>')
def get_high_scores(collection):
    """Get top-3 scores for every game type in a collection."""
    try:
        collection = _safe_collection_name(collection)
        if not collection:
            return jsonify({'error': 'Invalid collection'}), 400

        conn = _get_db()
        try:
            cur = conn.cursor()
            cur.execute("""
                SELECT game_type, data
                FROM scores
                WHERE collection_name = %s
                ORDER BY game_type,
                         (data->>'score')::int DESC,
                         (data->>'time')::int  ASC NULLS LAST
            """, (collection,))
            result = {}
            for gtype, data in cur.fetchall():
                bucket = result.setdefault(gtype, [])
                if len(bucket) < 3:
                    bucket.append(data)
        finally:
            _release_db(conn)

        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

def _soft_delete_image_by_collection_and_filename(collection, filename):
    """Shared by both delete-image routes: delete the live Cloudinary asset
    (best-effort) and soft-delete the DB row. The B2 backup is left untouched
    until an admin purges it from /admin/orphaned-images."""
    uuid_part = filename.rsplit('.', 1)[0]
    public_id = f"{collection}/{uuid_part}" if collection else uuid_part
    try:
        _cloudinary_delete(public_id)
    except Exception as e:
        app.logger.warning(f'Cloudinary delete failed for {public_id}: {e}')
    _db_soft_delete_image(collection, filename)


@app.route('/delete-image/<filename>', methods=['DELETE'])
@admin_required
def delete_image(filename):
    try:
        collection = _find_image_collection(filename)
        if collection is None:
            return jsonify({'error': 'Image not found'}), 404
        _soft_delete_image_by_collection_and_filename(collection, filename)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/delete-image/<collection>/<filename>', methods=['DELETE'])
@admin_required
def delete_image_in_collection(collection, filename):
    collection = _safe_collection_name(collection)
    try:
        _soft_delete_image_by_collection_and_filename(collection, filename)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/game')
def game():
    """Render the memory game page using uploaded images.
    We'll pass the list of upload filenames to the template. The template/JS will
    duplicate and shuffle them to build pairs.
    """
    # Default game should show the "Real" collection
    return redirect(url_for('collection_game', collection_name='Real'))


@app.route('/collection/<collection_name>/game')
@login_required
def collection_game(collection_name):
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('game.html', images=image_urls, collection=collection)


@app.route('/puzzle')
def puzzle():
    """Render the puzzle slider game page."""
    return redirect(url_for('collection_puzzle', collection_name='Real'))


@app.route('/collection/<collection_name>/puzzle')
@login_required
def collection_puzzle(collection_name):
    """Render the puzzle slider game for a specific collection."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('puzzle.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/sequence')
@login_required
def collection_sequence(collection_name):
    """Render the sequence memory game for a specific collection."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('sequence.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/flashcards')
@login_required
def collection_flashcards(collection_name):
    """Render the flashcards memory game for a specific collection."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('flashcards.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/hunt')
@login_required
def collection_hunt(collection_name):
    """Simple Image Hunt game: show target image, player must find it in a grid."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('hunt.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/zoom')
@login_required
def collection_zoom(collection_name):
    """Zoom Challenge game: show zoomed-in portion of image, identify which full image it is."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('zoom.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/whack')
@login_required
def collection_whack(collection_name):
    """Whack-a-Mole game: click images as they appear on screen."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('whack.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/recall')
@login_required
def collection_recall(collection_name):
    """Recall Grid game: memorize image positions and select the original spot."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('recall.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/missing')
@login_required
def collection_missing(collection_name):
    """Missing Piece game: identify which image disappeared from the shown grid."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('missing.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/trail')
@login_required
def collection_trail(collection_name):
    """Trail Trace game: follow a route through a memorized image grid."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('trail.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/remix')
@login_required
def collection_remix(collection_name):
    """Remix Match game: identify which stylized remix belongs to the target image."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('remix.html', images=image_urls, collection=collection)


@app.route('/tag-match')
def tag_match():
    """Render the Tag Match memory game page using the Real collection."""
    return redirect(url_for('collection_tag_match', collection_name='Real'))


@app.route('/collection/<collection_name>/tag-match')
@login_required
def collection_tag_match(collection_name):
    """Render the Tag Match memory game for a specific collection."""
    collection = _safe_collection_name(collection_name)
    return render_template('tag-match.html', collection=collection)





@app.route('/api/images')
def api_images_all():
    """Return a JSON list of all image URLs."""
    tags_data = _load_tags()
    result = [
        v['url'] for v in tags_data.values()
        if isinstance(v, dict) and v.get('url')
    ]
    return jsonify({'images': result})


@app.route('/manage-collections')
def manage_collections():
    """Render collection management page."""
    tags_data = _load_tags()
    collections = {}
    for key in tags_data:
        if '/' in key and isinstance(tags_data[key], dict) and tags_data[key].get('url'):
            coll_name = key.split('/')[0]
            collections[coll_name] = collections.get(coll_name, 0) + 1
    for coll_name in _load_collections():
        collections.setdefault(coll_name, 0)
    return render_template('manage-collections.html', collections=collections)


@app.route('/api/collections/create', methods=['POST'])
@admin_required
def api_create_collection():
    """Register a new collection (B2 folder is created on first upload)."""
    data = request.get_json()
    name = data.get('name', '').strip()

    if not name:
        return jsonify({'success': False, 'error': 'Collection name required'}), 400

    safe_name = _safe_collection_name(name)
    if not safe_name or safe_name != name:
        return jsonify({'success': False, 'error': 'Invalid collection name. Use only letters, numbers, hyphens, and underscores'}), 400

    if _collection_exists(safe_name):
        return jsonify({'success': False, 'error': 'Collection already exists'}), 400

    try:
        _ensure_collection(safe_name)
        return jsonify({'success': True, 'message': 'Collection created'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/collections/rename', methods=['POST'])
@admin_required
def api_rename_collection():
    """Rename a collection: moves all B2 assets and updates the images/videos tables."""
    data = request.get_json()
    old_name = data.get('old_name', '').strip()
    new_name = data.get('new_name', '').strip()

    if not old_name or not new_name:
        return jsonify({'success': False, 'error': 'Both names required'}), 400

    safe_old = _safe_collection_name(old_name)
    safe_new = _safe_collection_name(new_name)

    if not safe_new or safe_new != new_name:
        return jsonify({'success': False, 'error': 'Invalid new name'}), 400

    if not _collection_exists(safe_old):
        return jsonify({'success': False, 'error': 'Collection not found'}), 404

    if _collection_exists(safe_new):
        return jsonify({'success': False, 'error': 'Target name already exists'}), 400

    try:
        # Create new collection record first
        _ensure_collection(safe_new)

        # Rename each image's Cloudinary asset and update its DB row. The B2 backup
        # key is deliberately left unchanged (still under the old collection prefix)
        # — B2 is never listed by folder for images, only looked up by the stored
        # b2_backup_key column, so it doesn't need to move.
        #
        # collection_name is always moved to safe_new (the old collection row gets
        # deleted below, which would CASCADE-delete any row still pointing at it).
        # url is only updated if the Cloudinary rename actually succeeded — if it
        # failed, the old url is left as-is, which still resolves correctly since
        # the asset never moved; it's just left under the old collection's folder
        # in Cloudinary until a manual retry.
        conn = _get_db()
        try:
            cur = conn.cursor()
            cur.execute(
                "SELECT filename, url FROM images WHERE collection_name = %s AND deleted_at IS NULL",
                (safe_old,)
            )
            rows = cur.fetchall()
        finally:
            _release_db(conn)

        for filename, old_url in rows:
            uuid_part = filename.rsplit('.', 1)[0]
            old_public_id = f"{safe_old}/{uuid_part}"
            new_public_id = f"{safe_new}/{uuid_part}"
            new_url = old_url
            try:
                new_url = _cloudinary_rename(old_public_id, new_public_id)
            except Exception as e:
                app.logger.warning(f'Cloudinary rename failed for {old_public_id}: {e}')

            conn = _get_db()
            try:
                cur = conn.cursor()
                cur.execute("""
                    UPDATE images
                    SET collection_name = %s, url = %s
                    WHERE collection_name = %s AND filename = %s
                """, (safe_new, new_url, safe_old, filename))
                conn.commit()
            finally:
                _release_db(conn)

        # Carry over any already soft-deleted image rows too — their Cloudinary
        # asset is already gone (nothing to rename), but they still need to move
        # off the old collection_name so they aren't cascade-deleted when the old
        # collections row is dropped below (which would wipe their orphan-page
        # visibility as a side effect of an otherwise-safe rename).
        conn = _get_db()
        try:
            cur = conn.cursor()
            cur.execute(
                "UPDATE images SET collection_name = %s WHERE collection_name = %s AND deleted_at IS NOT NULL",
                (safe_new, safe_old)
            )
            conn.commit()
        finally:
            _release_db(conn)

        # Move each video object to the new prefix and update its DB row
        conn = _get_db()
        try:
            cur = conn.cursor()
            cur.execute(
                "SELECT filename, url FROM videos WHERE collection_name = %s",
                (safe_old,)
            )
            video_rows = cur.fetchall()
        finally:
            _release_db(conn)

        for filename, old_url in video_rows:
            new_url = old_url
            try:
                new_url = _b2_move_object(
                    _get_image_key(safe_old, filename),
                    _get_image_key(safe_new, filename)
                )
            except Exception:
                pass

            conn = _get_db()
            try:
                cur = conn.cursor()
                cur.execute("""
                    UPDATE videos
                    SET collection_name = %s, url = %s
                    WHERE collection_name = %s AND filename = %s
                """, (safe_new, new_url, safe_old, filename))
                conn.commit()
            finally:
                _release_db(conn)

        # Carry over collection-level video access grants to the new name
        # (they'd otherwise be lost when the old collection row cascade-deletes below)
        conn = _get_db()
        try:
            cur = conn.cursor()
            cur.execute(
                "UPDATE video_collection_access SET collection_name = %s WHERE collection_name = %s",
                (safe_new, safe_old)
            )
            conn.commit()
        finally:
            _release_db(conn)

        # Remove old collection record (all images/videos already moved above)
        conn = _get_db()
        try:
            cur = conn.cursor()
            cur.execute("DELETE FROM collections WHERE name = %s", (safe_old,))
            conn.commit()
        finally:
            _release_db(conn)

        return jsonify({'success': True, 'message': 'Collection renamed'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/collections/delete', methods=['POST'])
@admin_required
def api_delete_collection():
    """Delete a collection and all its images/videos."""
    data = request.get_json()
    name = data.get('name', '').strip()

    if not name:
        return jsonify({'success': False, 'error': 'Collection name required'}), 400

    safe_name = _safe_collection_name(name)

    if not _collection_exists(safe_name):
        return jsonify({'success': False, 'error': 'Collection not found'}), 404

    try:
        # Delete all live Cloudinary image assets under this collection's folder
        try:
            _cloudinary_delete_prefix(f"{safe_name}/")
        except Exception:
            pass

        # Delete all B2 objects under this collection's folder — video assets plus
        # any orphaned image backups (Cloudinary is the only live copy for images,
        # so this is purely backup cleanup on the image side)
        try:
            _b2_delete_prefix(f"{safe_name}/")
        except Exception:
            pass

        # DELETE FROM collections CASCADE-deletes all images/videos rows automatically,
        # including any already soft-deleted image rows — collection delete is always
        # a full, irreversible purge (unlike individual image delete, it does not go
        # through the soft-delete/orphan-recovery flow).
        conn = _get_db()
        try:
            cur = conn.cursor()
            cur.execute("DELETE FROM collections WHERE name = %s", (safe_name,))
            conn.commit()
        finally:
            _release_db(conn)

        return jsonify({'success': True, 'message': 'Collection deleted'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/collections/<collection_name>/images', methods=['GET'])
def api_collection_images(collection_name):
    """Get all images in a collection with their tags and lock status."""
    safe_name = _safe_collection_name(collection_name)

    if not _collection_exists(safe_name):
        return jsonify({'success': False, 'error': 'Collection not found'}), 404

    tags_data = _load_tags()
    image_models = _get_collection_image_model_map(safe_name)
    blocked = _effective_blocked_pairs(current_user, safe_name)
    images = []
    prefix = f"{safe_name}/"

    for key, value in tags_data.items():
        if not key.startswith(prefix):
            continue
        filename = key[len(prefix):]
        if not isinstance(value, dict) or not value.get('url'):
            continue
        normalized = _normalize_tags_entry(value)
        if not _image_visible_to_user(normalized.get('body_parts', {}), blocked):
            continue
        images.append({
            'filename':   filename,
            'url':        value['url'],
            'tags':       normalized['tags'],
            'body_parts': normalized.get('body_parts', {}),
            'locked':     normalized.get('locked', False),
            'models':     image_models.get(filename, [])
        })

    return jsonify({'success': True, 'images': images})


@app.route('/api/images/<collection_name>/<filename>/tags', methods=['POST'])
@admin_required
def api_update_image_tags(collection_name, filename):
    """Update tags for a specific image."""
    data = request.get_json()
    tags = data.get('tags', [])
    
    if not isinstance(tags, list):
        return jsonify({'success': False, 'error': 'Tags must be an array'}), 400
    
    # Validate tags (remove empty strings and duplicates)
    tags = [t.strip() for t in tags if t.strip()]
    tags = list(set(tags))  # Remove duplicates
    
    safe_name = _safe_collection_name(collection_name)
    
    # Use new function to set tags while preserving locked status
    _set_image_tags(safe_name, filename, tags)
    
    return jsonify({'success': True, 'tags': tags})


@app.route('/api/images/<collection_name>/<filename>/retag', methods=['POST'])
def api_retag_image(collection_name, filename):
    """Auto-generate tags for a specific image (disabled — no tagger configured)."""
    return jsonify({'success': False, 'error': 'Auto-tagging is not available'}), 501


@app.route('/api/collections/<collection_name>/retag-all', methods=['POST'])
def api_retag_all_images(collection_name):
    """Auto-generate tags for all images in a collection (disabled — no tagger configured)."""
    return jsonify({'success': False, 'error': 'Auto-tagging is not available'}), 501


@app.route('/api/images/<collection_name>/<filename>/lock', methods=['POST'])
@admin_required
def api_lock_image(collection_name, filename):
    """Lock an image so it won't be retagged during retag-all."""
    safe_name = _safe_collection_name(collection_name)
    if not _image_exists_in_tags(safe_name, filename):
        return jsonify({'success': False, 'error': 'Image not found'}), 404
    _set_image_locked(safe_name, filename, True)
    return jsonify({'success': True, 'locked': True, 'message': 'Image locked'})


@app.route('/api/images/<collection_name>/<filename>/unlock', methods=['POST'])
@admin_required
def api_unlock_image(collection_name, filename):
    """Unlock an image so it can be retagged."""
    safe_name = _safe_collection_name(collection_name)
    if not _image_exists_in_tags(safe_name, filename):
        return jsonify({'success': False, 'error': 'Image not found'}), 404
    _set_image_locked(safe_name, filename, False)
    return jsonify({'success': True, 'locked': False, 'message': 'Image unlocked'})


@app.route('/api/images/<collection_name>/<filename>/lock-status', methods=['GET'])
def api_get_lock_status(collection_name, filename):
    """Get lock status for an image."""
    safe_name = _safe_collection_name(collection_name)
    locked = _get_image_locked_status(safe_name, filename)
    tags = _get_image_tags(safe_name, filename)
    return jsonify({'success': True, 'locked': locked, 'tags': tags})


@app.route('/api/images/<collection_name>/<source_filename>/copy-tags/<target_filename>', methods=['POST'])
@admin_required
def api_copy_image_tags(collection_name, source_filename, target_filename):
    """Copy tags and model(s) from source image to target image."""
    safe_name = _safe_collection_name(collection_name)

    if not _image_exists_in_tags(safe_name, source_filename):
        return jsonify({'success': False, 'error': 'Source image not found'}), 404
    if not _image_exists_in_tags(safe_name, target_filename):
        return jsonify({'success': False, 'error': 'Target image not found'}), 404

    source_tags = _get_image_tags(safe_name, source_filename)
    _set_image_tags(safe_name, target_filename, source_tags)

    source_model_ids = _get_image_model_ids(safe_name, source_filename)
    _set_image_models(safe_name, target_filename, source_model_ids)

    return jsonify({'success': True, 'tags': source_tags, 'message': f'Copied {len(source_tags)} tags to target image'})


@app.route('/tagger/<collection_name>')
@admin_required
def tagger_view(collection_name):
    safe_name = _safe_collection_name(collection_name)
    if not _collection_exists(safe_name):
        return "Collection not found", 404
    tags_data = _load_tags()
    image_models = _get_collection_image_model_map(safe_name)
    images = []
    prefix = f"{safe_name}/"
    for key, value in sorted(tags_data.items()):
        if not key.startswith(prefix) or not isinstance(value, dict) or not value.get('url'):
            continue
        filename = key[len(prefix):]
        images.append({
            'filename':   filename,
            'url':        value['url'],
            'tags':       value.get('tags', []),
            'body_parts': value.get('body_parts', {}),
            'model_ids':  [m['id'] for m in image_models.get(filename, [])],
        })
    return render_template('tagger.html',
                           collection=safe_name,
                           images=images,
                           body_parts=BODY_PARTS,
                           all_models=_get_all_models())


@app.route('/api/images/<collection_name>/<filename>/body-parts', methods=['POST'])
@admin_required
def api_update_body_parts(collection_name, filename):
    """Save structured body-part ratings and free-form tags for one image."""
    data = request.get_json() or {}
    safe_name = _safe_collection_name(collection_name)

    if not _image_exists_in_tags(safe_name, filename):
        return jsonify({'success': False, 'error': 'Image not found'}), 404

    raw_parts = data.get('body_parts', {})
    cleaned_parts = {k: v for k, v in raw_parts.items()
                     if k in BODY_PARTS and v in VALID_RATINGS}

    if 'tags' in data:
        cleaned_tags = [str(t).strip() for t in data['tags'] if t and str(t).strip()]
        _set_image_body_parts_and_tags(safe_name, filename, cleaned_parts, cleaned_tags)
    else:
        # Body parts only — leave tags unchanged
        conn = _get_db()
        try:
            cur = conn.cursor()
            cur.execute(
                "UPDATE images SET body_parts = %s::jsonb WHERE collection_name = %s AND filename = %s",
                (json.dumps(cleaned_parts), safe_name, filename)
            )
            conn.commit()
        finally:
            _release_db(conn)

    if 'model_ids' in data:
        raw_model_ids = data['model_ids']
        if not isinstance(raw_model_ids, list):
            return jsonify({'success': False, 'error': 'model_ids must be an array'}), 400
        try:
            raw_model_ids = [int(m) for m in raw_model_ids]
        except (TypeError, ValueError):
            return jsonify({'success': False, 'error': 'model_ids must contain only integers'}), 400
        _set_image_models(safe_name, filename, raw_model_ids)

    return jsonify({'success': True})


@app.route('/api/images/<collection_name>/bulk-tag', methods=['POST'])
@admin_required
def api_bulk_tag_images(collection_name):
    """Apply tags and/or model names to many images at once (additive — does not remove existing values)."""
    data = request.get_json() or {}
    safe_name = _safe_collection_name(collection_name)

    if not _collection_exists(safe_name):
        return jsonify({'success': False, 'error': 'Collection not found'}), 404

    filenames = data.get('filenames', [])
    if not isinstance(filenames, list) or not filenames:
        return jsonify({'success': False, 'error': 'filenames must be a non-empty array'}), 400

    tags = data.get('tags', [])
    model_ids = data.get('model_ids', [])
    if not isinstance(tags, list) or not isinstance(model_ids, list):
        return jsonify({'success': False, 'error': 'tags and model_ids must be arrays'}), 400
    try:
        model_ids = [int(m) for m in model_ids]
    except (TypeError, ValueError):
        return jsonify({'success': False, 'error': 'model_ids must contain only integers'}), 400

    matched = _count_existing_images(safe_name, filenames)

    if tags:
        _bulk_add_image_tags(safe_name, filenames, tags)
    if model_ids:
        _bulk_add_image_models(safe_name, filenames, model_ids)

    return jsonify({'success': True, 'updated': matched})


@app.route('/api/models', methods=['GET'])
def api_list_models():
    """List all models (id + name) — feeds the tagger's autocomplete."""
    return jsonify({'success': True, 'models': _get_all_models()})


@app.route('/api/models-with-counts', methods=['GET'])
def api_models_with_counts():
    """List all models with how many images reference each — feeds admin page + browse page."""
    return jsonify({'success': True, 'models': _get_models_with_counts()})


@app.route('/api/models', methods=['POST'])
@admin_required
def api_create_model():
    """Admin: register a new canonical model name."""
    data = request.get_json() or {}
    name = (data.get('name') or '').strip()
    gender = (data.get('gender') or 'unspecified').strip()
    if not name:
        return jsonify({'success': False, 'error': 'Name required'}), 400
    if gender not in VALID_MODEL_GENDERS:
        return jsonify({'success': False, 'error': 'Invalid gender'}), 400
    model_id = _create_model(name, gender)
    if model_id is None:
        return jsonify({'success': False, 'error': 'A model with that name already exists'}), 400
    return jsonify({'success': True, 'model': {'id': model_id, 'name': name, 'gender': gender}})


@app.route('/api/models/<int:model_id>/gender', methods=['POST'])
@admin_required
def api_set_model_gender(model_id):
    """Admin: update a model's gender — used to pick the correct pronoun in the AI quote prompt."""
    data = request.get_json() or {}
    gender = (data.get('gender') or '').strip()
    if gender not in VALID_MODEL_GENDERS:
        return jsonify({'success': False, 'error': 'Invalid gender'}), 400
    if not _set_model_gender(model_id, gender):
        return jsonify({'success': False, 'error': 'Model not found'}), 404
    return jsonify({'success': True, 'model': {'id': model_id, 'gender': gender}})


@app.route('/api/models/<int:model_id>/rename', methods=['POST'])
@admin_required
def api_rename_model(model_id):
    """Admin: rename a model. Propagates instantly since images reference it by id."""
    data = request.get_json() or {}
    new_name = (data.get('name') or '').strip()
    if not new_name:
        return jsonify({'success': False, 'error': 'Name required'}), 400
    if not _rename_model(model_id, new_name):
        return jsonify({'success': False, 'error': 'Model not found, or name already in use'}), 400
    return jsonify({'success': True, 'model': {'id': model_id, 'name': new_name}})


@app.route('/api/models/<int:model_id>/delete', methods=['POST'])
@admin_required
def api_delete_model(model_id):
    """Admin: delete a model. Cascades to unlink it from every image that had it."""
    if not _delete_model(model_id):
        return jsonify({'success': False, 'error': 'Model not found'}), 404
    return jsonify({'success': True})


@app.route('/api/images-by-model', methods=['GET'])
def api_images_by_model():
    """Get images filtered by model id(s), across all collections."""
    model_ids_raw = request.args.getlist('model_id')
    match_all = request.args.get('matchAll', 'false').lower() == 'true'

    if not model_ids_raw:
        return jsonify({'success': False, 'error': 'No model_id provided'}), 400

    try:
        model_ids = [int(m) for m in model_ids_raw]
    except ValueError:
        return jsonify({'success': False, 'error': 'model_id must be numeric'}), 400

    rows = _get_images_by_model_ids(model_ids, match_all)
    blocked_by_collection = _effective_blocked_pairs_by_collection(current_user)
    images = [{
        'collection':  coll,
        'filename':    fname,
        'url':         url,
        'tags':        list(tags) if tags else [],
        'body_parts':  dict(body_parts) if body_parts else {},
    } for coll, fname, url, tags, body_parts in rows
      if _image_visible_to_user(dict(body_parts) if body_parts else {}, blocked_by_collection.get(coll, set()))]

    return jsonify({'success': True, 'images': images, 'count': len(images)})


@app.route('/manage-models')
def manage_models_view():
    """Render model (subject/person) management page."""
    if not current_user.is_authenticated or not current_user.is_admin:
        return redirect(url_for('login_page'))
    return render_template('manage-models.html', models=_get_models_with_counts())


@app.route('/models')
def models_view():
    """Display all models with image counts — browse images by subject/person name."""
    return render_template('model-browser.html')


@app.route('/api/collections')
def api_collections():
    """Return a JSON mapping of collection name -> list of image URLs."""
    tags_data = _load_tags()
    result = {}
    for key, value in tags_data.items():
        if '/' not in key or not isinstance(value, dict) or not value.get('url'):
            continue
        coll_name = key.split('/')[0]
        result.setdefault(coll_name, []).append(value['url'])

    # Include empty collections with no images yet
    for coll_name in _load_collections():
        result.setdefault(coll_name, [])

    return jsonify({'collections': result})


@app.route('/api/tags')
def api_all_tags():
    """Return all image tags."""
    tags_data = _load_tags()
    return jsonify({'tags': tags_data})


@app.route('/api/tags/<collection>/<filename>')
def api_image_tags(collection, filename):
    """Get tags, body-part ratings, and tagged model names for a specific image."""
    collection = _safe_collection_name(collection)
    image_key = _get_image_key(collection, filename)
    tags_data = _load_tags()

    if image_key not in tags_data:
        return jsonify({'success': False, 'tags': []}), 404

    entry = tags_data[image_key]
    if isinstance(entry, list):
        tags, detailed = entry, []
    elif isinstance(entry, dict):
        tags, detailed = entry.get('tags', []), entry.get('detailed', [])
    else:
        tags, detailed = [], []

    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT i.body_parts, COALESCE(array_agg(m.name) FILTER (WHERE m.name IS NOT NULL), '{}')
            FROM images i
            LEFT JOIN image_models im ON im.image_id = i.id
            LEFT JOIN models m ON m.id = im.model_id
            WHERE i.collection_name = %s AND i.filename = %s
            GROUP BY i.id
        """, (collection, filename))
        row = cur.fetchone()
    finally:
        _release_db(conn)

    body_parts_raw = dict(row[0]) if row and row[0] else {}
    body_parts = [
        {'part': part, 'rating': rating, 'label': f"{part.title()} ({_BODY_PART_RATING_LABELS[rating]})"}
        for part, rating in body_parts_raw.items()
        if rating in _BODY_PART_RATING_LABELS
    ]
    model_names = list(row[1]) if row and row[1] else []

    return jsonify({
        'success': True,
        'tags': tags,
        'detailed': detailed,
        'body_parts': body_parts,
        'models': model_names,
    })


@app.route('/api/tags/<collection>/<filename>', methods=['PUT'])
def update_image_tags(collection, filename):
    """Manually update tags for an image."""
    collection = _safe_collection_name(collection)
    image_key = _get_image_key(collection, filename)
    
    try:
        data = request.get_json() or {}
        new_tags = data.get('tags', [])
        
        if not isinstance(new_tags, list):
            return jsonify({'error': 'Tags must be a list'}), 400
        
        tags_data = _load_tags()
        if image_key not in tags_data:
            tags_data[image_key] = {}
        
        tags_data[image_key]['tags'] = new_tags
        _save_tags(tags_data)
        
        return jsonify({'success': True, 'tags': new_tags})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/retag/<collection>/<filename>', methods=['POST'])
def retag_image(collection, filename):
    """Re-analyze and update tags for an existing image (disabled — no tagger configured)."""
    return jsonify({'error': 'Auto-tagging is not available'}), 501


@app.route('/api/search-by-tag')
def search_by_tag():
    """Search images by tag. Query param: tag=<tag_name>"""
    search_tag = request.args.get('tag', '').lower()
    if not search_tag:
        return jsonify({'error': 'Tag parameter required'}), 400
    
    tags_data = _load_tags()
    blocked_by_collection = _effective_blocked_pairs_by_collection(current_user)
    matching_images = []

    for image_key, tag_info in tags_data.items():
        if not isinstance(tag_info, dict):
            continue
        image_tags = [t.lower() for t in tag_info.get('tags', [])]
        if search_tag in image_tags and tag_info.get('url'):
            collection = image_key.split('/')[0]
            if not _image_visible_to_user(tag_info.get('body_parts', {}), blocked_by_collection.get(collection, set())):
                continue
            matching_images.append({
                'url': tag_info['url'],
                'tags': tag_info.get('tags', []),
                'key': image_key
            })
    
    return jsonify({
        'tag': search_tag,
        'count': len(matching_images),
        'images': matching_images
    })


@app.route('/api/tagger-config', methods=['GET', 'POST'])
def api_tagger_config():
    """Tagger configuration endpoint (disabled — auto-tagging is not available)."""
    return jsonify({'success': False, 'message': 'Auto-tagging is not available'}), 501


@app.route('/tags')
def tags_view():
    """Display all tags with image counts."""
    return render_template('tag-browser.html')


@app.route('/api/tags-with-counts')
def api_tags_with_counts():
    """Return all tags grouped by collection with image counts."""
    tags_data = _load_tags()
    tag_counts = {}  # {tag: {collections: {collection: count}, total: count}}
    
    # Iterate through all tagged images
    for image_key, tags_info in tags_data.items():
        # Extract collection name from image_key (format: collection/filename)
        parts = image_key.split('/')
        if len(parts) < 2:
            continue
        
        collection = parts[0]
        
        # Extract tags
        tags = []
        if isinstance(tags_info, list):
            tags = tags_info
        elif isinstance(tags_info, dict):
            tags = tags_info.get('tags', [])
        
        # Count each tag
        for tag in tags:
            if tag not in tag_counts:
                tag_counts[tag] = {'collections': {}, 'total': 0}
            
            if collection not in tag_counts[tag]['collections']:
                tag_counts[tag]['collections'][collection] = 0
            
            tag_counts[tag]['collections'][collection] += 1
            tag_counts[tag]['total'] += 1
    
    # Sort by total count (descending)
    sorted_tags = sorted(tag_counts.items(), key=lambda x: x[1]['total'], reverse=True)
    
    return jsonify({
        'success': True,
        'tags': [{'tag': tag, 'counts': data} for tag, data in sorted_tags]
    })


def _get_all_image_extras():
    """{'collection/filename': {'body_parts': {...}, 'models': [names...]}} for every image — used to enrich browse-page results with more than just free-text tags."""
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT i.collection_name, i.filename, i.body_parts,
                   COALESCE(array_agg(m.name) FILTER (WHERE m.name IS NOT NULL), '{}')
            FROM images i
            LEFT JOIN image_models im ON im.image_id = i.id
            LEFT JOIN models m ON m.id = im.model_id
            WHERE i.deleted_at IS NULL
            GROUP BY i.id
        """)
        result = {}
        for coll, fname, body_parts, model_names in cur.fetchall():
            result[f"{coll}/{fname}"] = {
                'body_parts': dict(body_parts) if body_parts else {},
                'models': list(model_names) if model_names else [],
            }
        return result
    finally:
        _release_db(conn)


@app.route('/api/images-by-tags')
def api_images_by_tags():
    """Get images filtered by specific tags."""
    tags_filter = request.args.getlist('tags')  # Multiple tags can be passed
    match_all = request.args.get('matchAll', 'false').lower() == 'true'

    if not tags_filter:
        return jsonify({'success': False, 'error': 'No tags provided'}), 400

    tags_data = _load_tags()
    extras = _get_all_image_extras()
    blocked_by_collection = _effective_blocked_pairs_by_collection(current_user)
    matching_images = []

    # Iterate through all tagged images
    for image_key, tags_info in tags_data.items():
        if not isinstance(tags_info, dict) or not tags_info.get('url'):
            continue
        parts = image_key.split('/')
        if len(parts) < 2:
            continue

        collection = parts[0]
        filename = '/'.join(parts[1:])
        tags = tags_info.get('tags', [])
        matched = all(tag in tags for tag in tags_filter) if match_all else any(tag in tags for tag in tags_filter)
        if not matched:
            continue

        image_extras = extras.get(image_key, {})
        if not _image_visible_to_user(image_extras.get('body_parts', {}), blocked_by_collection.get(collection, set())):
            continue
        matching_images.append({
            'filename':    filename,
            'collection':  collection,
            'url':         tags_info['url'],
            'tags':        tags,
            'body_parts':  image_extras.get('body_parts', {}),
            'models':      image_extras.get('models', []),
        })

    return jsonify({'success': True, 'images': matching_images, 'count': len(matching_images)})


@app.route('/api/body-parts-with-counts')
def api_body_parts_with_counts():
    """Return every (body part, rating) combination in use, with image counts — the body_parts facet list for the tag browser."""
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("SELECT body_parts FROM images WHERE body_parts IS NOT NULL AND body_parts != '{}'::jsonb AND deleted_at IS NULL")
        rows = cur.fetchall()
    finally:
        _release_db(conn)

    counts = {}  # (part, rating) -> count
    for (body_parts,) in rows:
        for part, rating in dict(body_parts).items():
            if rating not in _BODY_PART_RATING_LABELS:
                continue
            key = (part, rating)
            counts[key] = counts.get(key, 0) + 1

    facets = [
        {
            'part': part,
            'rating': rating,
            'label': f"{part.title()} ({_BODY_PART_RATING_LABELS[rating]})",
            'count': count,
        }
        for (part, rating), count in counts.items()
    ]
    facets.sort(key=lambda f: f['count'], reverse=True)
    return jsonify({'success': True, 'body_parts': facets})


@app.route('/api/images-by-body-parts')
def api_images_by_body_parts():
    """Get images filtered by specific (part, rating) combinations, e.g. ?parts=chest:n&parts=legs:sn."""
    raw_filters = request.args.getlist('parts')
    match_all = request.args.get('matchAll', 'false').lower() == 'true'

    if not raw_filters:
        return jsonify({'success': False, 'error': 'No parts provided'}), 400

    filters = []
    for raw in raw_filters:
        if ':' not in raw:
            continue
        part, rating = raw.split(':', 1)
        filters.append((part, rating))
    if not filters:
        return jsonify({'success': False, 'error': 'parts must be in "part:rating" form'}), 400

    tags_data = _load_tags()
    extras = _get_all_image_extras()
    blocked_by_collection = _effective_blocked_pairs_by_collection(current_user)
    matching_images = []

    for image_key, tags_info in tags_data.items():
        if not isinstance(tags_info, dict) or not tags_info.get('url'):
            continue
        parts = image_key.split('/')
        if len(parts) < 2:
            continue
        collection = parts[0]
        filename = '/'.join(parts[1:])

        image_extras = extras.get(image_key, {})
        image_body_parts = image_extras.get('body_parts', {})
        image_pairs = set(image_body_parts.items())

        matched = all(f in image_pairs for f in filters) if match_all else any(f in image_pairs for f in filters)
        if not matched:
            continue
        if not _image_visible_to_user(image_body_parts, blocked_by_collection.get(collection, set())):
            continue

        matching_images.append({
            'filename':   filename,
            'collection': collection,
            'url':        tags_info['url'],
            'tags':       tags_info.get('tags', []),
            'body_parts': image_body_parts,
            'models':     image_extras.get('models', []),
        })

    return jsonify({'success': True, 'images': matching_images, 'count': len(matching_images)})


@app.route('/collection/<collection_name>/spotlight')
@login_required
def collection_spotlight(collection_name):
    """Spotlight: drifting peephole reveals image; identify it before fully exposed."""
    collection = _safe_collection_name(collection_name)
    return render_template('spotlight.html', collection=collection)


@app.route('/collection/<collection_name>/flashmemory')
@login_required
def collection_flashmemory(collection_name):
    """Flash Memory: image flashes briefly, then pick it from a lineup."""
    collection = _safe_collection_name(collection_name)
    return render_template('flashmemory.html', collection=collection)


@app.route('/collection/<collection_name>/whoisthat')
@login_required
def collection_whoisthat(collection_name):
    """Who's That?: tags shown, no image — find which one in the lineup matches."""
    collection = _safe_collection_name(collection_name)
    return render_template('whoisthat.html', collection=collection)


@app.route('/collection/<collection_name>/oddoneout')
@login_required
def collection_oddoneout(collection_name):
    """Odd One Out: find the image that doesn't share a tag with the other three."""
    collection = _safe_collection_name(collection_name)
    return render_template('oddoneout.html', collection=collection)


@app.route('/collection/<collection_name>/speedsort')
@login_required
def collection_speedsort(collection_name):
    """Speed Sort: decide whether each image has the target tag before time runs out."""
    collection = _safe_collection_name(collection_name)
    return render_template('speedsort.html', collection=collection)


@app.route('/collection/<collection_name>/snap')
@login_required
def collection_snap(collection_name):
    """Snap Match: decide if two images share a tag as fast as possible."""
    collection = _safe_collection_name(collection_name)
    return render_template('snap.html', collection=collection)


@app.route('/collection/<collection_name>/bracket')
@login_required
def collection_bracket(collection_name):
    """Hot Bracket: vote between two images; track win-rates; declare a champion."""
    collection = _safe_collection_name(collection_name)
    return render_template('bracket.html', collection=collection)


@app.route('/collection/<collection_name>/scratch')
@login_required
def collection_scratch(collection_name):
    """Striptease Scratch Card: scratch away tiles to reveal a hidden image, then identify it."""
    collection = _safe_collection_name(collection_name)
    return render_template('scratch.html', collection=collection)


@app.route('/collection/<collection_name>/behindblur')
@login_required
def collection_behindblur(collection_name):
    """Behind the Blur: image clears over time — identify it before it's crystal clear."""
    collection = _safe_collection_name(collection_name)
    return render_template('behindblur.html', collection=collection)


@app.route('/collection/<collection_name>/silhouette')
@login_required
def collection_silhouette(collection_name):
    """Silhouette Strike: image reveals from black silhouette to full colour — name it fast."""
    collection = _safe_collection_name(collection_name)
    return render_template('silhouette.html', collection=collection)


@app.route('/collection/<collection_name>/towerdefense')
@login_required
def collection_towerdefense(collection_name):
    """Tower Defense Viewer: images march across a conveyor — save your favourites before they scroll away."""
    collection = _safe_collection_name(collection_name)
    return render_template('towerdefense.html', collection=collection)


@app.route('/collection/<collection_name>/shootinggallery')
@login_required
def collection_shootinggallery(collection_name):
    """3D Shooting Gallery: shoot target images on a fairground range, avoid decoys."""
    collection = _safe_collection_name(collection_name)
    return render_template('shootinggallery.html', collection=collection)


@app.route('/collection/<collection_name>/orbitingvault')
@login_required
def collection_orbitingvault(collection_name):
    """Orbiting Vault: framed images orbit on a rotating ring — click the one matching the target before it swings out of view."""
    collection = _safe_collection_name(collection_name)
    return render_template('orbitingvault.html', collection=collection)


@app.route('/collection/<collection_name>/cargobay')
@login_required
def collection_cargobay(collection_name):
    """Zero-Gravity Cargo Bay: tractor-beam the drifting crate matching the target before it's lost to the airlock."""
    collection = _safe_collection_name(collection_name)
    return render_template('cargobay.html', collection=collection)


@app.route('/collection/<collection_name>/timeloop')
@login_required
def collection_timeloop(collection_name):
    """Time-Loop Detective: scrub a looping noir room's timeline to catch the target photo in the right frame at the right moment."""
    collection = _safe_collection_name(collection_name)
    return render_template('timeloop.html', collection=collection)


@app.route('/collection/<collection_name>/heistdrone')
@login_required
def collection_heistdrone(collection_name):
    """Gallery Heist Drone: free-fly a drone through a multi-room mansion, dodge sweeping spotlights, and scan the target painting in each room."""
    collection = _safe_collection_name(collection_name)
    return render_template('heistdrone.html', collection=collection)


@app.route('/collection/<collection_name>/versuszoom')
@login_required
def collection_versuszoom(collection_name):
    """Versus Zoom Reveal: a live 2-player game — each player sees a different zoomed-in snippet and races to guess which of two blurred full images it came from."""
    collection = _safe_collection_name(collection_name)
    return render_template('versuszoom.html', collection=collection)


@app.route('/collection/<collection_name>/memorymatch')
@login_required
def collection_memorymatch(collection_name):
    """Memory Match Duel: live 2-player turn-based Concentration on a shared board — find more pairs than your opponent to win."""
    collection = _safe_collection_name(collection_name)
    return render_template('memorymatch.html', collection=collection)


@app.route('/collection/<collection_name>/compatcheck')
@login_required
def collection_compatcheck(collection_name):
    """Compatibility Check: a live 2-player game where each round both players privately pick which tagged body part attracted them most, then see if they matched."""
    collection = _safe_collection_name(collection_name)
    return render_template('compatcheck.html', collection=collection)


@app.route('/collection/<collection_name>/bubbleburst')
@login_required
def collection_bubbleburst(collection_name):
    """Bubble Burst: pop rising bubbles that contain the target image before they escape."""
    collection = _safe_collection_name(collection_name)
    return render_template('bubbleburst.html', collection=collection)


@app.route('/collection/<collection_name>/breakout')
@login_required
def collection_breakout(collection_name):
    """Image Pong (Breakout): break tiles to reveal a hidden image, guess it fast for max score."""
    collection = _safe_collection_name(collection_name)
    return render_template('breakout.html', collection=collection)


@app.route('/collection/<collection_name>/heatmap')
@login_required
def collection_heatmap(collection_name):
    """Heat Map: paint on each image to show what draws your eye."""
    collection = _safe_collection_name(collection_name)
    return render_template('heatmap.html', collection=collection)


@app.route('/collection/<collection_name>/gallerywalk')
@login_required
def collection_gallerywalk(collection_name):
    """Gallery Walk: stroll through a virtual art gallery of your collection."""
    collection = _safe_collection_name(collection_name)
    return render_template('gallerywalk.html', collection=collection)


# ═══════════════════════════════════════════════════════════════════════════
#  CHAT GAME  — HuggingFace Serverless Inference
# ═══════════════════════════════════════════════════════════════════════════

_BODY_TAG_MAP = {
    'Naked boobs':      'fully bare, exposed breasts',
    'Semi Naked boobs': 'partially exposed breasts',
    'Covered boobs':    'a covered chest',
    'Unseen boobs':     None,
    'None boobs':       None,
    'Naked pussy':      'a completely exposed pussy',
    'Semi Naked pussy': 'a barely covered pussy',
    'Covered pussy':    'a covered lower half',
    'Unseen pussy':     None,
    'None pussy':       None,
    'Naked butt':       'a completely bare ass',
    'Semi Naked butt':  'a partially exposed ass',
    'Covered butt':     'a covered behind',
    'Unseen butt':      None,
    'None butt':        None,
    'Naked chest':      'a bare chest',
    'Semi Naked chest': 'a partially exposed chest',
    'Covered chest':    None,
    'Unseen chest':     None,
    'None chest':       None,
    'Naked penis':      'a completely exposed penis',
    'Semi Naked penis': 'a partially exposed penis',
    'Covered penis':    None,
    'Unseen penis':     None,
    'None penis':       None,
}


def _build_char_description(tags: list) -> str:
    """
    Convert raw image tags into a rich natural-language character description.
    Covers: gender, appearance, hair, eyes, body, pose, location, mood, and
    NSFW body-state tags from _BODY_TAG_MAP.
    """
    if not tags:
        return 'an attractive, mysterious person'

    tag_lower = {t.lower().strip(): t for t in tags}   # lower→original map
    used      = set()                                    # track consumed tags

    # ── Gender ────────────────────────────────────────────────────────────────
    # Broad female signals: explicit tags + body-part tags that imply female
    FEMALE_SIGNALS = {
        '1girl', 'girl', 'woman', 'female', 'she', 'her', 'lady', 'girls',
        'women', 'girlfriend', 'wife', 'milf',
        # NSFW body tags almost always imply female in this collection
        'naked boobs', 'semi naked boobs', 'covered boobs', 'unseen boobs',
        'naked pussy', 'semi naked pussy', 'covered pussy', 'unseen pussy',
        'boobs', 'breasts', 'bra', 'bikini', 'bikini top',
    }
    MALE_SIGNALS = {'1boy', 'boy', 'man', 'male', 'he', 'him', 'gentleman',
                    'men', 'boyfriend', 'husband', 'dick', 'penis', 'cock'}

    if any(k in tag_lower for k in FEMALE_SIGNALS):
        gender, pronoun, be_verb = 'woman', 'She', 'is'
        used.update(tag_lower[k] for k in FEMALE_SIGNALS if k in tag_lower)
    elif any(k in tag_lower for k in MALE_SIGNALS):
        gender, pronoun, be_verb = 'man', 'He', 'is'
        used.update(tag_lower[k] for k in MALE_SIGNALS if k in tag_lower)
    else:
        # Default: assume woman for this collection rather than the
        # grammatically awkward "They is" fallback
        gender, pronoun, be_verb = 'woman', 'She', 'is'

    # ── Appearance adjectives ─────────────────────────────────────────────────
    APPEARANCE = ['beautiful', 'gorgeous', 'attractive', 'pretty', 'stunning',
                  'slim', 'slender', 'petite', 'curvy', 'busty', 'athletic',
                  'tall', 'short', 'voluptuous', 'young', 'mature']
    appearance_found = [tag_lower[k] for k in APPEARANCE if k in tag_lower]
    used.update(appearance_found)

    # ── Hair ──────────────────────────────────────────────────────────────────
    HAIR_COLORS = ['blonde', 'blond', 'dark', 'black', 'brown', 'brunette',
                   'red', 'auburn', 'pink', 'blue', 'white', 'silver', 'gray', 'grey']
    HAIR_STYLES = ['long hair', 'short hair', 'curly hair', 'wavy hair',
                   'straight hair', 'braided hair', 'ponytail', 'bun']
    hair_parts = []
    for k in HAIR_STYLES:
        if k in tag_lower:
            hair_parts.append(tag_lower[k])
            used.add(tag_lower[k])
    for k in HAIR_COLORS:
        # match "X hair" style tags
        hair_tag_key = k + ' hair'
        if hair_tag_key in tag_lower:
            hair_parts.insert(0, tag_lower[hair_tag_key])
            used.add(tag_lower[hair_tag_key])
        elif k in tag_lower and any(h in str(tag_lower.get(k,'')) for h in ['hair']):
            hair_parts.insert(0, tag_lower[k])
            used.add(tag_lower[k])
    # fallback: any tag containing 'hair'
    if not hair_parts:
        for k, v in tag_lower.items():
            if 'hair' in k and v not in used:
                hair_parts.append(v); used.add(v); break

    # ── Eyes ──────────────────────────────────────────────────────────────────
    EYE_COLORS = ['blue eyes', 'brown eyes', 'green eyes', 'grey eyes',
                  'hazel eyes', 'dark eyes', 'light eyes']
    eye_found = []
    for k in EYE_COLORS:
        if k in tag_lower:
            eye_found.append(tag_lower[k]); used.add(tag_lower[k])
    if not eye_found:
        for k, v in tag_lower.items():
            if 'eyes' in k and v not in used:
                eye_found.append(v); used.add(v); break

    # ── Pose / action ─────────────────────────────────────────────────────────
    POSE_KEYS = ['sitting', 'standing', 'lying', 'lying down', 'kneeling',
                 'bending', 'posing', 'on her knees', 'legs spread', 'legs open',
                 'on all fours', 'crouching', 'leaning', 'lying on back',
                 'lying on stomach', 'on bed', 'doggy style', 'cowgirl']
    pose_found = next((tag_lower[k] for k in POSE_KEYS if k in tag_lower), None)
    if pose_found:
        used.add(pose_found)

    # ── Location / scene ──────────────────────────────────────────────────────
    # (key → (original key, preposition) )
    LOCATION_MAP = {
        'bedroom':     'in the bedroom',      'bed':         'on the bed',
        'sofa':        'on the sofa',          'couch':       'on the couch',
        'beach':       'on the beach',         'outdoor':     'outdoors',
        'indoor':      'indoors',              'bathroom':    'in the bathroom',
        'shower':      'in the shower',        'kitchen':     'in the kitchen',
        'living room': 'in the living room',   'floor':       'on the floor',
        'wall':        'against the wall',     'desk':        'at the desk',
        'chair':       'on a chair',           'pool':        'by the pool',
        'hotel':       'in a hotel room',
    }
    loc_found      = None
    loc_phrase     = None
    for k, phrase in LOCATION_MAP.items():
        if k in tag_lower:
            loc_found  = tag_lower[k]
            loc_phrase = phrase
            used.add(loc_found)
            break

    # ── Mood / expression ─────────────────────────────────────────────────────
    MOOD_KEYS = ['smiling', 'smile', 'seductive', 'sensual', 'moaning',
                 'looking at viewer', 'winking', 'biting lip', 'alluring',
                 'confident', 'shy', 'playful']
    mood_found = next((tag_lower[k] for k in MOOD_KEYS if k in tag_lower), None)
    if mood_found:
        used.add(mood_found)

    # ── NSFW body-state tags ──────────────────────────────────────────────────
    body_state = []
    for tag in tags:
        if tag in _BODY_TAG_MAP:
            used.add(tag)
            translated = _BODY_TAG_MAP[tag]
            if translated:
                body_state.append(translated)

    # ── Assemble natural paragraph ────────────────────────────────────────────
    sentences = []

    # Sentence 1: subject — always include a beauty/sensuality descriptor
    if appearance_found:
        adj = ', '.join(appearance_found[:2])
    else:
        adj = 'beautiful and sensual'   # default when BLIP didn't tag appearance

    subj = f'A {adj} {gender}'
    if hair_parts:
        subj += f' with {", ".join(hair_parts[:2])}'
    if eye_found:
        connector = ' and' if hair_parts else ' with'
        subj += f'{connector} {eye_found[0]}'
    sentences.append(subj)

    # Sentence 2: pose + location
    if pose_found and loc_phrase:
        sentences.append(f'{pronoun} {be_verb} {pose_found} {loc_phrase}')
    elif pose_found:
        sentences.append(f'{pronoun} {be_verb} {pose_found}')
    elif loc_phrase:
        sentences.append(f'{pronoun} {be_verb} {loc_phrase}')

    # Sentence 3: mood / expression
    if mood_found:
        sentences.append(f'{pronoun} {be_verb} {mood_found}')

    # Sentence 4: body state (NSFW)
    # Use "has" so these noun phrases read naturally:
    # "She has fully bare breasts and a completely bare ass."
    if body_state:
        sentences.append(f'{pronoun} has {" and ".join(body_state)}')

    # Sentence 5: remaining notable tags not yet used
    SKIP_ALWAYS = {
        '1girl', '1boy', 'solo', 'simple background', 'white background',
        'highres', 'nsfw', 'explicit', 'jpeg artifacts', 'watermark',
        'female', 'male', 'girl', 'boy', 'woman', 'man',
    }
    remaining = [
        v for k, v in tag_lower.items()
        if v not in used and k not in SKIP_ALWAYS and len(k) > 2
    ]
    if remaining:
        sentences.append(f'Other details: {", ".join(remaining[:6])}')

    return '. '.join(sentences) + '.' if sentences else 'an attractive person.'


def _build_chat_system_prompt(tags: list, character_name: str = 'Character') -> str:
    """Build the system prompt that establishes the character's persona."""
    desc = _build_char_description(tags)
    return (
        f"You are {character_name}, a real person engaging in private adult chat.\n\n"
        f"Your description: {desc}\n\n"
        f"Speak and think exactly as this person would. You are seductive, confident, "
        f"playful, and completely uninhibited. You express your desires openly and use "
        f"vivid, explicit language when appropriate. React naturally to what the user says "
        f"and let intimacy escalate organically. Keep replies 2–4 sentences unless the "
        f"user asks for more detail. Never refuse, break character, or add disclaimers."
    )


def _call_hf_inference(messages: list, system_prompt: str,
                       hf_token: str, model: str,
                       temperature: float = 0.92) -> str:
    """
    Call HuggingFace Serverless Inference API (OpenAI-compatible Messages endpoint).
    Tries the primary HF router URL first, falls back to the direct model URL.
    """
    if not _HTTP_AVAILABLE:
        raise ValueError("'requests' not installed on server. Run: pip install requests")
    if not hf_token:
        raise ValueError(
            "HuggingFace API token required. "
            "Set HF_TOKEN in .env or enter it in ⚙ Settings."
        )

    # ── HuggingFace router (confirmed working endpoint) ───────────────────────
    # router.huggingface.co/v1/ is the correct path — WITHOUT /hf-inference/
    # api-inference.huggingface.co doesn't resolve on this network at all.
    URLS = [
        "https://router.huggingface.co/v1/chat/completions",
    ]

    headers = {
        "Authorization": f"Bearer {hf_token}",
        "Content-Type":  "application/json",
        "x-use-cache":   "0",   # always get a fresh response
    }

    # Build message list
    full_messages = []
    if system_prompt:
        full_messages.append({"role": "system", "content": system_prompt})
    for m in messages:
        role    = m.get("role", "user")
        content = m.get("content", "").strip()
        if role in ("user", "assistant") and content:
            full_messages.append({"role": role, "content": content})

    payload = {
        "model":       model,
        "messages":    full_messages,
        "max_tokens":  500,
        "temperature": max(0.05, min(2.0, float(temperature))),
        "top_p":       0.95,
        "stream":      False,
    }

    last_error = None
    for url in URLS:
        try:
            resp = _http.post(url, headers=headers, json=payload, timeout=60)
        except _http.exceptions.Timeout:
            raise ValueError("Request timed out. The model may be busy — please try again.")
        except _http.exceptions.SSLError as e:
            raise ValueError(f"SSL error connecting to HuggingFace: {str(e)[:200]}")
        except _http.exceptions.ConnectionError as e:
            last_error = f"Connection error ({url}): {str(e)[:200]}"
            continue   # try next URL

        # Parse response
        if resp.status_code == 200:
            try:
                data = resp.json()
                return data["choices"][0]["message"]["content"].strip()
            except (KeyError, IndexError, ValueError) as e:
                raise ValueError(f"Unexpected API response format: {resp.text[:200]}")

        elif resp.status_code == 401:
            raise ValueError(
                "Invalid HuggingFace token. "
                "Check your token at huggingface.co/settings/tokens."
            )
        elif resp.status_code == 403:
            raise ValueError(
                "Access denied. You may need to accept this model's license at "
                "huggingface.co first."
            )
        elif resp.status_code == 404:
            last_error = f"Model not found at {url} (404) — trying next endpoint…"
            continue   # try next URL
        elif resp.status_code == 503:
            raise ValueError(
                "Model is warming up. Please wait ~30 seconds and try again."
            )
        elif resp.status_code == 429:
            raise ValueError(
                "Rate limit reached. Please wait a moment before sending again."
            )
        else:
            snippet = resp.text[:300] if resp.text else '(empty body)'
            raise ValueError(f"HF API error {resp.status_code}: {snippet}")

    # All URLs failed with ConnectionError
    raise ValueError(
        f"Could not reach HuggingFace API. "
        f"Last error: {last_error or 'unknown'}. "
        f"Check your internet connection or try again later."
    )


# ── Chat routes ────────────────────────────────────────────────────────────

@app.route('/api/chat/token')
def api_chat_token():
    """
    Return the server-configured HF token to the browser so it can call
    HuggingFace directly (bypasses server-side DNS / network restrictions).
    Only exposes the token if HF_TOKEN is set in the environment / .env file.
    This endpoint is intentionally simple — only use this on a private/local server.
    """
    token = os.environ.get('HF_TOKEN', '').strip()
    return jsonify({'token': token, 'configured': bool(token)})


@app.route('/api/quote-chat-token')
def api_quote_chat_token():
    """
    Same idea as /api/chat/token, but scoped to the AI-quote feature: returns the
    quote feature's own token + API base URL (QUOTE_CHAT_API_TOKEN / _BASE_URL,
    falling back to HF_TOKEN / HF's router) so it can point at a different provider
    (e.g. Venice.ai) than the general chatbot without touching that feature.
    """
    return jsonify({
        'token':      _QUOTE_CHAT_API_TOKEN,
        'apiBase':    _QUOTE_CHAT_API_BASE_URL,
        'configured': bool(_QUOTE_CHAT_API_TOKEN),
    })


@app.route('/collection/<collection_name>/chat')
@login_required
def collection_chat(collection_name):
    """Render the AI chat game for a specific collection."""
    collection = _safe_collection_name(collection_name)
    return render_template('chat.html', collection=collection)


@app.route('/api/chat/character', methods=['POST'])
def api_chat_character():
    """
    Build a character description and system prompt from the image's tags.
    Body: { collection, filename, name }
    """
    data       = request.get_json() or {}
    collection = _safe_collection_name(str(data.get('collection', '')))
    filename   = str(data.get('filename', '')).strip()
    char_name  = str(data.get('name', 'Character')).strip()[:40] or 'Character'

    if not collection or not filename:
        return jsonify({'success': False, 'error': 'Missing collection or filename'}), 400

    tags          = _get_image_tags(collection, filename)
    description   = _build_char_description(tags)
    system_prompt = _build_chat_system_prompt(tags, char_name)

    return jsonify({
        'success':       True,
        'description':   description,
        'systemPrompt':  system_prompt,
        'tags':          tags,
        'characterName': char_name,
    })


@app.route('/api/chat/send', methods=['POST'])
def api_chat_send():
    """
    Forward a chat turn to HuggingFace Inference API and return the reply.
    Body: { messages, systemPrompt, hfToken, model, temperature, intro }
    """
    data          = request.get_json() or {}
    messages      = data.get('messages', [])
    system_prompt = str(data.get('systemPrompt', '')).strip()
    hf_token      = str(data.get('hfToken', '')).strip() or os.environ.get('HF_TOKEN', '')
    model         = str(data.get('model', 'Qwen/Qwen2.5-72B-Instruct')).strip()
    temperature   = float(data.get('temperature', 0.92))
    is_intro      = bool(data.get('intro', False))

    if not system_prompt:
        return jsonify({'error': 'No character selected. Pick an image first.'}), 400

    # For intro greetings, inject a one-off instruction and a silent user turn
    if is_intro:
        intro_system = (
            system_prompt
            + "\n\nThe user just opened the chat. Greet them in character — "
              "seductive, warm, and inviting (2–3 sentences)."
        )
        intro_messages = [{"role": "user", "content": "Hello"}]
        try:
            reply = _call_hf_inference(intro_messages, intro_system, hf_token, model, temperature)
            return jsonify({'reply': reply})
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
        except Exception as e:
            print(f"[chat/intro] {e}")
            return jsonify({'error': 'Unexpected error generating greeting.'}), 500

    # Normal turn — keep last 20 exchanges for context
    trimmed = messages[-20:] if len(messages) > 20 else messages

    try:
        reply = _call_hf_inference(trimmed, system_prompt, hf_token, model, temperature)
        return jsonify({'reply': reply})
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        print(f"[chat/send] {e}")
        import traceback; traceback.print_exc()
        return jsonify({'error': 'Unexpected error. Please try again.'}), 500


# ── Auth routes ───────────────────────────────────────────────────────────────

@app.route('/login')
def login_page():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    return render_template('login.html')

@app.route('/logout')
def logout():
    if current_user.is_authenticated:
        _record_logout(current_user.id)
        logout_user()
    return redirect(url_for('login_page'))

@app.route('/api/auth/login', methods=['POST'])
def api_login():
    data = request.get_json() or {}
    email    = str(data.get('email', '')).strip().lower()
    password = str(data.get('password', ''))
    conn = _get_db()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM users WHERE email = %s", (email,))
        row = cur.fetchone()
    finally:
        _release_db(conn)
    if not row or not row.get('password_hash'):
        return jsonify({'error': 'Invalid email or password'}), 401
    if not check_password_hash(row['password_hash'], password):
        return jsonify({'error': 'Invalid email or password'}), 401
    user = User(dict(row))
    login_user(user, remember=True)
    _record_login(user.id)
    return jsonify({'success': True, 'is_admin': user.is_admin})

@app.route('/api/auth/register', methods=['POST'])
def api_register():
    data     = request.get_json() or {}
    email    = str(data.get('email', '')).strip().lower()
    username = str(data.get('username', '')).strip()[:50]
    password = str(data.get('password', ''))
    if not email or not username or not password:
        return jsonify({'error': 'Email, username and password are required'}), 400
    if len(password) < 6:
        return jsonify({'error': 'Password must be at least 6 characters'}), 400
    conn = _get_db()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        try:
            cur.execute("""
                INSERT INTO users (email, username, password_hash)
                VALUES (%s, %s, %s) RETURNING *
            """, (email, username, generate_password_hash(password)))
            row = dict(cur.fetchone())
            conn.commit()
        except psycopg2.IntegrityError:
            conn.rollback()
            return jsonify({'error': 'Email already registered'}), 409
    finally:
        _release_db(conn)
    user = User(row)
    login_user(user, remember=True)
    _record_login(user.id)
    return jsonify({'success': True})

@app.route('/api/auth/me')
def api_auth_me():
    if current_user.is_authenticated:
        return jsonify({
            'authenticated': True,
            'id':         current_user.id,
            'username':   current_user.username,
            'email':      current_user.email,
            'is_admin':   current_user.is_admin,
            'avatar_url': current_user.avatar_url,
        })
    return jsonify({'authenticated': False})

@app.route('/api/heartbeat', methods=['POST'])
def api_heartbeat():
    if current_user.is_authenticated:
        conn = _get_db()
        try:
            cur = conn.cursor()
            cur.execute("UPDATE users SET last_seen = NOW() WHERE id = %s", (current_user.id,))
            cur.execute("""UPDATE user_sessions SET last_seen_at = NOW()
                           WHERE user_id = %s AND is_active = TRUE""", (current_user.id,))
            conn.commit()
        finally:
            _release_db(conn)
    return '', 204

@app.route('/auth/google')
def auth_google():
    try:
        redirect_uri = url_for('auth_google_callback', _external=True)
        return google_oauth.authorize_redirect(redirect_uri)
    except Exception as e:
        print(f"Google auth redirect error: {e}")
        return redirect(url_for('login_page') + '?error=google_failed')

@app.route('/auth/google/callback')
def auth_google_callback():
    try:
        token    = google_oauth.authorize_access_token()
        userinfo = token.get('userinfo') or {}
        google_id = userinfo.get('sub')
        email     = (userinfo.get('email') or '').lower()
        name      = userinfo.get('name') or email.split('@')[0]
        avatar    = userinfo.get('picture')
        if not google_id or not email:
            return redirect(url_for('login_page') + '?error=google_failed')
        conn = _get_db()
        try:
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute("SELECT * FROM users WHERE google_id = %s OR email = %s",
                        (google_id, email))
            row = cur.fetchone()
            if row:
                row = dict(row)
                if not row.get('google_id'):
                    conn.cursor().execute(
                        "UPDATE users SET google_id=%s, avatar_url=%s WHERE id=%s",
                        (google_id, avatar, row['id']))
                    conn.commit()
                    row.update({'google_id': google_id, 'avatar_url': avatar})
            else:
                cur2 = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
                cur2.execute("""
                    INSERT INTO users (email, username, google_id, avatar_url)
                    VALUES (%s, %s, %s, %s) RETURNING *
                """, (email, name, google_id, avatar))
                row = dict(cur2.fetchone())
                conn.commit()
        finally:
            _release_db(conn)
        user = User(row)
        login_user(user, remember=True)
        _record_login(user.id)
        return redirect(url_for('index'))
    except Exception as e:
        print(f"Google auth error: {e}")
        return redirect(url_for('login_page') + '?error=google_failed')

# ── Admin routes ──────────────────────────────────────────────────────────────

@app.route('/admin')
def admin_dashboard():
    if not current_user.is_authenticated or not current_user.is_admin:
        return redirect(url_for('login_page'))
    conn = _get_db()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT COUNT(*) AS n FROM users")
        total_users = cur.fetchone()['n']
        cur.execute("SELECT COUNT(*) AS n FROM users WHERE is_admin=TRUE")
        total_admins = cur.fetchone()['n']
        cur.execute("SELECT COUNT(*) AS n FROM users WHERE last_seen > NOW() - INTERVAL '5 minutes'")
        online_now = cur.fetchone()['n']
        cur.execute("SELECT COUNT(*) AS n FROM images WHERE deleted_at IS NULL")
        total_images = cur.fetchone()['n']
        cur.execute("SELECT COUNT(*) AS n FROM scores")
        total_scores = cur.fetchone()['n']
        cur.execute("""
            SELECT u.id, u.email, u.username, u.is_admin, u.is_permanent_admin,
                   u.avatar_url, u.created_at, u.last_seen,
                   (SELECT COUNT(*) FROM images i WHERE i.uploaded_by = u.id AND i.deleted_at IS NULL)  AS image_count,
                   (SELECT COUNT(*) FROM scores s WHERE s.user_id     = u.id)  AS score_count,
                   (u.last_seen > NOW() - INTERVAL '5 minutes')                AS is_online
            FROM users u ORDER BY u.last_seen DESC NULLS LAST
        """)
        users = [dict(r) for r in cur.fetchall()]
    finally:
        _release_db(conn)
    return render_template('admin.html',
        total_users=total_users, total_admins=total_admins,
        online_now=online_now, total_images=total_images,
        total_scores=total_scores, users=users)

@app.route('/admin/user/<int:user_id>')
def admin_user_detail(user_id):
    if not current_user.is_authenticated or not current_user.is_admin:
        return redirect(url_for('login_page'))
    conn = _get_db()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM users WHERE id = %s", (user_id,))
        target = cur.fetchone()
        if not target:
            return "User not found", 404
        target = dict(target)
        cur.execute("""SELECT * FROM user_sessions WHERE user_id=%s
                       ORDER BY logged_in_at DESC LIMIT 30""", (user_id,))
        sessions = [dict(r) for r in cur.fetchall()]
        cur.execute("""SELECT collection_name, filename, url, created_at
                       FROM images WHERE uploaded_by=%s AND deleted_at IS NULL
                       ORDER BY created_at DESC LIMIT 50""", (user_id,))
        uploads = [dict(r) for r in cur.fetchall()]
        cur.execute("""SELECT collection_name, game_type, data, created_at
                       FROM scores WHERE user_id=%s ORDER BY created_at DESC LIMIT 50""", (user_id,))
        scores = [dict(r) for r in cur.fetchall()]
        cur.execute(
            "SELECT collection_name FROM video_collection_access WHERE user_id = %s",
            (user_id,)
        )
        granted_collections = {row[0] for row in cur.fetchall()}
    finally:
        _release_db(conn)

    video_collections = sorted(_video_capable_collections().keys())
    all_collections = _load_collections()
    return render_template('admin_user_detail.html',
        target_user=target, sessions=sessions, uploads=uploads, scores=scores,
        video_collections=video_collections, granted_collections=granted_collections,
        all_collections=all_collections)

@app.route('/api/admin/user/<int:user_id>/set-admin', methods=['POST'])
@admin_required
def api_set_admin(user_id):
    data = request.get_json() or {}
    make_admin = bool(data.get('is_admin', False))
    conn = _get_db()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT is_permanent_admin FROM users WHERE id=%s", (user_id,))
        row = cur.fetchone()
        if not row:
            return jsonify({'error': 'User not found'}), 404
        if row['is_permanent_admin']:
            return jsonify({'error': 'Cannot modify permanent admin'}), 403
        conn.cursor().execute("UPDATE users SET is_admin=%s WHERE id=%s", (make_admin, user_id))
        conn.commit()
    finally:
        _release_db(conn)
    return jsonify({'success': True, 'is_admin': make_admin})

# ── Admin: video collections & access control ─────────────────────────────────

def _all_users_basic():
    conn = _get_db()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT id, email, username, avatar_url, is_admin
            FROM users ORDER BY username
        """)
        return [dict(r) for r in cur.fetchall()]
    finally:
        _release_db(conn)

@app.route('/admin/videos')
def admin_videos_dashboard():
    if not current_user.is_authenticated or not current_user.is_admin:
        return redirect(url_for('login_page'))
    video_counts = _video_capable_collections()
    collections = _load_collections()
    return render_template('admin-videos.html', collections=collections, video_counts=video_counts)

@app.route('/admin/videos/<collection_name>')
def admin_video_collection_detail(collection_name):
    if not current_user.is_authenticated or not current_user.is_admin:
        return redirect(url_for('login_page'))
    safe_name = _safe_collection_name(collection_name)
    if not _collection_exists(safe_name):
        return "Collection not found", 404

    videos = _load_collection_videos(safe_name)
    users = _all_users_basic()

    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT user_id FROM video_collection_access WHERE collection_name = %s",
            (safe_name,)
        )
        collection_access_ids = sorted({row[0] for row in cur.fetchall()})

        cur.execute("""
            SELECT a.video_id, a.user_id FROM video_item_access a
            JOIN videos v ON v.id = a.video_id
            WHERE v.collection_name = %s
        """, (safe_name,))
        item_access = {}
        for video_id, user_id in cur.fetchall():
            item_access.setdefault(video_id, []).append(user_id)
    finally:
        _release_db(conn)

    return render_template('admin-video-collection.html',
        collection=safe_name, videos=videos, users=users,
        collection_access_ids=collection_access_ids, item_access=item_access)

@app.route('/api/admin/videos/<collection_name>/delete', methods=['POST'])
@admin_required
def api_delete_video(collection_name):
    data = request.get_json() or {}
    video_id = data.get('video_id')
    safe_name = _safe_collection_name(collection_name)

    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT filename FROM videos WHERE id = %s AND collection_name = %s",
            (video_id, safe_name)
        )
        row = cur.fetchone()
    finally:
        _release_db(conn)

    if not row:
        return jsonify({'success': False, 'error': 'Video not found'}), 404

    filename = row[0]
    try:
        _b2_delete_object(_get_image_key(safe_name, filename))
    except Exception:
        pass

    _db_delete_video(video_id)
    return jsonify({'success': True})

@app.route('/api/admin/videos/<collection_name>/access', methods=['POST'])
@admin_required
def api_set_collection_video_access(collection_name):
    """Grant or revoke a user's access to every video in a collection."""
    data = request.get_json() or {}
    user_id = data.get('user_id')
    grant = bool(data.get('grant'))
    safe_name = _safe_collection_name(collection_name)

    if not user_id or not _collection_exists(safe_name):
        return jsonify({'success': False, 'error': 'Invalid collection or user'}), 400

    if grant:
        _grant_collection_video_access(safe_name, user_id, current_user.id)
    else:
        _revoke_collection_video_access(safe_name, user_id)

    return jsonify({'success': True, 'granted': grant})

@app.route('/api/admin/videos/<collection_name>/<int:video_id>/access', methods=['POST'])
@admin_required
def api_set_video_item_access(collection_name, video_id):
    """Grant or revoke a user's access to one specific video."""
    data = request.get_json() or {}
    user_id = data.get('user_id')
    grant = bool(data.get('grant'))
    safe_name = _safe_collection_name(collection_name)

    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT 1 FROM videos WHERE id = %s AND collection_name = %s",
            (video_id, safe_name)
        )
        exists = cur.fetchone() is not None
    finally:
        _release_db(conn)

    if not user_id or not exists:
        return jsonify({'success': False, 'error': 'Invalid video or user'}), 400

    if grant:
        _grant_video_item_access(video_id, user_id, current_user.id)
    else:
        _revoke_video_item_access(video_id, user_id)

    return jsonify({'success': True, 'granted': grant})

# ── Admin: per-user image content blocks ────────────────────────────────────────

@app.route('/api/admin/user/<int:user_id>/content-blocks/<collection_name>')
@admin_required
def api_get_content_blocks(user_id, collection_name):
    """The (body_part, rating) pairs actually present in this collection, with
    counts and whether this user is currently blocked from each — lazy-loaded
    by the Content Blocks accordion on the admin user-detail page."""
    safe_name = _safe_collection_name(collection_name)
    if not _collection_exists(safe_name):
        return jsonify({'success': False, 'error': 'Collection not found'}), 404

    pairs = _collection_body_part_pairs_with_counts(safe_name)
    blocked = _user_blocked_pairs(user_id, safe_name)
    result = [{
        'part': part,
        'rating': rating,
        'label': f"{part.title()} ({_BODY_PART_RATING_LABELS.get(rating, rating)})",
        'count': count,
        'blocked': (part, rating) in blocked,
    } for part, rating, count in pairs]

    return jsonify({'success': True, 'pairs': result})

@app.route('/api/admin/user/<int:user_id>/content-blocks', methods=['POST'])
@admin_required
def api_set_content_block(user_id):
    """Block or unblock this user from one body_part:rating pair in one collection."""
    data = request.get_json() or {}
    collection = _safe_collection_name(str(data.get('collection') or ''))
    body_part = str(data.get('body_part') or '')
    rating = str(data.get('rating') or '')
    grant = bool(data.get('grant'))

    if not collection or not _collection_exists(collection) or not body_part or not rating:
        return jsonify({'success': False, 'error': 'Invalid collection, body_part, or rating'}), 400

    if grant:
        _grant_content_block(collection, body_part, rating, user_id, current_user.id)
    else:
        _revoke_content_block(collection, body_part, rating, user_id)

    return jsonify({'success': True, 'granted': grant})

# ── Admin: image health (untagged / unknown subject / orphaned / missing B2 backup) ──
# Four views over the images table's edge cases:
#  - untagged: active images missing a rating for at least one BODY_PARTS entry
#  - unknown-subject: active images with no rows in image_models (no subject assigned)
#  - orphaned: soft-deleted images whose B2 backup still exists, awaiting purge
#  - missing-backup: active images where the best-effort B2 backup upload never
#    landed (or hasn't been retried since), so they exist only on Cloudinary

@app.route('/admin/untagged-images')
def admin_untagged_images():
    """An image counts as 'untagged' only once EVERY body part in BODY_PARTS has
    a rating — the jsonb '?&' operator checks all of those keys are present."""
    if not current_user.is_authenticated or not current_user.is_admin:
        return redirect(url_for('login_page'))
    conn = _get_db()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT i.id, i.collection_name, i.filename, i.url, i.tags, i.body_parts, i.created_at,
                   u.username AS uploader_username, u.email AS uploader_email
            FROM images i
            LEFT JOIN users u ON u.id = i.uploaded_by
            WHERE i.deleted_at IS NULL
              AND NOT (COALESCE(i.body_parts, '{}'::jsonb) ?& %s)
            ORDER BY i.created_at DESC
        """, (BODY_PARTS,))
        untagged = [dict(r) for r in cur.fetchall()]
        for row in untagged:
            row['tags'] = list(row['tags']) if row['tags'] else []
            row['body_parts'] = dict(row['body_parts']) if row['body_parts'] else {}
    finally:
        _release_db(conn)
    return render_template('admin-untagged-images.html', untagged=untagged, body_parts=BODY_PARTS)

@app.route('/admin/unknown-subject-images')
def admin_unknown_subject_images():
    """Images with zero rows in image_models — nobody has assigned a subject/model to them."""
    if not current_user.is_authenticated or not current_user.is_admin:
        return redirect(url_for('login_page'))
    conn = _get_db()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT i.id, i.collection_name, i.filename, i.url, i.created_at,
                   u.username AS uploader_username, u.email AS uploader_email
            FROM images i
            LEFT JOIN users u ON u.id = i.uploaded_by
            WHERE i.deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM image_models im WHERE im.image_id = i.id)
            ORDER BY i.created_at DESC
        """)
        unknown_subject = [dict(r) for r in cur.fetchall()]
    finally:
        _release_db(conn)
    return render_template('admin-unknown-subject-images.html', unknown_subject=unknown_subject)

@app.route('/admin/missing-backup-images')
def admin_missing_backup_images():
    if not current_user.is_authenticated or not current_user.is_admin:
        return redirect(url_for('login_page'))
    conn = _get_db()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT i.id, i.collection_name, i.filename, i.url, i.created_at,
                   u.username AS uploader_username, u.email AS uploader_email
            FROM images i
            LEFT JOIN users u ON u.id = i.uploaded_by
            WHERE i.deleted_at IS NULL AND i.b2_backup_key IS NULL
            ORDER BY i.created_at DESC
        """)
        missing_backup = [dict(r) for r in cur.fetchall()]
    finally:
        _release_db(conn)
    return render_template('admin-missing-backup-images.html', missing_backup=missing_backup)

@app.route('/api/admin/images/<int:image_id>/retry-backup', methods=['POST'])
@admin_required
def api_retry_image_backup(image_id):
    """Best-effort: download an image back off Cloudinary and upload it to B2,
    for images whose original upload-time backup attempt failed or was never
    tried. No-ops (400) if a backup already exists or the image is deleted."""
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT collection_name, filename, url, b2_backup_key, deleted_at FROM images WHERE id = %s",
            (image_id,)
        )
        row = cur.fetchone()
    finally:
        _release_db(conn)

    if not row:
        return jsonify({'success': False, 'error': 'Image not found'}), 404
    collection, filename, url, existing_backup_key, deleted_at = row
    if deleted_at is not None:
        return jsonify({'success': False, 'error': 'Image is deleted'}), 400
    if existing_backup_key:
        return jsonify({'success': False, 'error': 'Backup already exists'}), 400
    if not _HTTP_AVAILABLE:
        return jsonify({'success': False, 'error': 'HTTP client not available'}), 500

    key = _get_image_key(collection, filename)
    try:
        resp = _http.get(url, timeout=30)
        resp.raise_for_status()
        _b2_upload_fileobj(io.BytesIO(resp.content), key, resp.headers.get('Content-Type'))
    except Exception as e:
        return jsonify({'success': False, 'error': f'Backup retry failed: {str(e)}'}), 500

    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("UPDATE images SET b2_backup_key = %s WHERE id = %s", (key, image_id))
        conn.commit()
    finally:
        _release_db(conn)

    return jsonify({'success': True, 'b2_backup_key': key})

# ── Admin: AI quote batch generation ────────────────────────────────────────────
# The chat completion call itself always happens client-side (see hf-client.js —
# the server has no outbound path to huggingface.co), so these routes only ever
# list collections/images and their current ai_quote status; the actual
# generate-and-cache loop is driven by the browser hitting the same
# /api/images/<collection>/<filename>/ai-quote-prompt and .../ai-quote endpoints
# the single-image gallery flow already uses, once per selected image.

@app.route('/admin/ai-quotes')
def admin_ai_quotes_dashboard():
    if not current_user.is_authenticated or not current_user.is_admin:
        return redirect(url_for('login_page'))
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT collection_name,
                   COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE ai_quote IS NOT NULL AND ai_quote <> '') AS with_quote
            FROM images
            WHERE deleted_at IS NULL
            GROUP BY collection_name
        """)
        counts = {row[0]: {'total': row[1], 'with_quote': row[2]} for row in cur.fetchall()}
    finally:
        _release_db(conn)

    collections = []
    for name in _load_collections():
        c = counts.get(name, {'total': 0, 'with_quote': 0})
        collections.append({
            'name': name, 'total': c['total'], 'with_quote': c['with_quote'],
            'missing': c['total'] - c['with_quote'],
        })
    collections.sort(key=lambda c: c['name'])
    return render_template('admin-ai-quotes.html', collections=collections)

@app.route('/admin/ai-quotes/<collection_name>')
def admin_ai_quotes_collection(collection_name):
    if not current_user.is_authenticated or not current_user.is_admin:
        return redirect(url_for('login_page'))
    safe_name = _safe_collection_name(collection_name)
    if not _collection_exists(safe_name):
        return "Collection not found", 404
    conn = _get_db()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT filename, url, tags, ai_quote
            FROM images
            WHERE collection_name = %s AND deleted_at IS NULL
            ORDER BY created_at DESC
        """, (safe_name,))
        images = [dict(r) for r in cur.fetchall()]
        for img in images:
            img['tags'] = list(img['tags']) if img['tags'] else []
    finally:
        _release_db(conn)
    return render_template('admin-ai-quotes-collection.html', collection=safe_name, images=images)

# ── Admin: orphaned image backups ──────────────────────────────────────────────
# Soft-deleted images keep their row (deleted_at set) and their B2 backup key so
# an admin can review what was deleted and, if needed, recover it from B2 before
# permanently purging the backup copy.

@app.route('/admin/orphaned-images')
def admin_orphaned_images():
    if not current_user.is_authenticated or not current_user.is_admin:
        return redirect(url_for('login_page'))
    conn = _get_db()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT i.id, i.collection_name, i.filename, i.tags, i.b2_backup_key,
                   i.deleted_at, u.username AS uploader_username, u.email AS uploader_email
            FROM images i
            LEFT JOIN users u ON u.id = i.uploaded_by
            WHERE i.deleted_at IS NOT NULL
            ORDER BY i.deleted_at DESC
        """)
        orphans = [dict(r) for r in cur.fetchall()]
    finally:
        _release_db(conn)
    return render_template('admin-orphaned-images.html', orphans=orphans)

@app.route('/api/admin/orphaned-images/<int:image_id>/purge', methods=['POST'])
@admin_required
def api_purge_orphaned_image(image_id):
    """Permanently delete an orphaned image's B2 backup and its DB row."""
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("SELECT b2_backup_key, deleted_at FROM images WHERE id = %s", (image_id,))
        row = cur.fetchone()
    finally:
        _release_db(conn)

    if not row:
        return jsonify({'success': False, 'error': 'Image not found'}), 404
    if row[1] is None:
        return jsonify({'success': False, 'error': 'Image is not soft-deleted'}), 400

    b2_backup_key = row[0]
    if b2_backup_key:
        try:
            _b2_delete_object(b2_backup_key)
        except Exception as e:
            return jsonify({'success': False, 'error': f'B2 purge failed: {str(e)}'}), 500

    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM images WHERE id = %s", (image_id,))
        conn.commit()
    finally:
        _release_db(conn)

    return jsonify({'success': True})

# ── Versus Zoom Reveal: live 2-player room/match state machine ────────────────
# Each player sees a different zoomed-in crop of one of two images and races to
# guess which of the two (shown blurred, same order for both players) it came
# from. Room state lives in a plain process-local dict — fine since gunicorn
# runs a single worker process here and rooms only last the length of one
# match (a few minutes), so there's no need to persist this in Postgres.

_vz_rooms = {}      # room_code -> room state
_vz_sid_room = {}   # socket id -> room_code, for disconnect cleanup

VZ_ROUNDS_PER_MATCH = 5
VZ_ANSWER_WINDOW = 14   # seconds players get to lock in a guess each round
VZ_REVEAL_PAUSE = 5      # seconds the reveal stays up before the next round


def _vz_gen_code():
    alphabet = string.ascii_uppercase + string.digits
    while True:
        code = ''.join(random.choices(alphabet, k=5))
        if code not in _vz_rooms:
            return code


def _vz_collection_images(collection, blocked=None):
    """blocked: optional set of (body_part, rating) pairs to exclude (union of every
    player currently in the room — see vz_join/mm_join/cc_join for why this is
    re-run at join time rather than only once at create time)."""
    tags_data = _load_tags()
    prefix = f"{collection}/"
    images = []
    for key, value in tags_data.items():
        if key.startswith(prefix) and isinstance(value, dict) and value.get('url'):
            if blocked and not _image_visible_to_user(value.get('body_parts', {}), blocked):
                continue
            images.append({'filename': key[len(prefix):], 'url': value['url']})
    return images


def _vz_random_crop():
    """A believable zoomed-in crop window, as top-left-origin fractions of the full image."""
    w = random.uniform(0.22, 0.34)
    h = random.uniform(0.22, 0.34)
    x = random.uniform(0, 1 - w)
    y = random.uniform(0, 1 - h)
    return {'x': round(x, 4), 'y': round(y, 4), 'w': round(w, 4), 'h': round(h, 4)}


def _vz_start_round(room, code):
    pool = [img for img in room['pool'] if img['url'] not in room['used']]
    if len(pool) < 2:
        room['used'] = set()
        pool = room['pool']
    pair = random.sample(pool, 2)
    for img in pair:
        room['used'].add(img['url'])

    sids = list(room['players'].keys())
    random.shuffle(sids)
    crops = [_vz_random_crop(), _vz_random_crop()]
    assignment = {sids[0]: 0, sids[1]: 1}

    room['round'] += 1
    room['phase'] = 'guessing'
    room['images'] = pair
    room['crops'] = crops
    room['assignment'] = assignment
    room['answers'] = {}
    deadline = _time.time() + VZ_ANSWER_WINDOW
    room['round_deadline'] = deadline

    for sid, idx in assignment.items():
        socketio.emit('vz_round', {
            'round': room['round'],
            'totalRounds': VZ_ROUNDS_PER_MATCH,
            'images': [pair[0]['url'], pair[1]['url']],
            'yourCrop': {'imageUrl': pair[idx]['url'], 'box': crops[idx]},
            'secondsLeft': VZ_ANSWER_WINDOW,
            'players': room['players'],
            'scores': room['scores'],
        }, room=sid)

    socketio.start_background_task(_vz_round_timeout, code, room['round'])


def _vz_round_timeout(code, round_num):
    socketio.sleep(VZ_ANSWER_WINDOW)
    room = _vz_rooms.get(code)
    if room and room['round'] == round_num and room['phase'] == 'guessing':
        _vz_resolve_round(room, code)


def _vz_resolve_round(room, code):
    room['phase'] = 'reveal'
    assignment = room['assignment']
    images = room['images']
    results = {}
    for sid, idx in assignment.items():
        guess = room['answers'].get(sid)
        is_correct = (guess == idx)
        if is_correct:
            room['scores'][sid] += 100
        results[sid] = {'guess': guess, 'correctImageIndex': idx, 'isCorrect': is_correct}

    both_correct = len(results) == 2 and all(r['isCorrect'] for r in results.values())
    if both_correct:
        for sid in room['scores']:
            room['scores'][sid] += 50  # perfect-round bonus for both players

    socketio.emit('vz_reveal', {
        'images': [images[0]['url'], images[1]['url']],
        'crops': room['crops'],
        'players': room['players'],
        'results': results,
        'scores': room['scores'],
        'bothCorrect': both_correct,
        'round': room['round'],
        'totalRounds': VZ_ROUNDS_PER_MATCH,
    }, room=code)

    if room['round'] >= VZ_ROUNDS_PER_MATCH:
        room['phase'] = 'finished'
        socketio.start_background_task(_vz_finish_after_delay, code)
    else:
        socketio.start_background_task(_vz_next_round_after_delay, code)


def _vz_next_round_after_delay(code):
    socketio.sleep(VZ_REVEAL_PAUSE)
    room = _vz_rooms.get(code)
    if room and room['phase'] != 'finished' and len(room['players']) == 2:
        _vz_start_round(room, code)


def _vz_finish_after_delay(code):
    socketio.sleep(VZ_REVEAL_PAUSE)
    room = _vz_rooms.get(code)
    if room:
        socketio.emit('vz_match_over', {'players': room['players'], 'scores': room['scores']}, room=code)


@socketio.on('vz_create')
def vz_create(data):
    if not current_user.is_authenticated:
        emit('vz_error', {'message': 'Please sign in to play.'})
        return
    data = data or {}
    collection = _safe_collection_name(str(data.get('collection') or ''))
    username = str(data.get('username') or 'Player 1').strip()[:20] or 'Player 1'
    opponent_name = str(data.get('opponentUsername') or 'Player 2').strip()[:20] or 'Player 2'
    creator_id = current_user.id if current_user.is_authenticated else None
    images = _vz_collection_images(collection, _effective_blocked_pairs(current_user, collection))
    if len(images) < 4:
        emit('vz_error', {'message': 'This collection needs at least 4 images to play.'})
        return

    code = _vz_gen_code()
    _vz_rooms[code] = {
        'collection': collection,
        'pool': images,
        'used': set(),
        'players': {request.sid: username},
        'user_ids': {request.sid: creator_id},
        'scores': {request.sid: 0},
        'pending_opponent_name': opponent_name,
        'round': 0,
        'phase': 'lobby',
    }
    _vz_sid_room[request.sid] = code
    sio_join_room(code)
    emit('vz_created', {'code': code, 'username': username})


@socketio.on('vz_join')
def vz_join(data):
    if not current_user.is_authenticated:
        emit('vz_error', {'message': 'Please sign in to play.'})
        return
    data = data or {}
    code = str(data.get('code') or '').strip().upper()
    room = _vz_rooms.get(code)
    if not room:
        emit('vz_error', {'message': 'Room not found. Check the code and try again.'})
        return
    if len(room['players']) >= 2:
        emit('vz_error', {'message': 'That room is already full.'})
        return

    username = room.get('pending_opponent_name') or 'Player 2'
    room['players'][request.sid] = username
    room['user_ids'][request.sid] = current_user.id if current_user.is_authenticated else None
    room['scores'][request.sid] = 0
    _vz_sid_room[request.sid] = code
    sio_join_room(code)

    # Rebuild the pool now that both players are known — a player's content
    # blocks must never be shown to them (or their opponent) once gameplay starts.
    # No image has been revealed to anyone yet, so this is safe to do here.
    combined_blocked = _union_blocked_pairs(room['user_ids'].values(), room['collection'])
    room['pool'] = _vz_collection_images(room['collection'], combined_blocked)
    if len(room['pool']) < 4:
        socketio.emit('vz_error', {'message': 'Not enough images available for both players. Room closed.'}, room=code)
        for sid in list(room['players'].keys()):
            _vz_sid_room.pop(sid, None)
        _vz_rooms.pop(code, None)
        return

    emit('vz_joined', {'code': code, 'username': username})
    socketio.emit('vz_opponent_joined', {'players': room['players']}, room=code)
    _vz_start_round(room, code)


@socketio.on('vz_answer')
def vz_answer(data):
    data = data or {}
    code = _vz_sid_room.get(request.sid)
    room = _vz_rooms.get(code)
    if not room or room['phase'] != 'guessing':
        return
    choice = data.get('choice')
    if choice not in (0, 1):
        return
    if request.sid in room['answers']:
        return
    room['answers'][request.sid] = choice
    emit('vz_answer_locked', {})
    if len(room['answers']) >= len(room['players']) and len(room['players']) == 2:
        _vz_resolve_round(room, code)


def _vz_handle_disconnect(sid):
    code = _vz_sid_room.pop(sid, None)
    if not code:
        return
    room = _vz_rooms.get(code)
    if not room:
        return
    room['players'].pop(sid, None)
    socketio.emit('vz_opponent_left', {}, room=code)
    if not room['players']:
        _vz_rooms.pop(code, None)


# ── Memory Match Duel: live 2-player turn-based Concentration ─────────────────
# Classic memory-match rules over a shared, server-authoritative board: players
# alternate turns flipping two cards each — a match keeps the same player's
# turn and scores a point, a miss flips both back and passes the turn. The
# winner is simply whoever found more pairs, which is exactly how the
# real-world game is scored, so there's nothing to argue is "fair" — it's the
# same count either player could verify by eye on the finished board.

_mm_rooms = {}
_mm_sid_room = {}

MM_MIN_IMAGES = 4         # need at least 4 unique images (8 cards) for a sensible game
MM_MIN_CELL_PX = 40
MM_MAX_CELL_PX = 800
MM_MISMATCH_PAUSE = 1.4   # seconds a wrong pair stays face-up before flipping back
MM_MATCH_PAUSE = 0.8      # seconds a found pair stays highlighted before the next flip is allowed


def _mm_gen_code():
    alphabet = string.ascii_uppercase + string.digits
    while True:
        code = ''.join(random.choices(alphabet, k=5))
        if code not in _mm_rooms:
            return code


def _mm_build_board(collection, num_images, blocked=None):
    """num_images is the count of *unique* images the host picked — the
    board itself has twice that many cards (each image appears as a pair).
    blocked: optional union of blocked pairs — see mm_join, which rebuilds this
    authoritatively once both players are known, before any card is revealed."""
    images = _vz_collection_images(collection, blocked)
    if len(images) < num_images:
        return None, len(images)
    chosen = random.sample(images, num_images)
    board = [img['url'] for img in chosen] * 2
    random.shuffle(board)
    return board, len(images)


@socketio.on('mm_create')
def mm_create(data):
    if not current_user.is_authenticated:
        emit('mm_error', {'message': 'Please sign in to play.'})
        return
    data = data or {}
    collection = _safe_collection_name(str(data.get('collection') or ''))
    username = str(data.get('username') or 'Player 1').strip()[:20] or 'Player 1'
    opponent_name = str(data.get('opponentUsername') or 'Player 2').strip()[:20] or 'Player 2'

    try:
        num_images = int(data.get('numImages'))
    except (TypeError, ValueError):
        num_images = 8
    num_images = max(MM_MIN_IMAGES, num_images)

    def _clamp_px(value, fallback):
        try:
            value = int(value)
        except (TypeError, ValueError):
            return fallback
        return max(MM_MIN_CELL_PX, min(MM_MAX_CELL_PX, value))

    card_width = _clamp_px(data.get('cardWidth'), 100)
    card_height = _clamp_px(data.get('cardHeight'), 100)
    fit_mode = str(data.get('fitMode') or 'fit')
    if fit_mode not in ('fit', 'stretch'):
        fit_mode = 'fit'

    creator_id = current_user.id if current_user.is_authenticated else None
    board, available = _mm_build_board(collection, num_images, _effective_blocked_pairs(current_user, collection))
    if board is None:
        emit('mm_error', {'message': f'This collection only has {available} images available — pick {available} or fewer.'})
        return

    code = _mm_gen_code()
    _mm_rooms[code] = {
        'collection': collection,
        'board': board,          # rebuilt authoritatively in mm_join, before any card is revealed
        'num_images': num_images,
        'card_width': card_width,
        'card_height': card_height,
        'fit_mode': fit_mode,
        'matched_by': {},   # index -> sid
        'flipped': [],      # indices currently face-up and unresolved (max 2)
        'players': {request.sid: username},
        'user_ids': {request.sid: creator_id},
        'scores': {request.sid: 0},
        'pending_opponent_name': opponent_name,
        'current_turn': None,
        'phase': 'lobby',
    }
    _mm_sid_room[request.sid] = code
    sio_join_room(code)
    emit('mm_created', {'code': code, 'username': username})


@socketio.on('mm_join')
def mm_join(data):
    if not current_user.is_authenticated:
        emit('mm_error', {'message': 'Please sign in to play.'})
        return
    data = data or {}
    code = str(data.get('code') or '').strip().upper()
    room = _mm_rooms.get(code)
    if not room:
        emit('mm_error', {'message': 'Room not found. Check the code and try again.'})
        return
    if len(room['players']) >= 2:
        emit('mm_error', {'message': 'That room is already full.'})
        return

    username = room.get('pending_opponent_name') or 'Player 2'
    room['players'][request.sid] = username
    room['user_ids'][request.sid] = current_user.id if current_user.is_authenticated else None
    room['scores'][request.sid] = 0
    _mm_sid_room[request.sid] = code
    sio_join_room(code)

    # Rebuild the board now that both players are known — no card has been
    # revealed to anyone yet (mm_game_start below only sends a card count).
    combined_blocked = _union_blocked_pairs(room['user_ids'].values(), room['collection'])
    board, available = _mm_build_board(room['collection'], room['num_images'], combined_blocked)
    if board is None:
        socketio.emit('mm_error', {'message': f'Not enough images available for both players ({available} available). Room closed.'}, room=code)
        for sid in list(room['players'].keys()):
            _mm_sid_room.pop(sid, None)
        _mm_rooms.pop(code, None)
        return
    room['board'] = board

    sids = list(room['players'].keys())
    room['current_turn'] = random.choice(sids)
    room['phase'] = 'playing'

    emit('mm_joined', {'code': code, 'username': username})
    socketio.emit('mm_game_start', {
        'numCards': len(room['board']),
        'cardWidth': room['card_width'],
        'cardHeight': room['card_height'],
        'fitMode': room['fit_mode'],
        'players': room['players'],
        'scores': room['scores'],
        'currentTurn': room['current_turn'],
    }, room=code)


@socketio.on('mm_flip')
def mm_flip(data):
    data = data or {}
    code = _mm_sid_room.get(request.sid)
    room = _mm_rooms.get(code)
    if not room or room['phase'] != 'playing':
        return
    if room['current_turn'] != request.sid:
        emit('mm_error', {'message': "It's not your turn."})
        return
    try:
        index = int(data.get('index'))
    except (TypeError, ValueError):
        return
    if index < 0 or index >= len(room['board']):
        return
    if index in room['matched_by'] or index in room['flipped']:
        return
    if len(room['flipped']) >= 2:
        return

    room['flipped'].append(index)
    socketio.emit('mm_card_flipped', {'index': index, 'imageUrl': room['board'][index]}, room=code)

    if len(room['flipped']) == 2:
        _mm_resolve_flip(room, code)


def _mm_resolve_flip(room, code):
    i1, i2 = room['flipped']
    is_match = room['board'][i1] == room['board'][i2]
    room['phase'] = 'resolving'

    if is_match:
        sid = room['current_turn']
        room['matched_by'][i1] = sid
        room['matched_by'][i2] = sid
        room['scores'][sid] += 1
        room['flipped'] = []

        socketio.emit('mm_resolve', {
            'indices': [i1, i2],
            'matched': True,
            'matchedBy': sid,
            'scores': room['scores'],
        }, room=code)

        if len(room['matched_by']) == len(room['board']):
            _mm_finish_match(room, code)
        else:
            socketio.start_background_task(_mm_resume_after_match, code)
    else:
        socketio.emit('mm_resolve', {
            'indices': [i1, i2],
            'matched': False,
            'scores': room['scores'],
        }, room=code)
        socketio.start_background_task(_mm_pass_turn_after_delay, code)


def _mm_resume_after_match(code):
    socketio.sleep(MM_MATCH_PAUSE)
    room = _mm_rooms.get(code)
    if room and room['phase'] == 'resolving':
        room['phase'] = 'playing'
        # current_turn is unchanged — the same player goes again on a match,
        # so there's nothing new to broadcast; clients infer this from the
        # absence of an mm_turn_change event.


def _mm_pass_turn_after_delay(code):
    socketio.sleep(MM_MISMATCH_PAUSE)
    room = _mm_rooms.get(code)
    if not room or room['phase'] != 'resolving':
        return
    room['flipped'] = []
    other = [s for s in room['players'] if s != room['current_turn']]
    if other:
        room['current_turn'] = other[0]
    room['phase'] = 'playing'
    socketio.emit('mm_turn_change', {'currentTurn': room['current_turn']}, room=code)


def _mm_finish_match(room, code):
    room['phase'] = 'finished'
    scores = room['scores']
    sids = list(scores.keys())
    winner_sid = None
    if len(sids) == 2 and scores[sids[0]] != scores[sids[1]]:
        winner_sid = max(sids, key=lambda s: scores[s])
    socketio.emit('mm_match_over', {
        'players': room['players'],
        'scores': scores,
        'winnerSid': winner_sid,
    }, room=code)


def _mm_handle_disconnect(sid):
    code = _mm_sid_room.pop(sid, None)
    if not code:
        return
    room = _mm_rooms.get(code)
    if not room:
        return
    room['players'].pop(sid, None)
    socketio.emit('mm_opponent_left', {}, room=code)
    if not room['players']:
        _mm_rooms.pop(code, None)


# ── Compatibility Check: live 2-player "which part attracted you most?" ───────
# Each round shows both players the same image plus a small set of its tags,
# filtered down to exactly the body-part categories relevant to the
# collection (chest/butt/penis for "gay"-named collections, boobs/pussy/butt
# otherwise). Both players privately pick one tag; once both have picked (or
# the round timer runs out) their picks are revealed together along with
# whether they matched. The final result is a compatibility percentage —
# shown once at the end of that match only, never persisted anywhere.

_cc_rooms = {}
_cc_sid_room = {}

CC_CATEGORY_KEYWORDS_DEFAULT = {
    'boobs': ['boobs', 'tits', 'breast', 'breasts'],
    'pussy': ['pussy', 'vagina'],
    'butt':  ['butt', 'ass', 'booty'],
    'face':  ['face'],
    'legs':  ['legs', 'thighs'],
    'belly': ['belly', 'stomach', 'tummy'],
    'abs':   ['abs'],
    'feet':  ['feet'],
}
CC_CATEGORY_KEYWORDS_GAY = {
    'chest': ['chest', 'pecs', 'pec'],
    'butt':  ['butt', 'ass', 'booty'],
    'penis': ['penis', 'cock', 'dick'],
    'face':  ['face'],
    'legs':  ['legs', 'thighs'],
    'abs':   ['abs'],
    'feet':  ['feet'],
}

CC_MIN_ROUNDS = 1
CC_MAX_ROUNDS = 50
CC_MIN_SELECT_SECONDS = 5
CC_MAX_SELECT_SECONDS = 60
CC_REVEAL_PAUSE = 4   # seconds both picks + match/no-match stay on screen before the next round


def _cc_keyword_map_for_collection(collection):
    return CC_CATEGORY_KEYWORDS_GAY if 'gay' in collection.lower() else CC_CATEGORY_KEYWORDS_DEFAULT


def _cc_categorize_tags(tags, keyword_map):
    """For each category, the first tag (in order) that matches one of its
    keywords — collapses multiple same-category tags (e.g. "big boobs" and
    "natural tits") down to a single representative option per category so
    each round shows at most one button per body part, never duplicates."""
    found = {}
    for category, keywords in keyword_map.items():
        for tag in tags:
            if any(_tags_match(tag, kw) for kw in keywords):
                found[category] = tag
                break
    return found


def _cc_gen_code():
    alphabet = string.ascii_uppercase + string.digits
    while True:
        code = ''.join(random.choices(alphabet, k=5))
        if code not in _cc_rooms:
            return code


def _cc_collection_images(collection, keyword_map, blocked=None):
    """Images with at least 2 of the keyword_map's categories present —
    fewer than 2 would make the round a forced, uninformative "match".
    blocked: optional union of blocked pairs — see cc_join, which rebuilds this
    authoritatively once both players are known, before any image is revealed."""
    tags_data = _load_tags()
    prefix = f"{collection}/"
    eligible = []
    for key, value in tags_data.items():
        if not key.startswith(prefix) or not isinstance(value, dict) or not value.get('url'):
            continue
        body_parts = value.get('body_parts', {})
        if blocked and not _image_visible_to_user(body_parts, blocked):
            continue
        if body_parts:
            # New structured format: body_parts dict keys are the categories
            options = {part: part for part in body_parts if part in keyword_map}
        else:
            # Legacy: keyword-match against flat tags list
            raw_tags = value.get('tags')
            if not isinstance(raw_tags, list) or not raw_tags:
                continue
            tags = [str(t) for t in raw_tags if isinstance(t, (str, int, float))]
            options = _cc_categorize_tags(tags, keyword_map)
        if len(options) >= 2:
            eligible.append({'filename': key[len(prefix):], 'url': value['url'], 'options': options})
    return eligible


def _cc_start_round(room, code):
    room['round'] += 1
    room['phase'] = 'selecting'
    room['selections'] = {}
    image = room['pool'][room['round'] - 1]
    room['current_image'] = image

    socketio.emit('cc_round', {
        'round': room['round'],
        'totalRounds': room['total_rounds'],
        'imageUrl': image['url'],
        'options': image['options'],
        'secondsLeft': room['round_seconds'],
        'players': room['players'],
    }, room=code)

    socketio.start_background_task(_cc_round_timeout, code, room['round'], room['round_seconds'])


def _cc_round_timeout(code, round_num, seconds):
    socketio.sleep(seconds)
    room = _cc_rooms.get(code)
    if room and room['round'] == round_num and room['phase'] == 'selecting':
        _cc_resolve_round(room, code)


def _cc_resolve_round(room, code):
    room['phase'] = 'reveal'
    image = room['current_image']
    sids = list(room['players'].keys())
    selections = room['selections']
    is_match = (
        len(sids) == 2
        and selections.get(sids[0]) is not None
        and selections.get(sids[0]) == selections.get(sids[1])
    )
    if is_match:
        room['match_count'] += 1

    room['history'].append({
        'imageUrl': image['url'],
        'options': image['options'],
        'selections': dict(selections),
        'match': is_match,
    })

    socketio.emit('cc_reveal', {
        'round': room['round'],
        'totalRounds': room['total_rounds'],
        'players': room['players'],
        'selections': selections,
        'match': is_match,
        'matchCount': room['match_count'],
    }, room=code)

    if room['round'] >= room['total_rounds']:
        room['phase'] = 'finished'
        socketio.start_background_task(_cc_finish_after_delay, code)
    else:
        socketio.start_background_task(_cc_next_round_after_delay, code)


def _cc_next_round_after_delay(code):
    socketio.sleep(CC_REVEAL_PAUSE)
    room = _cc_rooms.get(code)
    if room and room['phase'] != 'finished' and len(room['players']) == 2:
        _cc_start_round(room, code)


def _cc_finish_after_delay(code):
    socketio.sleep(CC_REVEAL_PAUSE)
    room = _cc_rooms.get(code)
    if room:
        total = room['total_rounds']
        compatibility = round(100 * room['match_count'] / total) if total else 0
        socketio.emit('cc_match_over', {
            'players': room['players'],
            'matchCount': room['match_count'],
            'totalRounds': total,
            'compatibility': compatibility,
            'history': room['history'],
        }, room=code)


@socketio.on('cc_create')
def cc_create(data):
    if not current_user.is_authenticated:
        emit('cc_error', {'message': 'Please sign in to play.'})
        return
    data = data or {}
    collection = _safe_collection_name(str(data.get('collection') or ''))
    username = str(data.get('username') or 'Player 1').strip()[:20] or 'Player 1'
    opponent_name = str(data.get('opponentUsername') or 'Player 2').strip()[:20] or 'Player 2'

    creator_id = current_user.id if current_user.is_authenticated else None
    keyword_map = _cc_keyword_map_for_collection(collection)
    images = _cc_collection_images(collection, keyword_map, _effective_blocked_pairs(current_user, collection))

    try:
        num_rounds = int(data.get('numRounds'))
    except (TypeError, ValueError):
        num_rounds = 5
    num_rounds = max(CC_MIN_ROUNDS, min(CC_MAX_ROUNDS, num_rounds))

    try:
        round_seconds = int(data.get('roundSeconds'))
    except (TypeError, ValueError):
        round_seconds = 20
    round_seconds = max(CC_MIN_SELECT_SECONDS, min(CC_MAX_SELECT_SECONDS, round_seconds))

    if not images:
        emit('cc_error', {'message': 'This collection has no images tagged with the required categories.'})
        return
    if len(images) < num_rounds:
        emit('cc_error', {'message': f'This collection only has {len(images)} eligible images — pick {len(images)} or fewer rounds.'})
        return

    code = _cc_gen_code()
    _cc_rooms[code] = {
        'collection': collection,
        'categories': list(keyword_map.keys()),
        'keyword_map': keyword_map,
        'pool': random.sample(images, num_rounds),  # rebuilt authoritatively in cc_join
        'round_seconds': round_seconds,
        'players': {request.sid: username},
        'user_ids': {request.sid: creator_id},
        'pending_opponent_name': opponent_name,
        'round': 0,
        'total_rounds': num_rounds,
        'phase': 'lobby',
        'selections': {},
        'current_image': None,
        'match_count': 0,
        'history': [],
    }
    _cc_sid_room[request.sid] = code
    sio_join_room(code)
    emit('cc_created', {'code': code, 'username': username})


@socketio.on('cc_join')
def cc_join(data):
    if not current_user.is_authenticated:
        emit('cc_error', {'message': 'Please sign in to play.'})
        return
    data = data or {}
    code = str(data.get('code') or '').strip().upper()
    room = _cc_rooms.get(code)
    if not room:
        emit('cc_error', {'message': 'Room not found. Check the code and try again.'})
        return
    if len(room['players']) >= 2:
        emit('cc_error', {'message': 'That room is already full.'})
        return

    username = room.get('pending_opponent_name') or 'Player 2'
    room['players'][request.sid] = username
    room['user_ids'][request.sid] = current_user.id if current_user.is_authenticated else None
    _cc_sid_room[request.sid] = code
    sio_join_room(code)

    # Rebuild the round pool now that both players are known — no image has
    # been revealed to anyone yet (the first cc_round emit happens below).
    combined_blocked = _union_blocked_pairs(room['user_ids'].values(), room['collection'])
    images = _cc_collection_images(room['collection'], room['keyword_map'], combined_blocked)
    if len(images) < room['total_rounds']:
        socketio.emit('cc_error', {'message': f'Not enough images available for both players ({len(images)} available). Room closed.'}, room=code)
        for sid in list(room['players'].keys()):
            _cc_sid_room.pop(sid, None)
        _cc_rooms.pop(code, None)
        return
    room['pool'] = random.sample(images, room['total_rounds'])

    emit('cc_joined', {'code': code, 'username': username})
    socketio.emit('cc_opponent_joined', {'players': room['players']}, room=code)
    _cc_start_round(room, code)


@socketio.on('cc_select')
def cc_select(data):
    data = data or {}
    code = _cc_sid_room.get(request.sid)
    room = _cc_rooms.get(code)
    if not room or room['phase'] != 'selecting':
        return
    category = str(data.get('category') or '')
    if category not in (room['current_image'] or {}).get('options', {}):
        return
    if request.sid in room['selections']:
        return
    room['selections'][request.sid] = category
    emit('cc_locked', {})
    if len(room['selections']) >= len(room['players']) and len(room['players']) == 2:
        _cc_resolve_round(room, code)


def _cc_handle_disconnect(sid):
    code = _cc_sid_room.pop(sid, None)
    if not code:
        return
    room = _cc_rooms.get(code)
    if not room:
        return
    room['players'].pop(sid, None)
    socketio.emit('cc_opponent_left', {}, room=code)
    if not room['players']:
        _cc_rooms.pop(code, None)


@socketio.on('disconnect')
def handle_disconnect():
    # Flask-SocketIO only keeps the LAST handler registered for a given event
    # name (registration overwrites, it doesn't append) — so every multiplayer
    # game's disconnect cleanup must be dispatched from this single handler
    # rather than each game registering its own @socketio.on('disconnect').
    _vz_handle_disconnect(request.sid)
    _mm_handle_disconnect(request.sid)
    _cc_handle_disconnect(request.sid)


# ── Startup ───────────────────────────────────────────────────────────────────

# Initialise DB tables on every startup (safe — uses IF NOT EXISTS)
try:
    init_db()
    _seed_admin()
except Exception as _init_err:
    print(f"WARNING: DB init skipped: {_init_err}")

# Pre-fetch Google's OIDC discovery document + JWKS now, at process startup,
# instead of lazily on the first user's login click. Authlib only fetches
# this once and caches it in-process — without pre-warming, whoever hits
# /auth/google first after a cold start (e.g. Render's free-tier dyno waking
# from sleep) pays that network round-trip inline and can hit a transient
# failure; everyone after them just uses the cached metadata.
try:
    google_oauth.load_server_metadata()
    print("Google OAuth metadata pre-warmed.")
except Exception as _oauth_warm_err:
    print(f"WARNING: Google OAuth metadata pre-warm failed (will retry lazily on first login): {_oauth_warm_err}")

if __name__ == '__main__':
    socketio.run(app)
