"""
Unit tests for body-part tagging logic and related helpers.
All DB / cloud dependencies are stubbed so no real services are needed.
Run: python -m pytest tests.py -v   (or: python tests.py)
"""
import sys, os, io, types, unittest
from unittest.mock import MagicMock, patch

# ── Set env vars before importing app ─────────────────────────────────────────
os.environ.update({
    'DATABASE_URL':       'postgresql://x:x@localhost/x',
    'SECRET_KEY':         'test-secret',
    'B2_KEY_ID':          'testkey',
    'B2_APPLICATION_KEY': 'testsecret',
    'B2_BUCKET':          'testbucket',
    'B2_ENDPOINT_URL':    'https://s3.us-west-004.backblazeb2.com',
})

# ── Stub heavy dependencies so app.py imports cleanly ────────────────────────

# flask_login: LoginManager must be a real class so @login_manager.user_loader
# works as a decorator (MagicMock(app) creates a spec-restricted mock that
# would reject .user_loader because Flask app doesn't have that attribute).
class _FakeLoginManager:
    def __init__(self, *a, **kw): pass
    def init_app(self, *a, **kw): pass
    def user_loader(self, f): return f   # passthrough decorator

_fl = types.ModuleType('flask_login')
_fl.LoginManager   = _FakeLoginManager
_fl.UserMixin      = object             # must be a real class (used as base)
_fl.login_user     = MagicMock()
_fl.logout_user    = MagicMock()
_fl.current_user   = MagicMock()
_fl.login_required = lambda f: f
sys.modules['flask_login'] = _fl

# psycopg2: return mock connection/cursor so init_db() doesn't crash
_cur = MagicMock()
_cur.fetchone.return_value  = None
_cur.fetchall.return_value  = []
_conn = MagicMock()
_conn.cursor.return_value   = _cur
_pg           = types.ModuleType('psycopg2')
_pg.connect   = MagicMock(return_value=_conn)
_pg.pool      = types.ModuleType('psycopg2.pool')
_pg.pool.ThreadedConnectionPool = MagicMock(
    return_value=MagicMock(getconn=MagicMock(return_value=_conn))
)
_pg.extras                  = types.ModuleType('psycopg2.extras')
_pg.extras.RealDictCursor   = dict
sys.modules['psycopg2']         = _pg
sys.modules['psycopg2.pool']    = _pg.pool
sys.modules['psycopg2.extras']  = _pg.extras

# boto3: S3 client is created at import time
sys.modules['boto3'] = MagicMock()

# cloudinary: cloudinary.config() is called at import time
_cloudinary = MagicMock()
sys.modules['cloudinary'] = _cloudinary
sys.modules['cloudinary.uploader'] = _cloudinary.uploader
sys.modules['cloudinary.api'] = _cloudinary.api

# authlib: OAuth is instantiated at import time
sys.modules['authlib']                              = MagicMock()
sys.modules['authlib.integrations']                 = MagicMock()
sys.modules['authlib.integrations.flask_client']    = MagicMock()

# ── Import the app module ─────────────────────────────────────────────────────
import app as _app   # noqa: E402  (must be after the sys.modules stubs above)


# ─────────────────────────────────────────────────────────────────────────────
# 1. Constants
# ─────────────────────────────────────────────────────────────────────────────
class TestConstants(unittest.TestCase):

    def test_body_parts_list_exact(self):
        expected = ['boobs', 'pussy', 'butt', 'face', 'legs',
                    'belly', 'abs', 'chest', 'penis', 'feet']
        self.assertEqual(_app.BODY_PARTS, expected)

    def test_body_parts_all_lowercase_strings(self):
        for part in _app.BODY_PARTS:
            self.assertIsInstance(part, str)
            self.assertEqual(part, part.lower(), f'{part!r} is not lowercase')

    def test_valid_ratings_set(self):
        self.assertEqual(_app.VALID_RATINGS, {'h', 'c', 'sn', 'n', 'x'})

    def test_cc_keyword_map_default_keys_are_body_parts_or_subset(self):
        """All CC keyword-map categories should be known body parts."""
        for cat in _app.CC_CATEGORY_KEYWORDS_DEFAULT:
            self.assertIn(cat, _app.BODY_PARTS, f'Unknown CC category: {cat!r}')

    def test_cc_keyword_map_gay_keys_are_body_parts_or_subset(self):
        for cat in _app.CC_CATEGORY_KEYWORDS_GAY:
            self.assertIn(cat, _app.BODY_PARTS, f'Unknown CC gay category: {cat!r}')


