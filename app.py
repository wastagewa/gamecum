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

from flask import Flask, render_template, request, jsonify, send_from_directory, redirect, url_for, session
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
import boto3
import psycopg2
import psycopg2.pool
import psycopg2.extras
from flask_login import LoginManager, UserMixin, login_user, logout_user, current_user
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

_s3 = boto3.client(
    's3',
    endpoint_url=B2_ENDPOINT,
    aws_access_key_id=B2_KEY_ID,
    aws_secret_access_key=B2_APPLICATION_KEY,
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
            "SELECT collection_name, filename, url, tags, locked FROM images"
        )
        result = {}
        for coll, fname, url, tags, locked in cur.fetchall():
            result[f"{coll}/{fname}"] = {
                'tags':   list(tags) if tags else [],
                'locked': bool(locked),
                'url':    url,
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
                INSERT INTO images (collection_name, filename, url, tags, locked)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (collection_name, filename) DO UPDATE
                  SET url    = EXCLUDED.url,
                      tags   = EXCLUDED.tags,
                      locked = EXCLUDED.locked
            """, (coll, fname, value['url'],
                  value.get('tags', []), value.get('locked', False)))
        conn.commit()
    finally:
        _release_db(conn)

def _db_insert_image(collection: str, filename: str, url: str, user_id: int = None):
    """Insert a new image row, ensuring its collection exists first."""
    _ensure_collection(collection)
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO images (collection_name, filename, url, tags, locked, uploaded_by)
            VALUES (%s, %s, %s, '{}', FALSE, %s)
            ON CONFLICT (collection_name, filename) DO UPDATE
                SET url = EXCLUDED.url, uploaded_by = COALESCE(EXCLUDED.uploaded_by, images.uploaded_by)
        """, (collection, filename, url, user_id))
        conn.commit()
    finally:
        _release_db(conn)

def _db_delete_image(collection: str, filename: str):
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

def _image_exists_in_tags(safe_name: str, filename: str):
    conn = _get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT 1 FROM images WHERE collection_name = %s AND filename = %s",
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

def _normalize_tags_entry(entry):
    """Normalize a tags entry dict — kept for callers that use _load_tags() output."""
    if isinstance(entry, list):
        return {'tags': entry, 'locked': False}
    elif isinstance(entry, dict):
        if 'tags' in entry:
            return {
                'tags':   entry['tags'] if isinstance(entry['tags'], list) else [],
                'locked': entry.get('locked', False),
            }
        elif 'tag' in entry:
            return {'tags': [entry['tag']], 'locked': False}
        else:
            return {'tags': [str(v) for v in entry.values() if isinstance(v, str)], 'locked': False}
    return {'tags': [], 'locked': False}

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

def auth_or_guest(f):
    """For page routes — redirect to /login if neither logged in nor a guest session."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not current_user.is_authenticated and not session.get('is_guest'):
            return redirect(url_for('login_page'))
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
    """Return signed, directly-usable image URLs for a collection."""
    tags_data = _load_tags()
    prefix = f"{collection}/"
    urls = []
    for key, value in tags_data.items():
        if key.startswith(prefix) and isinstance(value, dict) and value.get('url'):
            urls.append(_b2_sign_url(value['url']))
    return urls

@app.route('/')
@auth_or_guest
def index():
    # Render a home page that lists collections and image counts, plus top scores.
    scores_data = _load_scores()
    leaderboards = {}
    for coll, entries in scores_data.items():
        if isinstance(entries, list):
            leaderboards[coll] = entries[:5]
        else:
            leaderboards[coll] = []

    # Count images per collection from tags.json
    tags_data = _load_tags()
    collections = {}
    for key in tags_data:
        if '/' in key and isinstance(tags_data[key], dict) and tags_data[key].get('url'):
            coll_name = key.split('/')[0]
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
@auth_or_guest
def collection_view(collection_name):
    collection = _safe_collection_name(collection_name)
    tags_data = _load_tags()
    images = []      # list of filenames (used as keys for tags/delete operations)
    image_urls = {}  # filename -> signed B2 URL
    image_tags = {}

    prefix = f"{collection}/"
    for key, value in tags_data.items():
        if not key.startswith(prefix):
            continue
        filename = key[len(prefix):]
        if not isinstance(value, dict) or not value.get('url'):
            continue
        images.append(filename)
        image_urls[filename] = _b2_sign_url(value['url'])
        raw_tags = value.get('tags', [])
        if isinstance(raw_tags, list):
            image_tags[filename] = [str(t) for t in raw_tags if isinstance(t, (str, int, float))]
        else:
            image_tags[filename] = []

    videos = _visible_videos_for_user(current_user, collection) if _user_can_view_any_video_in_collection(current_user, collection) else None

    return render_template('index.html', images=images, collection=collection,
                           image_tags=image_tags, image_urls=image_urls, videos=videos)

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
        filename = str(uuid.uuid4()) + ext
        key = _get_image_key(collection, filename)

        try:
            _b2_upload_fileobj(file.stream, key, file.mimetype)
        except Exception as e:
            return jsonify({'error': f'Upload failed: {str(e)}'}), 500

        if collection:
            user_id = current_user.id if current_user.is_authenticated else None
            _db_insert_image(collection, filename, key, user_id=user_id)

        return jsonify({
            'success': True,
            'filename': filename,
            'url': _b2_sign_url(key),
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
    """Accept a finished game score — guests get a response but scores are not saved."""
    # Guests do not have scores persisted
    if not current_user.is_authenticated:
        return jsonify({'success': True, 'updated': False, 'score': 0,
                        'leaderboard': [], 'guest': True})
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

@app.route('/delete-image/<filename>', methods=['DELETE'])
def delete_image(filename):
    try:
        _b2_delete_object(_get_image_key('', filename))
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/delete-image/<collection>/<filename>', methods=['DELETE'])
def delete_image_in_collection(collection, filename):
    collection = _safe_collection_name(collection)
    try:
        _b2_delete_object(_get_image_key(collection, filename))
        _db_delete_image(collection, filename)
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
def collection_game(collection_name):
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('game.html', images=image_urls, collection=collection)


@app.route('/puzzle')
def puzzle():
    """Render the puzzle slider game page."""
    return redirect(url_for('collection_puzzle', collection_name='Real'))


@app.route('/collection/<collection_name>/puzzle')
def collection_puzzle(collection_name):
    """Render the puzzle slider game for a specific collection."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('puzzle.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/sequence')
def collection_sequence(collection_name):
    """Render the sequence memory game for a specific collection."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('sequence.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/flashcards')
def collection_flashcards(collection_name):
    """Render the flashcards memory game for a specific collection."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('flashcards.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/hunt')
def collection_hunt(collection_name):
    """Simple Image Hunt game: show target image, player must find it in a grid."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('hunt.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/zoom')
def collection_zoom(collection_name):
    """Zoom Challenge game: show zoomed-in portion of image, identify which full image it is."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('zoom.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/whack')
def collection_whack(collection_name):
    """Whack-a-Mole game: click images as they appear on screen."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('whack.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/recall')
def collection_recall(collection_name):
    """Recall Grid game: memorize image positions and select the original spot."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('recall.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/missing')