# ─────────────────────────────────────────────────────────────────────────────
# 2. _safe_collection_name
# ─────────────────────────────────────────────────────────────────────────────
class TestSafeCollectionName(unittest.TestCase):

    def test_valid_names_pass_through(self):
        for name in ['girls', 'My-Collection', 'col_123', 'ABC', 'a1']:
            self.assertEqual(_app._safe_collection_name(name), name)

    def test_rejects_spaces(self):
        self.assertEqual(_app._safe_collection_name('has space'), '')

    def test_rejects_slashes(self):
        self.assertEqual(_app._safe_collection_name('a/b'), '')

    def test_rejects_dots(self):
        self.assertEqual(_app._safe_collection_name('../etc'), '')

    def test_rejects_semicolons(self):
        self.assertEqual(_app._safe_collection_name('a;b'), '')

    def test_empty_string(self):
        self.assertEqual(_app._safe_collection_name(''), '')


# ─────────────────────────────────────────────────────────────────────────────
# 3. _normalize_tags_entry
# ─────────────────────────────────────────────────────────────────────────────
class TestNormalizeTagsEntry(unittest.TestCase):

    def test_list_input_becomes_tags(self):
        out = _app._normalize_tags_entry(['boobs', 'n'])
        self.assertEqual(out['tags'], ['boobs', 'n'])
        self.assertEqual(out['body_parts'], {})
        self.assertFalse(out['locked'])

    def test_dict_with_tags_and_body_parts(self):
        entry = {'tags': ['solo'], 'body_parts': {'boobs': 'n', 'face': 'sn'}, 'locked': True}
        out = _app._normalize_tags_entry(entry)
        self.assertEqual(out['tags'], ['solo'])
        self.assertEqual(out['body_parts'], {'boobs': 'n', 'face': 'sn'})
        self.assertTrue(out['locked'])

    def test_dict_without_body_parts_defaults_to_empty(self):
        out = _app._normalize_tags_entry({'tags': ['outdoor'], 'locked': False})
        self.assertEqual(out['body_parts'], {})

    def test_none_returns_empty(self):
        out = _app._normalize_tags_entry(None)
        self.assertEqual(out['tags'], [])
        self.assertEqual(out['body_parts'], {})

    def test_empty_dict_returns_empty(self):
        out = _app._normalize_tags_entry({})
        self.assertEqual(out['tags'], [])
        self.assertEqual(out['body_parts'], {})


# ─────────────────────────────────────────────────────────────────────────────
# 4. _tags_match  (flexible fuzzy matching used by the CC keyword path)
# ─────────────────────────────────────────────────────────────────────────────
class TestTagsMatch(unittest.TestCase):

    def test_exact_match(self):
        self.assertTrue(_app._tags_match('boobs', 'boobs'))

    def test_underscore_treated_as_space(self):
        self.assertTrue(_app._tags_match('big_boobs', 'big boobs'))

    def test_hyphen_treated_as_space(self):
        self.assertTrue(_app._tags_match('big-boobs', 'big boobs'))

    def test_case_insensitive(self):
        self.assertTrue(_app._tags_match('Boobs', 'boobs'))

    def test_substring_match(self):
        self.assertTrue(_app._tags_match('big boobs', 'boobs'))

    def test_no_match(self):
        self.assertFalse(_app._tags_match('legs', 'boobs'))
        self.assertFalse(_app._tags_match('solo', 'pussy'))


# ─────────────────────────────────────────────────────────────────────────────
# 5. _cc_categorize_tags  (legacy keyword-matching path)
# ─────────────────────────────────────────────────────────────────────────────
class TestCcCategorizeTags(unittest.TestCase):
    KM = _app.CC_CATEGORY_KEYWORDS_DEFAULT

    def test_exact_keywords_matched(self):
        out = self._run(['boobs', 'pussy', 'n'])
        self.assertIn('boobs', out)
        self.assertIn('pussy', out)

    def test_synonyms_matched(self):
        out = self._run(['tits', 'ass', 'c'])
        self.assertIn('boobs', out)
        self.assertIn('butt', out)

    def test_new_categories_matched(self):
        out = self._run(['face', 'legs'])
        self.assertIn('face', out)
        self.assertIn('legs', out)

    def test_unrelated_tags_not_matched(self):
        out = self._run(['solo', 'outdoor', 'portrait'])
        self.assertEqual(out, {})

    def test_only_first_matching_tag_per_category(self):
        # 'boobs' and 'tits' both map to 'boobs'; only one entry expected
        out = self._run(['boobs', 'tits'])
        self.assertEqual(len([k for k in out if k == 'boobs']), 1)

    def _run(self, tags):
        return _app._cc_categorize_tags(tags, self.KM)


# ─────────────────────────────────────────────────────────────────────────────
# 6. Body-parts validation  (the filtering logic in api_update_body_parts)
# ─────────────────────────────────────────────────────────────────────────────
class TestBodyPartsValidation(unittest.TestCase):

    def _clean(self, raw):
        return {k: v for k, v in raw.items()
                if k in _app.BODY_PARTS and v in _app.VALID_RATINGS}

    def test_valid_parts_pass_through_unchanged(self):
        raw = {'boobs': 'n', 'face': 'sn', 'butt': 'x'}
        self.assertEqual(self._clean(raw), raw)

    def test_unknown_body_part_stripped(self):
        raw = {'boobs': 'n', 'hair': 'n', 'wings': 'c'}
        self.assertEqual(self._clean(raw), {'boobs': 'n'})

    def test_invalid_rating_stripped(self):
        raw = {'boobs': 'nude', 'face': 'explicit', 'legs': 'n'}
        self.assertEqual(self._clean(raw), {'legs': 'n'})

    def test_empty_dict_stays_empty(self):
        self.assertEqual(self._clean({}), {})

    def test_all_defined_body_parts_accepted(self):
        raw = {part: 'n' for part in _app.BODY_PARTS}
        self.assertEqual(self._clean(raw), raw)

    def test_all_valid_ratings_accepted(self):
        for rating in _app.VALID_RATINGS:  # h, c, sn, n, x
            self.assertEqual(self._clean({'boobs': rating}), {'boobs': rating})

    def test_empty_rating_string_rejected(self):
        self.assertEqual(self._clean({'boobs': ''}), {})

    def test_mixed_valid_and_invalid(self):
        raw = {'boobs': 'n', 'pussy': 'badval', 'face': 'sn', 'fakePart': 'x'}
        self.assertEqual(self._clean(raw), {'boobs': 'n', 'face': 'sn'})


# ─────────────────────────────────────────────────────────────────────────────
# 7. _cc_collection_images  (new body_parts path + legacy fallback)
# ─────────────────────────────────────────────────────────────────────────────
class TestCcCollectionImages(unittest.TestCase):
    KM = _app.CC_CATEGORY_KEYWORDS_DEFAULT

    def _fake_tags_data(self, specs):
        """Build a fake _load_tags() result for collection 'col'.
        specs: list of (body_parts_dict, flat_tags_list).
        """
        data = {}
        for i, (bp, tags) in enumerate(specs):
            data[f'col/{i}.jpg'] = {
                'url':        f'col/{i}.jpg',
                'tags':       tags,
                'body_parts': bp,
                'locked':     False,
            }
        return data

    @patch.object(_app, '_load_tags')
    def test_two_matching_parts_eligible(self, mock_load):
        mock_load.return_value = self._fake_tags_data([
            ({'boobs': 'n', 'pussy': 'x'}, []),
        ])
        result = _app._cc_collection_images('col', self.KM)
        self.assertEqual(len(result), 1)

    @patch.object(_app, '_load_tags')
    def test_one_matching_part_not_eligible(self, mock_load):
        mock_load.return_value = self._fake_tags_data([
            ({'boobs': 'n'}, []),
        ])
        result = _app._cc_collection_images('col', self.KM)
        self.assertEqual(len(result), 0)

    @patch.object(_app, '_load_tags')
    def test_options_keys_match_body_part_names(self, mock_load):
        mock_load.return_value = self._fake_tags_data([
            ({'boobs': 'n', 'butt': 'sn', 'face': 'c'}, []),
        ])
        result = _app._cc_collection_images('col', self.KM)
        self.assertSetEqual(set(result[0]['options'].keys()), {'boobs', 'butt', 'face'})

    @patch.object(_app, '_load_tags')
    def test_body_part_not_in_keyword_map_excluded_from_options(self, mock_load):
        # 'chest' is in CC_CATEGORY_KEYWORDS_GAY but not DEFAULT — should be ignored
        mock_load.return_value = self._fake_tags_data([
            ({'boobs': 'n', 'chest': 'sn'}, []),   # only 1 valid for DEFAULT map
        ])
        result = _app._cc_collection_images('col', self.KM)
        self.assertEqual(len(result), 0)

    @patch.object(_app, '_load_tags')
    def test_legacy_flat_tags_fallback_when_no_body_parts(self, mock_load):
        mock_load.return_value = self._fake_tags_data([
            ({}, ['boobs', 'pussy', 'n']),
        ])
        result = _app._cc_collection_images('col', self.KM)
        self.assertEqual(len(result), 1)
        self.assertIn('boobs', result[0]['options'])
        self.assertIn('pussy', result[0]['options'])

    @patch.object(_app, '_load_tags')
    def test_empty_body_parts_and_no_tags_not_eligible(self, mock_load):
        mock_load.return_value = self._fake_tags_data([
            ({}, []),
        ])
        result = _app._cc_collection_images('col', self.KM)
        self.assertEqual(len(result), 0)

    @patch.object(_app, '_load_tags')
    def test_mixed_new_and_legacy_images(self, mock_load):
        mock_load.return_value = self._fake_tags_data([
            ({'boobs': 'n', 'face': 'sn'}, []),          # new format — eligible
            ({}, ['boobs', 'butt', 'sn']),                 # legacy — eligible
            ({'legs': 'c'}, []),                           # new format, 1 part only — not eligible
        ])
        result = _app._cc_collection_images('col', self.KM)
        self.assertEqual(len(result), 2)

    @patch.object(_app, '_load_tags')
    def test_url_passed_through_unchanged(self, mock_load):
        mock_load.return_value = self._fake_tags_data([
            ({'boobs': 'n', 'butt': 'sn'}, []),
        ])
        result = _app._cc_collection_images('col', self.KM)
        self.assertEqual(result[0]['url'], 'col/0.jpg')