def collection_missing(collection_name):
    """Missing Piece game: identify which image disappeared from the shown grid."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('missing.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/trail')
def collection_trail(collection_name):
    """Trail Trace game: follow a route through a memorized image grid."""
    collection = _safe_collection_name(collection_name)
    image_urls = _get_collection_image_urls(collection)
    return render_template('trail.html', images=image_urls, collection=collection)


@app.route('/collection/<collection_name>/remix')
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
def collection_tag_match(collection_name):
    """Render the Tag Match memory game for a specific collection."""
    collection = _safe_collection_name(collection_name)
    return render_template('tag-match.html', collection=collection)





@app.route('/api/images')
def api_images_all():
    """Return a JSON list of all image URLs."""
    tags_data = _load_tags()
    result = [
        _b2_sign_url(v['url']) for v in tags_data.values()
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

        # Move each B2 object to the new prefix and update its DB row
        conn = _get_db()
        try:
            cur = conn.cursor()
            cur.execute(
                "SELECT filename, url FROM images WHERE collection_name = %s",
                (safe_old,)
            )
            rows = cur.fetchall()
        finally:
            _release_db(conn)

        for filename, old_url in rows:
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
                    UPDATE images
                    SET collection_name = %s, url = %s
                    WHERE collection_name = %s AND filename = %s
                """, (safe_new, new_url, safe_old, filename))
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
        # Delete all B2 objects under this collection's folder (images and videos together)
        try:
            _b2_delete_prefix(f"{safe_name}/")
        except Exception:
            pass

        # DELETE FROM collections CASCADE-deletes all images/videos rows automatically
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
    images = []
    prefix = f"{safe_name}/"

    for key, value in tags_data.items():
        if not key.startswith(prefix):
            continue
        filename = key[len(prefix):]
        if not isinstance(value, dict) or not value.get('url'):
            continue
        normalized = _normalize_tags_entry(value)
        images.append({
            'filename': filename,
            'url': _b2_sign_url(value['url']),
            'tags': normalized['tags'],
            'locked': normalized.get('locked', False)
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
    """Copy tags from source image to target image."""
    safe_name = _safe_collection_name(collection_name)

    if not _image_exists_in_tags(safe_name, source_filename):
        return jsonify({'success': False, 'error': 'Source image not found'}), 404
    if not _image_exists_in_tags(safe_name, target_filename):
        return jsonify({'success': False, 'error': 'Target image not found'}), 404

    source_tags = _get_image_tags(safe_name, source_filename)
    _set_image_tags(safe_name, target_filename, source_tags)

    return jsonify({'success': True, 'tags': source_tags, 'message': f'Copied {len(source_tags)} tags to target image'})


@app.route('/api/collections')
def api_collections():
    """Return a JSON mapping of collection name -> list of image URLs."""
    tags_data = _load_tags()
    result = {}
    for key, value in tags_data.items():
        if '/' not in key or not isinstance(value, dict) or not value.get('url'):
            continue
        coll_name = key.split('/')[0]
        result.setdefault(coll_name, []).append(_b2_sign_url(value['url']))

    # Include empty collections with no images yet
    for coll_name in _load_collections():
        result.setdefault(coll_name, [])

    return jsonify({'collections': result})


@app.route('/api/tags')
def api_all_tags():
    """Return all image tags."""
    tags_data = _load_tags()
    # Sign URLs in a copy for the response — _load_tags()'s own return value must
    # keep raw keys, since update_image_tags() round-trips it through _save_tags().
    signed = {
        k: {**v, 'url': _b2_sign_url(v['url'])} if isinstance(v, dict) and v.get('url') else v
        for k, v in tags_data.items()
    }
    return jsonify({'tags': signed})


@app.route('/api/tags/<collection>/<filename>')
def api_image_tags(collection, filename):
    """Get tags for a specific image."""
    collection = _safe_collection_name(collection)
    image_key = _get_image_key(collection, filename)
    tags_data = _load_tags()
    
    if image_key in tags_data:
        tags = tags_data[image_key]
        # Handle both formats: list of strings or dict with 'tags' key
        if isinstance(tags, list):
            return jsonify({
                'success': True,
                'tags': tags,
                'detailed': []
            })
        elif isinstance(tags, dict):
            return jsonify({
                'success': True,
                'tags': tags.get('tags', []),
                'detailed': tags.get('detailed', [])
            })
    return jsonify({'success': False, 'tags': []}), 404


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
    matching_images = []
    
    for image_key, tag_info in tags_data.items():
        if not isinstance(tag_info, dict):
            continue
        image_tags = [t.lower() for t in tag_info.get('tags', [])]
        if search_tag in image_tags and tag_info.get('url'):
            matching_images.append({
                'url': _b2_sign_url(tag_info['url']),
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


@app.route('/api/images-by-tags')
def api_images_by_tags():
    """Get images filtered by specific tags."""
    tags_filter = request.args.getlist('tags')  # Multiple tags can be passed
    match_all = request.args.get('matchAll', 'false').lower() == 'true'
    
    if not tags_filter:
        return jsonify({'success': False, 'error': 'No tags provided'}), 400
    
    tags_data = _load_tags()
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

        # Check if image matches filter
        if match_all:
            if all(tag in tags for tag in tags_filter):
                matching_images.append({
                    'filename': filename,
                    'collection': collection,
                    'url': _b2_sign_url(tags_info['url']),
                    'tags': tags
                })
        else:
            if any(tag in tags for tag in tags_filter):
                matching_images.append({
                    'filename': filename,
                    'collection': collection,
                    'url': _b2_sign_url(tags_info['url']),
                    'tags': tags
                })
    
    return jsonify({'success': True, 'images': matching_images, 'count': len(matching_images)})


@app.route('/collection/<collection_name>/spotlight')
def collection_spotlight(collection_name):
    """Spotlight: drifting peephole reveals image; identify it before fully exposed."""
    collection = _safe_collection_name(collection_name)
    return render_template('spotlight.html', collection=collection)


@app.route('/collection/<collection_name>/flashmemory')
def collection_flashmemory(collection_name):
    """Flash Memory: image flashes briefly, then pick it from a lineup."""
    collection = _safe_collection_name(collection_name)
    return render_template('flashmemory.html', collection=collection)


@app.route('/collection/<collection_name>/whoisthat')
def collection_whoisthat(collection_name):
    """Who's That?: tags shown, no image — find which one in the lineup matches."""
    collection = _safe_collection_name(collection_name)
    return render_template('whoisthat.html', collection=collection)


@app.route('/collection/<collection_name>/oddoneout')
def collection_oddoneout(collection_name):
    """Odd One Out: find the image that doesn't share a tag with the other three."""
    collection = _safe_collection_name(collection_name)
    return render_template('oddoneout.html', collection=collection)


@app.route('/collection/<collection_name>/speedsort')
def collection_speedsort(collection_name):
    """Speed Sort: decide whether each image has the target tag before time runs out."""
    collection = _safe_collection_name(collection_name)
    return render_template('speedsort.html', collection=collection)


@app.route('/collection/<collection_name>/snap')
def collection_snap(collection_name):
    """Snap Match: decide if two images share a tag as fast as possible."""
    collection = _safe_collection_name(collection_name)
    return render_template('snap.html', collection=collection)


@app.route('/collection/<collection_name>/bracket')
def collection_bracket(collection_name):
    """Hot Bracket: vote between two images; track win-rates; declare a champion."""
    collection = _safe_collection_name(collection_name)
    return render_template('bracket.html', collection=collection)


@app.route('/collection/<collection_name>/scratch')
def collection_scratch(collection_name):
    """Striptease Scratch Card: scratch away tiles to reveal a hidden image, then identify it."""
    collection = _safe_collection_name(collection_name)
    return render_template('scratch.html', collection=collection)


@app.route('/collection/<collection_name>/behindblur')
def collection_behindblur(collection_name):
    """Behind the Blur: image clears over time — identify it before it's crystal clear."""
    collection = _safe_collection_name(collection_name)
    return render_template('behindblur.html', collection=collection)


@app.route('/collection/<collection_name>/silhouette')
def collection_silhouette(collection_name):
    """Silhouette Strike: image reveals from black silhouette to full colour — name it fast."""
    collection = _safe_collection_name(collection_name)
    return render_template('silhouette.html', collection=collection)


@app.route('/collection/<collection_name>/towerdefense')
def collection_towerdefense(collection_name):
    """Tower Defense Viewer: images march across a conveyor — save your favourites before they scroll away."""
    collection = _safe_collection_name(collection_name)
    return render_template('towerdefense.html', collection=collection)


@app.route('/collection/<collection_name>/shootinggallery')
def collection_shootinggallery(collection_name):
    """3D Shooting Gallery: shoot target images on a fairground range, avoid decoys."""
    collection = _safe_collection_name(collection_name)
    return render_template('shootinggallery.html', collection=collection)


@app.route('/collection/<collection_name>/orbitingvault')
def collection_orbitingvault(collection_name):
    """Orbiting Vault: framed images orbit on a rotating ring — click the one matching the target before it swings out of view."""
    collection = _safe_collection_name(collection_name)
    return render_template('orbitingvault.html', collection=collection)


@app.route('/collection/<collection_name>/cargobay')
def collection_cargobay(collection_name):
    """Zero-Gravity Cargo Bay: tractor-beam the drifting crate matching the target before it's lost to the airlock."""
    collection = _safe_collection_name(collection_name)
    return render_template('cargobay.html', collection=collection)


@app.route('/collection/<collection_name>/timeloop')
def collection_timeloop(collection_name):
    """Time-Loop Detective: scrub a looping noir room's timeline to catch the target photo in the right frame at the right moment."""
    collection = _safe_collection_name(collection_name)
    return render_template('timeloop.html', collection=collection)


@app.route('/collection/<collection_name>/heistdrone')
def collection_heistdrone(collection_name):
    """Gallery Heist Drone: free-fly a drone through a multi-room mansion, dodge sweeping spotlights, and scan the target painting in each room."""
    collection = _safe_collection_name(collection_name)
    return render_template('heistdrone.html', collection=collection)


@app.route('/collection/<collection_name>/versuszoom')
def collection_versuszoom(collection_name):
    """Versus Zoom Reveal: a live 2-player game — each player sees a different zoomed-in snippet and races to guess which of two blurred full images it came from."""
    collection = _safe_collection_name(collection_name)
    return render_template('versuszoom.html', collection=collection)


@app.route('/collection/<collection_name>/memorymatch')
def collection_memorymatch(collection_name):
    """Memory Match Duel: live 2-player turn-based Concentration on a shared board — find more pairs than your opponent to win."""
    collection = _safe_collection_name(collection_name)
    return render_template('memorymatch.html', collection=collection)


@app.route('/collection/<collection_name>/compatcheck')
def collection_compatcheck(collection_name):
    """Compatibility Check: a live 2-player game where each round both players privately pick which tagged body part attracted them most, then see if they matched."""
    collection = _safe_collection_name(collection_name)
    return render_template('compatcheck.html', collection=collection)


@app.route('/collection/<collection_name>/bubbleburst')
def collection_bubbleburst(collection_name):
    """Bubble Burst: pop rising bubbles that contain the target image before they escape."""
    collection = _safe_collection_name(collection_name)
    return render_template('bubbleburst.html', collection=collection)


@app.route('/collection/<collection_name>/breakout')
def collection_breakout(collection_name):
    """Image Pong (Breakout): break tiles to reveal a hidden image, guess it fast for max score."""
    collection = _safe_collection_name(collection_name)
    return render_template('breakout.html', collection=collection)


@app.route('/collection/<collection_name>/heatmap')
def collection_heatmap(collection_name):
    """Heat Map: paint on each image to show what draws your eye."""
    collection = _safe_collection_name(collection_name)
    return render_template('heatmap.html', collection=collection)


@app.route('/collection/<collection_name>/gallerywalk')
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


@app.route('/collection/<collection_name>/chat')
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
    if current_user.is_authenticated or session.get('is_guest'):
        return redirect(url_for('index'))
    return render_template('login.html')

@app.route('/logout')
def logout():
    if current_user.is_authenticated:
        _record_logout(current_user.id)
        logout_user()
    session.pop('guest_username', None)
    session.pop('is_guest', None)
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

@app.route('/api/auth/guest', methods=['POST'])
def api_guest():
    data = request.get_json() or {}
    name = str(data.get('username', 'Guest')).strip()[:30] or 'Guest'
    session['guest_username'] = name
    session['is_guest'] = True
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
    if session.get('is_guest'):
        return jsonify({'authenticated': False, 'is_guest': True,
                        'username': session.get('guest_username', 'Guest')})
    return jsonify({'authenticated': False, 'is_guest': False})

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
        cur.execute("SELECT COUNT(*) AS n FROM images")
        total_images = cur.fetchone()['n']
        cur.execute("SELECT COUNT(*) AS n FROM scores")
        total_scores = cur.fetchone()['n']
        cur.execute("""
            SELECT u.id, u.email, u.username, u.is_admin, u.is_permanent_admin,
                   u.avatar_url, u.created_at, u.last_seen,
                   (SELECT COUNT(*) FROM images i WHERE i.uploaded_by = u.id)  AS image_count,
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
                       FROM images WHERE uploaded_by=%s ORDER BY created_at DESC LIMIT 50""", (user_id,))
        uploads = [dict(r) for r in cur.fetchall()]
        for upload in uploads:
            upload['url'] = _b2_sign_url(upload['url'])
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
    return render_template('admin_user_detail.html',
        target_user=target, sessions=sessions, uploads=uploads, scores=scores,
        video_collections=video_collections, granted_collections=granted_collections)

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


def _vz_collection_images(collection):
    tags_data = _load_tags()
    prefix = f"{collection}/"
    images = []
    for key, value in tags_data.items():
        if key.startswith(prefix) and isinstance(value, dict) and value.get('url'):
            images.append({'filename': key[len(prefix):], 'url': _b2_sign_url(value['url'])})
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
    data = data or {}
    collection = _safe_collection_name(str(data.get('collection') or ''))
    username = str(data.get('username') or 'Player 1').strip()[:20] or 'Player 1'
    opponent_name = str(data.get('opponentUsername') or 'Player 2').strip()[:20] or 'Player 2'
    images = _vz_collection_images(collection)
    if len(images) < 4:
        emit('vz_error', {'message': 'This collection needs at least 4 images to play.'})
        return

    code = _vz_gen_code()
    _vz_rooms[code] = {
        'collection': collection,
        'pool': images,
        'used': set(),
        'players': {request.sid: username},
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
    room['scores'][request.sid] = 0
    _vz_sid_room[request.sid] = code
    sio_join_room(code)

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


def _mm_build_board(collection, num_images):
    """num_images is the count of *unique* images the host picked — the
    board itself has twice that many cards (each image appears as a pair)."""
    images = _vz_collection_images(collection)
    if len(images) < num_images:
        return None, len(images)
    chosen = random.sample(images, num_images)
    board = [img['url'] for img in chosen] * 2
    random.shuffle(board)
    return board, len(images)


@socketio.on('mm_create')
def mm_create(data):
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

    board, available = _mm_build_board(collection, num_images)
    if board is None:
        emit('mm_error', {'message': f'This collection only has {available} images available — pick {available} or fewer.'})
        return

    code = _mm_gen_code()
    _mm_rooms[code] = {
        'collection': collection,
        'board': board,
        'card_width': card_width,
        'card_height': card_height,
        'fit_mode': fit_mode,
        'matched_by': {},   # index -> sid
        'flipped': [],      # indices currently face-up and unresolved (max 2)
        'players': {request.sid: username},
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
    room['scores'][request.sid] = 0
    _mm_sid_room[request.sid] = code
    sio_join_room(code)

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
}
CC_CATEGORY_KEYWORDS_GAY = {
    'chest': ['chest', 'pecs', 'pec'],
    'butt':  ['butt', 'ass', 'booty'],
    'penis': ['penis', 'cock', 'dick'],
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


def _cc_collection_images(collection, keyword_map):
    """Images with at least 2 of the keyword_map's categories present —
    fewer than 2 would make the round a forced, uninformative "match"."""
    tags_data = _load_tags()
    prefix = f"{collection}/"
    eligible = []
    for key, value in tags_data.items():
        if not key.startswith(prefix) or not isinstance(value, dict) or not value.get('url'):
            continue
        raw_tags = value.get('tags')
        if not isinstance(raw_tags, list) or not raw_tags:
            continue
        tags = [str(t) for t in raw_tags if isinstance(t, (str, int, float))]
        options = _cc_categorize_tags(tags, keyword_map)
        if len(options) >= 2:
            eligible.append({'filename': key[len(prefix):], 'url': _b2_sign_url(value['url']), 'options': options})
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
    data = data or {}
    collection = _safe_collection_name(str(data.get('collection') or ''))
    username = str(data.get('username') or 'Player 1').strip()[:20] or 'Player 1'
    opponent_name = str(data.get('opponentUsername') or 'Player 2').strip()[:20] or 'Player 2'

    keyword_map = _cc_keyword_map_for_collection(collection)
    images = _cc_collection_images(collection, keyword_map)

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
        'pool': random.sample(images, num_rounds),
        'round_seconds': round_seconds,
        'players': {request.sid: username},
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
    _cc_sid_room[request.sid] = code
    sio_join_room(code)

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