# ─────────────────────────────────────────────────────────────────────────────
# 8. Image storage: Cloudinary primary + B2 backup, soft-delete
# ─────────────────────────────────────────────────────────────────────────────
class TestImageStorageHelpers(unittest.TestCase):

    def setUp(self):
        _cur.reset_mock()
        _cur.fetchone.return_value = None
        _cur.fetchall.return_value = []
        _cloudinary.reset_mock()

    def test_db_insert_image_passes_b2_backup_key(self):
        _app._db_insert_image('col', 'file.jpg', 'https://res.cloudinary.com/x/col/file',
                               user_id=1, b2_backup_key='col/file.jpg')
        sql, params = _cur.execute.call_args.args
        self.assertIn('b2_backup_key', sql)
        self.assertIn('col/file.jpg', params)

    def test_db_insert_image_defaults_backup_key_to_none(self):
        _app._db_insert_image('col', 'file.jpg', 'https://res.cloudinary.com/x/col/file')
        _, params = _cur.execute.call_args.args
        self.assertIsNone(params[-1])

    def test_db_soft_delete_image_updates_not_deletes(self):
        _app._db_soft_delete_image('col', 'file.jpg')
        sql, params = _cur.execute.call_args.args
        self.assertIn('UPDATE images', sql)
        self.assertIn('deleted_at', sql)
        self.assertNotIn('DELETE FROM images', sql)

    def test_load_tags_excludes_soft_deleted(self):
        _app._load_tags()
        sql = _cur.execute.call_args.args[0]
        self.assertIn('deleted_at IS NULL', sql)

    def test_find_image_collection_returns_collection(self):
        _cur.fetchone.return_value = ('mycoll',)
        self.assertEqual(_app._find_image_collection('abc.jpg'), 'mycoll')

    def test_find_image_collection_returns_none_when_missing(self):
        _cur.fetchone.return_value = None
        self.assertIsNone(_app._find_image_collection('missing.jpg'))

    def test_cloudinary_upload_uses_image_resource_type_and_given_public_id(self):
        _cloudinary.uploader.upload.return_value = {'secure_url': 'https://res.cloudinary.com/x/col/abc'}
        url = _app._cloudinary_upload(b'filedata', 'col/abc')
        _, kwargs = _cloudinary.uploader.upload.call_args
        self.assertEqual(kwargs.get('resource_type'), 'image')
        self.assertEqual(kwargs.get('public_id'), 'col/abc')
        self.assertEqual(url, 'https://res.cloudinary.com/x/col/abc')

    def test_cloudinary_delete_calls_destroy_with_image_resource_type(self):
        _app._cloudinary_delete('col/abc')
        _cloudinary.uploader.destroy.assert_called_with('col/abc', resource_type='image')

    def test_cloudinary_rename_returns_new_secure_url(self):
        _cloudinary.uploader.rename.return_value = {'secure_url': 'https://res.cloudinary.com/x/newcol/abc'}
        url = _app._cloudinary_rename('col/abc', 'newcol/abc')
        _cloudinary.uploader.rename.assert_called_with('col/abc', 'newcol/abc', resource_type='image')
        self.assertEqual(url, 'https://res.cloudinary.com/x/newcol/abc')


# ─────────────────────────────────────────────────────────────────────────────
# Image health admin pages: untagged / unknown-subject / orphaned / missing-B2-backup
# ─────────────────────────────────────────────────────────────────────────────
class TestImageHealthRoutes(unittest.TestCase):

    def setUp(self):
        _cur.reset_mock()
        _cur.fetchone.return_value = None
        _cur.fetchall.return_value = []
        self.client = _app.app.test_client()

    def test_untagged_images_query_requires_all_body_parts_present(self):
        """'Untagged' means missing a rating for at least one BODY_PARTS entry —
        checked via jsonb '?&' against every configured body part, not the
        free-text tags array."""
        _cur.fetchall.return_value = [{
            'id': 1, 'collection_name': 'col', 'filename': 'a.jpg',
            'url': 'https://res.cloudinary.com/x/col/a.jpg', 'tags': ['x'], 'body_parts': {'boobs': 'n'},
            'created_at': None, 'uploader_username': None, 'uploader_email': None,
        }]
        resp = self.client.get('/admin/untagged-images')
        self.assertEqual(resp.status_code, 200)
        sql, params = _cur.execute.call_args.args
        self.assertIn('deleted_at IS NULL', sql)
        self.assertIn('?&', sql)
        self.assertIn('body_parts', sql)
        self.assertEqual(params, (_app.BODY_PARTS,))

    def test_unknown_subject_images_query_filters_no_image_models(self):
        _cur.fetchall.return_value = [{
            'id': 1, 'collection_name': 'col', 'filename': 'a.jpg',
            'url': 'https://res.cloudinary.com/x/col/a.jpg', 'created_at': None,
            'uploader_username': None, 'uploader_email': None,
        }]
        resp = self.client.get('/admin/unknown-subject-images')
        self.assertEqual(resp.status_code, 200)
        sql = _cur.execute.call_args.args[0]
        self.assertIn('deleted_at IS NULL', sql)
        self.assertIn('NOT EXISTS', sql)
        self.assertIn('image_models', sql)

    def test_missing_backup_images_query_filters_null_backup_key(self):
        resp = self.client.get('/admin/missing-backup-images')
        self.assertEqual(resp.status_code, 200)
        sql = _cur.execute.call_args.args[0]
        self.assertIn('b2_backup_key IS NULL', sql)
        self.assertIn('deleted_at IS NULL', sql)

    def test_retry_backup_404_when_image_missing(self):
        _cur.fetchone.return_value = None
        resp = self.client.post('/api/admin/images/999/retry-backup')
        self.assertEqual(resp.status_code, 404)

    def test_retry_backup_rejects_when_already_deleted(self):
        _cur.fetchone.return_value = ('col', 'a.jpg', 'https://res.cloudinary.com/x/col/a.jpg', None, '2026-01-01')
        resp = self.client.post('/api/admin/images/1/retry-backup')
        self.assertEqual(resp.status_code, 400)
        self.assertFalse(resp.get_json()['success'])

    def test_retry_backup_rejects_when_backup_already_exists(self):
        _cur.fetchone.return_value = ('col', 'a.jpg', 'https://res.cloudinary.com/x/col/a.jpg', 'col/a.jpg', None)
        resp = self.client.post('/api/admin/images/1/retry-backup')
        self.assertEqual(resp.status_code, 400)
        self.assertFalse(resp.get_json()['success'])

    @patch.object(_app, '_http')
    @patch.object(_app, '_b2_upload_fileobj')
    def test_retry_backup_success_sets_backup_key(self, mock_upload, mock_http):
        _cur.fetchone.return_value = ('col', 'a.jpg', 'https://res.cloudinary.com/x/col/a.jpg', None, None)
        mock_resp = MagicMock(content=b'filedata', headers={'Content-Type': 'image/jpeg'})
        mock_http.get.return_value = mock_resp
        resp = self.client.post('/api/admin/images/1/retry-backup')
        data = resp.get_json()
        self.assertTrue(data['success'])
        self.assertEqual(data['b2_backup_key'], 'col/a.jpg')
        mock_upload.assert_called_once()
        sql = _cur.execute.call_args_list[-1].args[0]
        self.assertIn('UPDATE images', sql)
        self.assertIn('b2_backup_key', sql)

    @patch.object(_app, '_http')
    def test_retry_backup_failure_reports_error(self, mock_http):
        _cur.fetchone.return_value = ('col', 'a.jpg', 'https://res.cloudinary.com/x/col/a.jpg', None, None)
        mock_http.get.side_effect = Exception('network down')
        resp = self.client.post('/api/admin/images/1/retry-backup')
        self.assertEqual(resp.status_code, 500)
        self.assertFalse(resp.get_json()['success'])


# ─────────────────────────────────────────────────────────────────────────────
# Admin: AI-quote batch generation (dashboard lists collections + counts,
# detail page lists one collection's images + quote status; the actual chat
# call always happens client-side, so these routes only ever read/list).
# ─────────────────────────────────────────────────────────────────────────────
class TestAiQuoteBatchRoutes(unittest.TestCase):

    def setUp(self):
        _cur.reset_mock()
        _cur.fetchone.return_value = None
        _cur.fetchall.return_value = []
        _cur.fetchall.side_effect = None  # defensive: clear any leaked side_effect iterator
        self.client = _app.app.test_client()

    def tearDown(self):
        # This class is the only one that sets fetchall.side_effect (a one-shot
        # iterator) — must clear it so it doesn't leak into later tests/classes
        # that rely on fetchall.return_value instead.
        _cur.fetchall.side_effect = None

    def test_dashboard_merges_counts_with_zero_image_collections(self):
        _cur.fetchall.side_effect = [
            [('GayReal', 10, 7)],           # GROUP BY counts query
            [('GayReal',), ('EmptyOne',)],   # _load_collections()
        ]
        resp = self.client.get('/admin/ai-quotes')
        self.assertEqual(resp.status_code, 200)
        body = resp.get_data(as_text=True)
        self.assertIn('GayReal', body)
        self.assertIn('EmptyOne', body)

    def test_collection_detail_404_when_collection_missing(self):
        _cur.fetchone.return_value = None  # _collection_exists() -> False
        resp = self.client.get('/admin/ai-quotes/NoSuchCollection')
        self.assertEqual(resp.status_code, 404)

    def test_collection_detail_query_scoped_to_collection_and_active_rows(self):
        _cur.fetchone.return_value = ('GayReal',)  # _collection_exists() -> True
        _cur.fetchall.return_value = [{
            'filename': 'a.jpg', 'url': 'https://res.cloudinary.com/x/GayReal/a.jpg',
            'tags': ['beach'], 'ai_quote': None,
        }]
        resp = self.client.get('/admin/ai-quotes/GayReal')
        self.assertEqual(resp.status_code, 200)
        sql, params = _cur.execute.call_args.args
        self.assertIn('collection_name = %s', sql)
        self.assertIn('deleted_at IS NULL', sql)
        self.assertEqual(params, ('GayReal',))


# ─────────────────────────────────────────────────────────────────────────────
# Per-user image tag blocking: pure-logic helpers, enforcement, the blurred
# proxy, guest-login removal, and the admin Content Blocks API.
# ─────────────────────────────────────────────────────────────────────────────
class TestContentBlockHelpers(unittest.TestCase):

    def setUp(self):
        _cur.reset_mock()
        _cur.fetchone.return_value = None
        _cur.fetchall.return_value = []
        _cur.fetchall.side_effect = None

    def test_visible_when_no_blocks(self):
        self.assertTrue(_app._image_visible_to_user({'face': 'n'}, set()))

    def test_hidden_when_matching_pair_blocked(self):
        self.assertFalse(_app._image_visible_to_user({'face': 'n'}, {('face', 'n')}))

    def test_or_logic_across_multiple_blocks(self):
        blocked = {('face', 'n'), ('penis', 'n')}
        self.assertFalse(_app._image_visible_to_user({'boobs': 'c', 'penis': 'n'}, blocked))
        self.assertTrue(_app._image_visible_to_user({'boobs': 'c', 'legs': 'sn'}, blocked))

    def test_visible_when_image_has_no_body_parts(self):
        self.assertTrue(_app._image_visible_to_user({}, {('face', 'n')}))

    def test_effective_blocked_pairs_admin_bypass(self):
        admin = MagicMock(is_authenticated=True, is_admin=True, id=1)
        self.assertEqual(_app._effective_blocked_pairs(admin, 'col'), set())
        _cur.execute.assert_not_called()

    def test_effective_blocked_pairs_unauthenticated_bypass(self):
        anon = MagicMock(is_authenticated=False)
        self.assertEqual(_app._effective_blocked_pairs(anon, 'col'), set())
        _cur.execute.assert_not_called()

    def test_effective_blocked_pairs_queries_for_regular_user(self):
        user = MagicMock(is_authenticated=True, is_admin=False, id=5)
        _cur.fetchall.return_value = [('face', 'n'), ('penis', 'n')]
        result = _app._effective_blocked_pairs(user, 'col')
        self.assertEqual(result, {('face', 'n'), ('penis', 'n')})

    def test_union_blocked_pairs_combines_multiple_users(self):
        _cur.fetchall.side_effect = [[('face', 'n')], [('penis', 'n')]]
        result = _app._union_blocked_pairs([1, 2], 'col')
        self.assertEqual(result, {('face', 'n'), ('penis', 'n')})

    def test_union_blocked_pairs_skips_falsy_user_ids(self):
        _cur.fetchall.return_value = [('face', 'n')]
        result = _app._union_blocked_pairs([None, 1], 'col')
        self.assertEqual(result, {('face', 'n')})


class TestContentBlockFiltering(unittest.TestCase):
    """api_collection_images is the single highest-leverage enforcement point —
    ~20+ minigames all fetch through this one endpoint."""

    def setUp(self):
        self.client = _app.app.test_client()

    @patch.object(_app, '_effective_blocked_pairs')
    @patch.object(_app, '_get_collection_image_model_map', return_value={})
    @patch.object(_app, '_collection_exists', return_value=True)
    @patch.object(_app, '_load_tags')
    @patch.object(_app, 'current_user')
    def test_blocked_image_excluded(self, mock_user, mock_load_tags, mock_exists, mock_map, mock_blocked):
        mock_user.is_authenticated = True
        mock_user.is_admin = False
        mock_load_tags.return_value = {
            'col/blocked.jpg': {'url': 'https://res.cloudinary.com/x/col/blocked.jpg', 'tags': [], 'body_parts': {'face': 'n'}},
            'col/safe.jpg':    {'url': 'https://res.cloudinary.com/x/col/safe.jpg',    'tags': [], 'body_parts': {'face': 'c'}},
        }
        mock_blocked.return_value = {('face', 'n')}
        resp = self.client.get('/api/collections/col/images')
        filenames = [img['filename'] for img in resp.get_json()['images']]
        self.assertIn('safe.jpg', filenames)
        self.assertNotIn('blocked.jpg', filenames)

    @patch.object(_app, '_get_collection_image_model_map', return_value={})
    @patch.object(_app, '_collection_exists', return_value=True)
    @patch.object(_app, '_load_tags')
    @patch.object(_app, 'current_user')
    def test_admin_sees_everything(self, mock_user, mock_load_tags, mock_exists, mock_map):
        mock_user.is_authenticated = True
        mock_user.is_admin = True
        mock_load_tags.return_value = {
            'col/a.jpg': {'url': 'https://res.cloudinary.com/x/col/a.jpg', 'tags': [], 'body_parts': {'face': 'n'}},
        }
        resp = self.client.get('/api/collections/col/images')
        self.assertEqual(len(resp.get_json()['images']), 1)


class TestImageProxy(unittest.TestCase):

    def setUp(self):
        _app._blur_cache.clear()
        _cur.reset_mock()
        _cur.fetchone.return_value = None
        self.client = _app.app.test_client()

    @patch.object(_app, '_effective_blocked_pairs', return_value=set())
    @patch.object(_app, 'current_user')
    def test_unblocked_redirects_without_fetching(self, mock_user, mock_blocked):
        mock_user.is_authenticated = True
        mock_user.is_admin = False
        _cur.fetchone.return_value = ('https://res.cloudinary.com/x/col/a.jpg', {'face': 'c'})
        resp = self.client.get('/img/col/a.jpg', follow_redirects=False)
        self.assertEqual(resp.status_code, 302)
        self.assertEqual(resp.headers['Location'], 'https://res.cloudinary.com/x/col/a.jpg')

    @patch.object(_app, '_http')
    @patch.object(_app, '_effective_blocked_pairs', return_value={('face', 'n')})
    @patch.object(_app, 'current_user')
    def test_blocked_blurs_and_caches_second_request(self, mock_user, mock_blocked, mock_http):
        mock_user.is_authenticated = True
        mock_user.is_admin = False
        _cur.fetchone.return_value = ('https://res.cloudinary.com/x/col/a.jpg', {'face': 'n'})

        from PIL import Image
        buf = io.BytesIO()
        Image.new('RGB', (10, 10), color='red').save(buf, format='JPEG')
        mock_http.get.return_value = MagicMock(content=buf.getvalue())

        resp = self.client.get('/img/col/a.jpg')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.mimetype, 'image/jpeg')
        self.assertEqual(mock_http.get.call_count, 1)

        resp2 = self.client.get('/img/col/a.jpg')
        self.assertEqual(resp2.status_code, 200)
        self.assertEqual(mock_http.get.call_count, 1)  # cached — no second fetch

    def test_missing_image_404s(self):
        _cur.fetchone.return_value = None
        resp = self.client.get('/img/col/nosuch.jpg')
        self.assertEqual(resp.status_code, 404)


class TestGuestRemoval(unittest.TestCase):

    def setUp(self):
        self.client = _app.app.test_client()

    def test_guest_route_removed(self):
        resp = self.client.post('/api/auth/guest')
        self.assertEqual(resp.status_code, 404)

    @patch.object(_app, 'current_user')
    def test_auth_me_unauthenticated_has_no_guest_key(self, mock_user):
        mock_user.is_authenticated = False
        resp = self.client.get('/api/auth/me')
        data = resp.get_json()
        self.assertFalse(data['authenticated'])
        self.assertNotIn('is_guest', data)

    @patch.object(_app, 'current_user')
    def test_submit_score_requires_auth(self, mock_user):
        mock_user.is_authenticated = False
        resp = self.client.post('/api/submit-score', json={'collection': 'col'})
        self.assertEqual(resp.status_code, 401)


class TestAdminContentBlocksApi(unittest.TestCase):

    def setUp(self):
        _cur.reset_mock()
        _cur.fetchone.return_value = None
        _cur.fetchall.return_value = []
        _cur.fetchall.side_effect = None
        self.client = _app.app.test_client()

    @patch.object(_app, '_collection_exists', return_value=True)
    def test_grant_content_block(self, mock_exists):
        resp = self.client.post('/api/admin/user/1/content-blocks', json={
            'collection': 'col', 'body_part': 'face', 'rating': 'n', 'grant': True
        })
        data = resp.get_json()
        self.assertTrue(data['success'])
        self.assertTrue(data['granted'])
        sql = _cur.execute.call_args.args[0]
        self.assertIn('INSERT INTO image_tag_blocks', sql)

    @patch.object(_app, '_collection_exists', return_value=True)
    def test_revoke_content_block(self, mock_exists):
        resp = self.client.post('/api/admin/user/1/content-blocks', json={
            'collection': 'col', 'body_part': 'face', 'rating': 'n', 'grant': False
        })
        data = resp.get_json()
        self.assertTrue(data['success'])
        self.assertFalse(data['granted'])
        sql = _cur.execute.call_args.args[0]
        self.assertIn('DELETE FROM image_tag_blocks', sql)

    @patch.object(_app, '_collection_exists', return_value=False)
    def test_grant_rejects_unknown_collection(self, mock_exists):
        resp = self.client.post('/api/admin/user/1/content-blocks', json={
            'collection': 'nosuch', 'body_part': 'face', 'rating': 'n', 'grant': True
        })
        self.assertEqual(resp.status_code, 400)

    @patch.object(_app, '_collection_exists', return_value=False)
    def test_get_pairs_404s_for_unknown_collection(self, mock_exists):
        resp = self.client.get('/api/admin/user/1/content-blocks/nosuch')
        self.assertEqual(resp.status_code, 404)

    @patch.object(_app, '_user_blocked_pairs', return_value={('face', 'n')})
    @patch.object(_app, '_collection_body_part_pairs_with_counts', return_value=[('face', 'n', 3), ('boobs', 'c', 5)])
    @patch.object(_app, '_collection_exists', return_value=True)
    def test_get_pairs_reports_blocked_flag(self, mock_exists, mock_pairs, mock_blocked):
        resp = self.client.get('/api/admin/user/1/content-blocks/col')
        pairs = resp.get_json()['pairs']
        by_part = {(p['part'], p['rating']): p['blocked'] for p in pairs}
        self.assertTrue(by_part[('face', 'n')])
        self.assertFalse(by_part[('boobs', 'c')])


if __name__ == '__main__':
    unittest.main(verbosity=2)
