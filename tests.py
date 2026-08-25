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
# Shared: neutralise the restricted-collection gate for route tests
# ─────────────────────────────────────────────────────────────────────────────
def _stub_no_restrictions(testcase):
    """Pin the restricted-collection lookups to 'nothing is restricted'.

    Route tests drive a single shared cursor mock whose fetchall() returns rows
    shaped for the query under test, so any *extra* query a route makes gets the
    wrong shape back. The restricted-collection gate issues exactly such a query,
    so tests that aren't about restriction stub it out here rather than teaching
    the cursor mock to dispatch on SQL text.
    """
    for name, value in (('_load_restricted_patterns', []),
                        ('_restricted_collections_denied_for_user', set()),
                        ('_restricted_collection_blocked', False)):
        patcher = patch.object(_app, name, return_value=value)
        patcher.start()
        testcase.addCleanup(patcher.stop)


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
    def test_url_resolved_to_fetchable_form(self, mock_load):
        mock_load.return_value = self._fake_tags_data([
            ({'boobs': 'n', 'butt': 'sn'}, []),
        ])
        with patch.object(_app, 'B2_WORKER_URL', 'https://worker.example.workers.dev'):
            result = _app._cc_collection_images('col', self.KM)
        self.assertEqual(result[0]['url'], 'https://worker.example.workers.dev/col/0.jpg')


# ─────────────────────────────────────────────────────────────────────────────
# B2 signed-URL caching — reuse the same signature across calls instead of
# minting a fresh one (and therefore a different URL) on every render, so the
# browser can actually cache the response.
# ─────────────────────────────────────────────────────────────────────────────
class TestB2UrlCaching(unittest.TestCase):

    def setUp(self):
        _app._b2_url_cache.clear()

    def test_worker_url_used_when_configured(self):
        with patch.object(_app, 'B2_WORKER_URL', 'https://worker.example.workers.dev'), \
             patch.object(_app._s3, 'generate_presigned_url') as mock_sign:
            url = _app._b2_sign_url('col/file.mp4')
        self.assertEqual(url, 'https://worker.example.workers.dev/col/file.mp4')
        mock_sign.assert_not_called()  # no signing needed — the Worker authenticates itself

    def test_worker_url_passthrough_falsy_key(self):
        with patch.object(_app, 'B2_WORKER_URL', 'https://worker.example.workers.dev'):
            self.assertEqual(_app._b2_sign_url(''), '')

    def test_reuses_cached_url_within_validity_window(self):
        with patch.object(_app._s3, 'generate_presigned_url', return_value='https://b2.example/signed?sig=abc') as mock_sign:
            url1 = _app._b2_sign_url('col/file.mp4')
            url2 = _app._b2_sign_url('col/file.mp4')
        self.assertEqual(url1, url2)
        mock_sign.assert_called_once()

    def test_regenerates_when_close_to_expiry(self):
        with patch.object(_app._s3, 'generate_presigned_url', return_value='https://b2.example/signed?sig=abc'):
            _app._b2_sign_url('col/file.mp4', expires_in=100)
        url, _ = _app._b2_url_cache['col/file.mp4']
        # Simulate the cached entry being almost expired (within the refresh buffer)
        _app._b2_url_cache['col/file.mp4'] = (url, _app._time.time() + 10)
        with patch.object(_app._s3, 'generate_presigned_url', return_value='https://b2.example/signed?sig=def') as mock_sign:
            new_url = _app._b2_sign_url('col/file.mp4', expires_in=100)
        mock_sign.assert_called_once()
        self.assertEqual(new_url, 'https://b2.example/signed?sig=def')

    def test_passes_response_cache_control_param(self):
        with patch.object(_app._s3, 'generate_presigned_url', return_value='https://b2.example/signed') as mock_sign:
            _app._b2_sign_url('col/file2.mp4', expires_in=3600)
        _, kwargs = mock_sign.call_args
        self.assertIn('ResponseCacheControl', kwargs['Params'])

    def test_falsy_key_passthrough(self):
        self.assertEqual(_app._b2_sign_url(''), '')
        self.assertIsNone(_app._b2_sign_url(None))

    def test_different_keys_cached_independently(self):
        with patch.object(_app._s3, 'generate_presigned_url', side_effect=[
            'https://b2.example/a', 'https://b2.example/b',
        ]) as mock_sign:
            url_a = _app._b2_sign_url('col/a.mp4')
            url_b = _app._b2_sign_url('col/b.mp4')
        self.assertNotEqual(url_a, url_b)
        self.assertEqual(mock_sign.call_count, 2)


# ─────────────────────────────────────────────────────────────────────────────
# 8. Image storage: B2-primary (Cloudinary helpers below are legacy, still used
#    to read out any not-yet-migrated rows during the B2 cutover)
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

    @patch.object(_app, '_cloudinary_delete')
    def test_soft_delete_image_does_not_touch_cloudinary(self, mock_delete):
        _app._soft_delete_image_by_collection_and_filename('col', 'file.jpg')
        mock_delete.assert_not_called()
        sql, params = _cur.execute.call_args.args
        self.assertIn('UPDATE images', sql)
        self.assertIn('deleted_at', sql)


# ─────────────────────────────────────────────────────────────────────────────
# 8b. _resolve_image_url — bridges legacy Cloudinary rows and migrated B2 rows
# ─────────────────────────────────────────────────────────────────────────────
class TestResolveImageUrl(unittest.TestCase):

    def test_falsy_passthrough(self):
        self.assertEqual(_app._resolve_image_url(''), '')
        self.assertIsNone(_app._resolve_image_url(None))

    def test_legacy_http_url_passed_through_unchanged(self):
        url = 'https://res.cloudinary.com/x/col/abc.jpg'
        self.assertEqual(_app._resolve_image_url(url), url)

    def test_bare_key_resolved_via_b2_sign_url(self):
        with patch.object(_app, 'B2_WORKER_URL', 'https://worker.example.workers.dev'):
            result = _app._resolve_image_url('col/abc.jpg')
        self.assertEqual(result, 'https://worker.example.workers.dev/col/abc.jpg')


class TestLoadTagsResolved(unittest.TestCase):

    def setUp(self):
        _cur.reset_mock()
        _cur.fetchone.return_value = None
        _cur.fetchall.return_value = []

    def test_resolves_bare_key_url_leaves_raw_load_tags_untouched(self):
        _cur.fetchall.return_value = [
            ('col', 'a.jpg', 'col/a.jpg', [], False, {}),
        ]
        with patch.object(_app, 'B2_WORKER_URL', 'https://worker.example.workers.dev'):
            resolved = _app._load_tags_resolved()
        self.assertEqual(resolved['col/a.jpg']['url'], 'https://worker.example.workers.dev/col/a.jpg')

        # raw _load_tags() must still return the bare key unresolved — it's
        # read-modify-written straight back to the DB by update_image_tags()
        raw = _app._load_tags()
        self.assertEqual(raw['col/a.jpg']['url'], 'col/a.jpg')

    def test_leaves_legacy_http_url_unchanged(self):
        _cur.fetchall.return_value = [
            ('col', 'a.jpg', 'https://res.cloudinary.com/x/col/a.jpg', [], False, {}),
        ]
        resolved = _app._load_tags_resolved()
        self.assertEqual(resolved['col/a.jpg']['url'], 'https://res.cloudinary.com/x/col/a.jpg')


# ─────────────────────────────────────────────────────────────────────────────
# 8c. Upload route — B2-primary, no Cloudinary write
# ─────────────────────────────────────────────────────────────────────────────
class TestImageUploadRoute(unittest.TestCase):

    def setUp(self):
        _cur.reset_mock()
        _cur.fetchone.return_value = None
        _cur.fetchall.return_value = []
        _cloudinary.reset_mock()
        self.client = _app.app.test_client()

    @patch.object(_app, 'B2_WORKER_URL', 'https://worker.example.workers.dev')
    @patch.object(_app, '_b2_upload_fileobj')
    def test_upload_writes_to_b2_not_cloudinary(self, mock_b2_upload):
        mock_b2_upload.side_effect = lambda fileobj, key, content_type=None: key
        data = {'file': (io.BytesIO(b'fake-image-bytes'), 'test.jpg')}
        resp = self.client.post('/upload/col', data=data, content_type='multipart/form-data')

        self.assertEqual(resp.status_code, 200)
        mock_b2_upload.assert_called_once()
        _cloudinary.uploader.upload.assert_not_called()

        insert_call = next(
            c for c in _cur.execute.call_args_list if 'INSERT INTO images' in c.args[0]
        )
        _, params = insert_call.args
        stored_url = params[2]  # (collection_name, filename, url, ...)
        self.assertTrue(stored_url.startswith('col/'))
        self.assertNotIn('cloudinary', stored_url)


# ─────────────────────────────────────────────────────────────────────────────
# Image health admin pages: untagged / unknown-subject / orphaned / missing-B2-backup
# ─────────────────────────────────────────────────────────────────────────────
class TestImageHealthRoutes(unittest.TestCase):

    def setUp(self):
        _cur.reset_mock()
        _cur.fetchone.return_value = None
        _cur.fetchall.return_value = []
        _stub_no_restrictions(self)
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
        _stub_no_restrictions(self)
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
        _cur.fetchall.return_value = []  # _restricted_collection_blocked() queries patterns via fetchall
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


# ─────────────────────────────────────────────────────────────────────────────
# Restricted-collection hard wall: patterns, access gate, state machine, reconciler
# ─────────────────────────────────────────────────────────────────────────────
class TestIsCollectionRestricted(unittest.TestCase):

    def setUp(self):
        _cur.reset_mock()
        _cur.fetchone.return_value = None
        _cur.fetchall.return_value = []

    def test_no_patterns_never_restricted(self):
        _cur.fetchall.return_value = []
        self.assertFalse(_app._is_collection_restricted('anything'))

    def test_matches_case_insensitively(self):
        _cur.fetchall.return_value = [('Secret',)]
        self.assertTrue(_app._is_collection_restricted('my-secret-vault'))
        self.assertTrue(_app._is_collection_restricted('MY-SECRET-VAULT'))

    def test_no_match_when_pattern_absent(self):
        _cur.fetchall.return_value = [('secret',)]
        self.assertFalse(_app._is_collection_restricted('Real'))

    def test_falsy_collection_name(self):
        self.assertFalse(_app._is_collection_restricted(''))


class TestRestrictedCollectionBlocked(unittest.TestCase):

    def setUp(self):
        _cur.reset_mock()
        _cur.fetchone.return_value = None
        _cur.fetchall.return_value = []

    @patch.object(_app, '_is_collection_restricted', return_value=False)
    def test_not_restricted_never_blocked(self, mock_restricted):
        user = MagicMock(is_authenticated=True, is_admin=False, id=1)
        self.assertFalse(_app._restricted_collection_blocked(user, 'Real'))

    @patch.object(_app, '_is_collection_restricted', return_value=True)
    def test_anonymous_always_blocked(self, mock_restricted):
        anon = MagicMock(is_authenticated=False)
        self.assertTrue(_app._restricted_collection_blocked(anon, 'secret'))

    @patch.object(_app, '_user_has_restricted_collection_access', return_value=False)
    @patch.object(_app, '_is_collection_restricted', return_value=True)
    def test_admin_without_grant_is_blocked_no_bypass(self, mock_restricted, mock_access):
        """Deliberately different from video access — admins get no free pass here."""
        admin = MagicMock(is_authenticated=True, is_admin=True, id=1)
        self.assertTrue(_app._restricted_collection_blocked(admin, 'secret'))

    @patch.object(_app, '_user_has_restricted_collection_access', return_value=True)
    @patch.object(_app, '_is_collection_restricted', return_value=True)
    def test_accepted_access_not_blocked(self, mock_restricted, mock_access):
        user = MagicMock(is_authenticated=True, is_admin=False, id=1)
        self.assertFalse(_app._restricted_collection_blocked(user, 'secret'))


class TestRestrictedCollectionsDeniedForUser(unittest.TestCase):

    def setUp(self):
        _cur.reset_mock()
        _cur.fetchone.return_value = None
        _cur.fetchall.return_value = []

    def test_no_patterns_returns_empty_set(self):
        _cur.fetchall.return_value = []
        user = MagicMock(is_authenticated=True, id=5)
        self.assertEqual(_app._restricted_collections_denied_for_user(user), set())

    @patch.object(_app, '_load_collections', return_value=['secret-vault', 'Real', 'private-stash'])
    def test_anonymous_denied_all_restricted(self, mock_collections):
        _cur.fetchall.return_value = [('secret',), ('private',)]
        anon = MagicMock(is_authenticated=False)
        result = _app._restricted_collections_denied_for_user(anon)
        self.assertEqual(result, {'secret-vault', 'private-stash'})

    @patch.object(_app, '_load_collections', return_value=['secret-vault', 'Real', 'private-stash'])
    def test_user_with_accepted_access_excludes_that_collection(self, mock_collections):
        _cur.fetchall.side_effect = [
            [('secret',), ('private',)],   # _load_restricted_patterns()
            [('secret-vault',)],           # this user's accepted collections
        ]
        user = MagicMock(is_authenticated=True, id=5)
        result = _app._restricted_collections_denied_for_user(user)
        self.assertEqual(result, {'private-stash'})


class TestRestrictedAccessStateMachine(unittest.TestCase):

    def setUp(self):
        _cur.reset_mock()
        _cur.fetchone.return_value = None
        _cur.fetchall.return_value = []
        _cur.rowcount = 1

    def test_request_creates_pending(self):
        self.assertTrue(_app._request_restricted_access('col', 1))
        sql = _cur.execute.call_args.args[0]
        self.assertIn('INSERT INTO restricted_collection_access', sql)

    def test_request_no_ops_when_already_active(self):
        _cur.rowcount = 0
        self.assertFalse(_app._request_restricted_access('col', 1))

    def test_approve_updates_pending_row(self):
        self.assertTrue(_app._approve_restricted_access(42, admin_id=2))
        sql, params = _cur.execute.call_args.args
        self.assertIn("status = 'approved'", sql)
        self.assertIn("user_id != %s", sql)
        self.assertEqual(params, (2, 42, 2))

    def test_approve_fails_when_not_pending_or_self(self):
        _cur.rowcount = 0
        self.assertFalse(_app._approve_restricted_access(42, admin_id=2))

    def test_deny_updates_pending_row(self):
        self.assertTrue(_app._deny_restricted_access(42, admin_id=2))
        sql = _cur.execute.call_args.args[0]
        self.assertIn("status = 'denied'", sql)

    def test_accept_succeeds_inside_window(self):
        self.assertTrue(_app._accept_restricted_access(42, user_id=1))
        sql = _cur.execute.call_args.args[0]
        self.assertIn("status = 'accepted'", sql)
        self.assertIn('BETWEEN accept_window_start AND accept_window_end', sql)

    def test_accept_fails_outside_window(self):
        _cur.rowcount = 0
        self.assertFalse(_app._accept_restricted_access(42, user_id=1))

    def test_revoke_updates_accepted_row(self):
        self.assertTrue(_app._revoke_restricted_access(42, revoked_by=1))
        sql = _cur.execute.call_args.args[0]
        self.assertIn("status = 'revoked'", sql)

    def test_revoke_fails_when_nothing_active(self):
        _cur.rowcount = 0
        self.assertFalse(_app._revoke_restricted_access(42, revoked_by=1))


class TestRestrictedAccessReconciler(unittest.TestCase):

    def setUp(self):
        _cur.reset_mock()
        _cur.fetchone.return_value = None
        _cur.fetchall.return_value = []

    def test_expire_lapsed_updates_approved_past_window(self):
        _app._expire_lapsed_restricted_access()
        sql = _cur.execute.call_args.args[0]
        self.assertIn("status = 'expired'", sql)
        self.assertIn("status = 'approved'", sql)
        self.assertIn('accept_window_end <= NOW()', sql)

    @patch.object(_app.socketio, 'emit')
    def test_sends_reminder_once_per_due_request(self, mock_emit):
        _cur.fetchall.return_value = [(42, 7, 'secret-vault')]
        _app._send_due_restricted_access_reminders()
        mock_emit.assert_called_once_with(
            'access_window_open', {'id': 42, 'collection': 'secret-vault'}, room='user_7'
        )
        update_sql = _cur.execute.call_args.args[0]
        self.assertIn('reminder_sent = TRUE', update_sql)

    @patch.object(_app.socketio, 'emit')
    def test_no_due_requests_no_emit(self, mock_emit):
        _cur.fetchall.return_value = []
        _app._send_due_restricted_access_reminders()
        mock_emit.assert_not_called()


class TestRestrictedCollectionEnforcement(unittest.TestCase):
    """Spot-check the wiring at a couple of the ~15 call sites — the exhaustive
    per-endpoint behavior is already covered by TestRestrictedCollectionBlocked."""

    def setUp(self):
        _cur.reset_mock()
        _cur.fetchone.return_value = None
        _cur.fetchall.return_value = []
        self.client = _app.app.test_client()

    @patch.object(_app, '_restricted_collection_blocked', return_value=True)
    @patch.object(_app, 'current_user')
    def test_collection_view_redirects_when_blocked(self, mock_user, mock_blocked):
        mock_user.is_authenticated = True
        mock_user.is_admin = False
        resp = self.client.get('/collection/secret', follow_redirects=False)
        self.assertEqual(resp.status_code, 302)
        self.assertIn('/restricted/secret', resp.headers['Location'])

    @patch.object(_app, '_restricted_collection_blocked', return_value=True)
    @patch.object(_app, '_collection_exists', return_value=True)
    @patch.object(_app, 'current_user')
    def test_api_collection_images_403s_when_blocked(self, mock_user, mock_exists, mock_blocked):
        mock_user.is_authenticated = True
        mock_user.is_admin = False
        resp = self.client.get('/api/collections/secret/images')
        self.assertEqual(resp.status_code, 403)
        self.assertTrue(resp.get_json()['restricted'])

    @patch.object(_app, '_restricted_collections_denied_for_user', return_value={'secret'})
    @patch.object(_app, '_effective_blocked_pairs_by_collection', return_value={})
    @patch.object(_app, '_load_tags_resolved')
    @patch.object(_app, 'current_user')
    def test_search_by_tag_excludes_restricted_collection(self, mock_user, mock_load, mock_blocked_by_coll, mock_denied):
        mock_user.is_authenticated = True
        mock_user.is_admin = False
        mock_load.return_value = {
            'secret/a.jpg': {'url': 'u1', 'tags': ['face'], 'body_parts': {}},
            'Real/b.jpg':   {'url': 'u2', 'tags': ['face'], 'body_parts': {}},
        }
        resp = self.client.get('/api/search-by-tag?tag=face')
        keys = [img['key'] for img in resp.get_json()['images']]
        self.assertNotIn('secret/a.jpg', keys)
        self.assertIn('Real/b.jpg', keys)


if __name__ == '__main__':
    unittest.main(verbosity=2)


# ─────────────────────────────────────────────────────────────────────────────
# Restricted collections + the global auth wall
# ─────────────────────────────────────────────────────────────────────────────
class _Anon:
    """Stand-in for flask_login's AnonymousUser (the module-level current_user
    mock in this harness is authenticated for every other test)."""
    is_authenticated = False
    is_admin = False
    id = None


class TestGlobalAuthWall(unittest.TestCase):
    """Auth is deny-by-default: only _PUBLIC_ENDPOINTS may be reached signed-out.
    Regression guard for /api/collections, /api/images and /api/tags, which each
    returned every image's permanent CDN url to anonymous callers."""

    def setUp(self):
        _cur.reset_mock()
        _cur.fetchone.return_value = None
        _cur.fetchall.return_value = []
        self.client = _app.app.test_client()
        patcher = patch.object(_app, 'current_user', _Anon())
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_image_serving_apis_reject_anonymous(self):
        for path in ('/api/collections', '/api/images', '/api/tags',
                     '/api/tags-with-counts', '/api/body-parts-with-counts'):
            with self.subTest(path=path):
                resp = self.client.get(path)
                self.assertEqual(resp.status_code, 401)
                self.assertNotIn(b'cloudinary', resp.data)

    def test_anonymous_page_load_redirects_to_login(self):
        resp = self.client.get('/manage-collections')
        self.assertEqual(resp.status_code, 302)
        self.assertIn('/login', resp.headers['Location'])

    def test_upload_rejects_anonymous(self):
        """/upload had no decorator at all — anyone could add images."""
        resp = self.client.post('/upload/col')
        self.assertEqual(resp.status_code, 302)

    def test_public_endpoints_still_reachable(self):
        self.assertEqual(self.client.get('/login').status_code, 200)
        self.assertEqual(self.client.get('/api/auth/me').status_code, 200)

    def test_every_public_endpoint_name_exists(self):
        """Guards against a typo silently leaving an endpoint walled off."""
        known = {r.endpoint for r in _app.app.url_map.iter_rules()}
        self.assertEqual(_app._PUBLIC_ENDPOINTS - known, set())


class TestRestrictedPatternMatching(unittest.TestCase):

    def _with_patterns(self, patterns):
        p = patch.object(_app, '_load_restricted_patterns', return_value=patterns)
        p.start()
        self.addCleanup(p.stop)

    def test_substring_match_is_case_insensitive(self):
        self._with_patterns(['gay'])
        self.assertTrue(_app._is_collection_restricted('GayReal'))
        self.assertTrue(_app._is_collection_restricted('MYGAYPICS'))

    def test_non_matching_collection_is_open(self):
        self._with_patterns(['gay'])
        self.assertFalse(_app._is_collection_restricted('Real'))

    def test_no_patterns_means_nothing_restricted(self):
        self._with_patterns([])
        self.assertFalse(_app._is_collection_restricted('GayReal'))

    def test_empty_collection_name_is_not_restricted(self):
        self._with_patterns(['gay'])
        self.assertFalse(_app._is_collection_restricted(''))


class TestRestrictedFiltering(unittest.TestCase):
    """_visible_tags_data() / _drop_restricted_rows() are the two choke points
    every read path goes through, so they carry the whole guarantee."""

    def _deny(self, denied):
        p = patch.object(_app, '_restricted_collections_denied_for_user', return_value=denied)
        p.start()
        self.addCleanup(p.stop)

    def test_visible_tags_data_strips_denied_collections(self):
        raw = {
            'Real/a.jpg':    {'url': 'https://cdn/Real/a.jpg', 'tags': []},
            'GayReal/b.jpg': {'url': 'https://cdn/GayReal/b.jpg', 'tags': []},
        }
        with patch.object(_app, '_load_tags_resolved', return_value=raw):
            self._deny({'GayReal'})
            out = _app._visible_tags_data()
        self.assertEqual(set(out), {'Real/a.jpg'})

    def test_visible_tags_data_passes_through_when_nothing_denied(self):
        raw = {'Real/a.jpg': {'url': 'https://cdn/Real/a.jpg', 'tags': []}}
        with patch.object(_app, '_load_tags_resolved', return_value=raw):
            self._deny(set())
            out = _app._visible_tags_data()
        self.assertEqual(out, raw)

    def test_drop_restricted_rows_filters_by_collection_name(self):
        rows = [{'collection_name': 'Real', 'filename': 'a.jpg'},
                {'collection_name': 'GayReal', 'filename': 'b.jpg'}]
        self._deny({'GayReal'})
        self.assertEqual(_app._drop_restricted_rows(rows),
                         [{'collection_name': 'Real', 'filename': 'a.jpg'}])


class TestRestrictedAccessRequestSql(unittest.TestCase):

    def setUp(self):
        _cur.reset_mock()
        _cur.rowcount = 1

    def test_request_reopens_an_approved_row_whose_window_lapsed(self):
        """The reconciler only stamps 'expired' once a minute; until it does, the
        row is still 'approved' and a re-request must not be rejected as
        'already in progress'."""
        _app._request_restricted_access('GayReal', 7)
        sql = _cur.execute.call_args.args[0]
        self.assertIn("status IN ('denied', 'expired', 'revoked')", sql)
        self.assertIn("status = 'approved'", sql)
        self.assertIn('accept_window_end <= NOW()', sql)

    def test_approve_cannot_be_performed_by_the_requester(self):
        _app._approve_restricted_access(3, 9)
        sql, params = _cur.execute.call_args.args
        self.assertIn('user_id != %s', sql)
        self.assertEqual(params, (9, 3, 9))

    def test_accept_requires_being_inside_the_window(self):
        _app._accept_restricted_access(3, 9)
        sql = _cur.execute.call_args.args[0]
        self.assertIn('NOW() BETWEEN accept_window_start AND accept_window_end', sql)
        self.assertIn("status = 'approved'", sql)


class TestRenamePreservesAccessControl(unittest.TestCase):
    """collections(name) is FK'd ON DELETE CASCADE from three access-control
    tables, and rename ends by deleting the old collections row — so every one of
    them must be carried across first or the rename silently resets access."""

    def setUp(self):
        _cur.reset_mock()
        _cur.fetchone.return_value = None
        _cur.fetchall.return_value = []
        self.client = _app.app.test_client()
        for name, kw in (('_collection_exists', {'side_effect': [True, False]}),
                         ('_ensure_collection', {'return_value': None}),
                         ('_load_collection_videos', {'return_value': []})):
            p = patch.object(_app, name, **kw)
            p.start()
            self.addCleanup(p.stop)

    def test_all_three_access_tables_follow_the_rename(self):
        resp = self.client.post('/api/collections/rename',
                                json={'old_name': 'GayReal', 'new_name': 'GayReel'})
        self.assertEqual(resp.status_code, 200)

        moved = {
            c.args[0].split()[1]                      # UPDATE <table> SET ...
            for c in _cur.execute.call_args_list
            if c.args and c.args[0].strip().startswith('UPDATE ')
            and len(c.args) > 1 and c.args[1] == ('GayReel', 'GayReal')
        }
        # (soft-deleted image rows are carried across by the same param shape,
        # hence a subset check rather than equality)
        self.assertLessEqual(
            {'video_collection_access', 'image_tag_blocks', 'restricted_collection_access'},
            moved,
        )


# ─────────────────────────────────────────────────────────────────────────────
# Guest passes for live multiplayer rooms
# ─────────────────────────────────────────────────────────────────────────────
class TestMultiplayerGuestPass(unittest.TestCase):
    """A room's share link admits a signed-out player to that one game, in that
    one collection, for as long as the room lives — and to nothing else."""

    ROOM = {'collection': 'GayReal'}

    def setUp(self):
        _cur.reset_mock()
        _cur.fetchone.return_value = None
        _cur.fetchall.return_value = []
        self.client = _app.app.test_client()

        # One live versuszoom room in a restricted collection
        self.rooms = {'AB12XY': dict(self.ROOM)}
        for name, kw in (('_vz_rooms', {'new': self.rooms}),
                         ('current_user', {'new': _Anon()}),
                         ('_is_collection_restricted', {'return_value': True}),
                         ('_restricted_collections_denied_for_user', {'return_value': set()})):
            p = patch.object(_app, name, **kw)
            p.start()
            self.addCleanup(p.stop)

    # ── reaching the game page ──────────────────────────────────────────────
    def test_share_link_admits_a_signed_out_player(self):
        resp = self.client.get('/collection/GayReal/versuszoom?room=AB12XY')
        self.assertEqual(resp.status_code, 200)

    def test_same_page_without_a_room_code_still_requires_login(self):
        resp = self.client.get('/collection/GayReal/versuszoom')
        self.assertEqual(resp.status_code, 302)
        self.assertIn('/login', resp.headers['Location'])

    def test_unknown_room_code_requires_login(self):
        resp = self.client.get('/collection/GayReal/versuszoom?room=NOPE00')
        self.assertEqual(resp.status_code, 302)

    def test_room_code_does_not_unlock_a_different_collection(self):
        """The link's collection must match the room's, or any live code would
        open any collection's game page."""
        resp = self.client.get('/collection/OtherColl/versuszoom?room=AB12XY')
        self.assertEqual(resp.status_code, 302)

    # ── the pass is narrow ──────────────────────────────────────────────────
    def test_pass_does_not_unlock_the_rest_of_the_app(self):
        self.assertEqual(
            self.client.get('/collection/GayReal/versuszoom?room=AB12XY').status_code, 200)
        # ...now the session holds a pass. It must still open nothing else.
        for path, expected in (('/api/collections', 401),
                               ('/api/tags', 401),
                               ('/collection/GayReal', 302),
                               ('/', 302),
                               ('/collection/GayReal/game', 302)):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, expected)

    def test_pass_does_not_open_another_multiplayer_game(self):
        self.client.get('/collection/GayReal/versuszoom?room=AB12XY')
        resp = self.client.get('/collection/GayReal/memorymatch')
        self.assertEqual(resp.status_code, 302)

    # ── lifetime ────────────────────────────────────────────────────────────
    def test_pass_dies_with_the_room(self):
        self.assertEqual(
            self.client.get('/collection/GayReal/versuszoom?room=AB12XY').status_code, 200)
        self.rooms.clear()          # last player disconnected; room popped
        resp = self.client.get('/collection/GayReal/versuszoom?room=AB12XY')
        self.assertEqual(resp.status_code, 302)

    def test_expired_pass_is_ignored(self):
        with _app.app.test_request_context('/'):
            _app.session['guest_pass'] = {
                'game': 'versuszoom', 'code': 'AB12XY', 'collection': 'GayReal',
                'issued_at': 0,     # 1970
            }
            self.assertIsNone(_app._guest_pass())

    def test_pass_for_a_stale_collection_is_ignored(self):
        """Room still live, but renamed out from under the pass."""
        with _app.app.test_request_context('/'):
            _app.session['guest_pass'] = {
                'game': 'versuszoom', 'code': 'AB12XY', 'collection': 'SomethingElse',
                'issued_at': _app._time.time(),
            }
            self.assertIsNone(_app._guest_pass())

    # ── the restricted gate honours it, for one collection only ─────────────
    def test_restricted_gate_opens_only_for_the_pass_collection(self):
        with _app.app.test_request_context('/'):
            _app.session['guest_pass'] = {
                'game': 'versuszoom', 'code': 'AB12XY', 'collection': 'GayReal',
                'issued_at': _app._time.time(),
            }
            self.assertFalse(_app._restricted_collection_blocked(_Anon(), 'GayReal'))
            self.assertTrue(_app._restricted_collection_blocked(_Anon(), 'GaySnaps'))

    # ── socket join authorisation ───────────────────────────────────────────
    def test_guest_may_join_only_the_room_that_invited_them(self):
        with _app.app.test_request_context('/'):
            _app.session['guest_pass'] = {
                'game': 'versuszoom', 'code': 'AB12XY', 'collection': 'GayReal',
                'issued_at': _app._time.time(),
            }
            self.assertTrue(_app._may_join_room('versuszoom', 'AB12XY'))
            self.assertFalse(_app._may_join_room('versuszoom', 'ZZ99ZZ'))
            self.assertFalse(_app._may_join_room('memorymatch', 'AB12XY'))

    def test_guest_with_no_pass_may_not_join(self):
        with _app.app.test_request_context('/'):
            self.assertFalse(_app._may_join_room('versuszoom', 'AB12XY'))


class TestRoomCodeGeneration(unittest.TestCase):

    def test_codes_are_unpredictable_and_unique(self):
        """Room codes admit link-invited players, so they must come from secrets
        rather than random's reconstructable Mersenne Twister."""
        import inspect
        src = inspect.getsource(_app._vz_gen_code)
        self.assertIn('secrets.choice', src)
        self.assertNotIn('random.choices', src)

    def test_generated_code_shape(self):
        with patch.dict(_app._vz_rooms, {}, clear=True):
            code = _app._vz_gen_code()
        self.assertEqual(len(code), 6)
        self.assertTrue(code.isalnum() and code.isupper())


# ─────────────────────────────────────────────────────────────────────────────
# AI quote: length cap and prompt contract
# ─────────────────────────────────────────────────────────────────────────────
class TestAiQuoteLengthCap(unittest.TestCase):
    """The save endpoint's character cap is what was silently rejecting generated
    quotes (the client never checked the response), so both the limit and the
    error it reports are part of the contract now."""

    def setUp(self):
        _cur.reset_mock()
        _cur.fetchone.return_value = None
        _cur.fetchall.return_value = []
        _stub_no_restrictions(self)
        self.client = _app.app.test_client()
        p = patch.object(_app, '_image_exists_in_tags', return_value=True)
        p.start()
        self.addCleanup(p.stop)

    def _post(self, quote):
        return self.client.post(
            '/api/images/col/a.jpg/ai-quote',
            json={'quote': quote},
        )

    def test_quote_at_the_limit_is_accepted(self):
        with patch.object(_app, '_set_image_ai_quote') as save:
            resp = self._post('x' * _app.AI_QUOTE_MAX_CHARS)
        self.assertEqual(resp.status_code, 200)
        save.assert_called_once()

    def test_over_long_quote_is_rejected_with_both_numbers(self):
        """A bare 'quote is too long' gave the caller nothing to act on."""
        over = 'x' * (_app.AI_QUOTE_MAX_CHARS + 25)
        with patch.object(_app, '_set_image_ai_quote') as save:
            resp = self._post(over)
        self.assertEqual(resp.status_code, 400)
        body = resp.get_json()
        self.assertIn(str(len(over)), body['error'])
        self.assertIn(str(_app.AI_QUOTE_MAX_CHARS), body['error'])
        self.assertEqual(body['max_chars'], _app.AI_QUOTE_MAX_CHARS)
        save.assert_not_called()

    def test_empty_quote_is_rejected(self):
        with patch.object(_app, '_set_image_ai_quote') as save:
            resp = self._post('   ')
        self.assertEqual(resp.status_code, 400)
        save.assert_not_called()


class TestAiQuotePromptContract(unittest.TestCase):

    def test_default_prompt_pins_the_output_language(self):
        """Qwen and other bilingual models code-switch into Chinese without it."""
        self.assertIn('English only', _app.DEFAULT_AI_QUOTE_SYSTEM_PROMPT)

    def test_default_prompt_keeps_the_required_placeholder(self):
        self.assertIn('{name_instruction}', _app.DEFAULT_AI_QUOTE_SYSTEM_PROMPT)

    def test_default_prompt_states_a_character_budget(self):
        self.assertIn('characters', _app.DEFAULT_AI_QUOTE_SYSTEM_PROMPT)

    def test_prompt_endpoint_tells_the_client_the_char_budget(self):
        """The client trims to this rather than losing a paid-for completion."""
        _cur.reset_mock()
        _cur.fetchone.side_effect = [
            (1, ['soft light'], {'chest': 'n'}),   # image row
            None,                                   # app_settings lookup
        ]
        _cur.fetchall.return_value = []
        built = _app._build_ai_quote_prompt('col', 'a.jpg')
        _cur.fetchone.side_effect = None
        self.assertEqual(built['max_chars'], _app.AI_QUOTE_MAX_CHARS)


# ─────────────────────────────────────────────────────────────────────────────
# Sequence Duel (live 2-player Simon-says, taken in turns)
# ─────────────────────────────────────────────────────────────────────────────
class _SqBase(unittest.TestCase):

    CODE = 'RM0001'

    def setUp(self):
        self.sio = MagicMock()
        self.sio.sleep = MagicMock(return_value=None)
        p = patch.object(_app, 'socketio', self.sio)
        p.start()
        self.addCleanup(p.stop)

    def make_room(self, phase='input', seq=(2, 5, 7), turn=1, active='A'):
        room = {
            'collection': 'col', 'grid_size': 4, 'flash_ms': 600,
            'board': ['u%d' % i for i in range(16)],
            'sequence': list(seq),
            'turn': turn,
            'turn_order': ['A', 'B'],
            'active_sid': active,
            'step': 0,
            'cleared': {'A': 0, 'B': 0},
            'players': {'A': 'Ana', 'B': 'Bo'},
            'user_ids': {'A': 1, 'B': 2},
            'rematch': set(),
            'deadline_token': 0,
            'pending_opponent_name': 'Bo',
            'phase': phase,
        }
        _app._sq_rooms[self.CODE] = room
        self.addCleanup(_app._sq_rooms.pop, self.CODE, None)
        return room

    def payload(self, event):
        for call in self.sio.emit.call_args_list:
            if call.args and call.args[0] == event:
                return call.args[1]
        return None

    def events(self):
        return [c.args[0] for c in self.sio.emit.call_args_list if c.args]


class TestSequenceDuelTurnOrder(_SqBase):

    def test_turns_alternate_between_the_two_players(self):
        room = self.make_room(phase='lobby', seq=(), turn=0, active=None)
        seen = []
        for _ in range(4):
            room['phase'] = 'between'
            _app._sq_next_turn(self.CODE)
            seen.append(room['active_sid'])
        self.assertEqual(seen, ['A', 'B', 'A', 'B'])

    def test_both_players_face_a_length_before_it_grows(self):
        """Losing should mean you broke at a length your opponent already cleared,
        so the length steps up only after both have played it."""
        lengths = [_app._sq_length_for_turn(t) for t in range(1, 9)]
        self.assertEqual(lengths, [3, 3, 4, 4, 5, 5, 6, 6])

    def test_each_turn_gets_a_fresh_sequence_not_a_growing_prefix(self):
        """The idle player is watching every tap — a shared growing prefix would
        hand them the answer to their own next turn."""
        room = self.make_room(phase='lobby', seq=(), turn=0, active=None)
        _app._sq_next_turn(self.CODE)
        first = list(room['sequence'])
        room['phase'] = 'between'
        _app._sq_next_turn(self.CODE)
        second = list(room['sequence'])
        self.assertEqual(len(first), len(second))       # same length for both players
        self.assertEqual(len(second), _app.SQ_START_LENGTH)
        self.assertFalse(second[:len(first)] == first and len(second) > len(first))

    def test_turn_start_names_the_active_player_but_not_the_cells(self):
        room = self.make_room(phase='lobby', seq=(), turn=0, active=None)
        _app._sq_next_turn(self.CODE)
        body = self.payload('sq_turn_start')
        self.assertEqual(body['activeSid'], 'A')
        self.assertEqual(body['length'], _app.SQ_START_LENGTH)
        self.assertNotIn('sequence', body)

        flashes = [c.args[1] for c in self.sio.emit.call_args_list if c.args[0] == 'sq_flash']
        self.assertEqual(len(flashes), _app.SQ_START_LENGTH)


class TestSequenceDuelTapping(_SqBase):
    """sq_tap reads request.sid, so these drive it through a request context."""

    def _tap(self, room, sid, index):
        with _app.app.test_request_context('/'):
            _app.request.sid = sid
            _app._sq_sid_room[sid] = self.CODE
            self.addCleanup(_app._sq_sid_room.pop, sid, None)
            with patch.object(_app, 'emit'):
                _app.sq_tap({'index': index})

    def test_a_correct_tap_advances_the_step(self):
        room = self.make_room(seq=(2, 5, 7), active='A')
        self._tap(room, 'A', 2)
        self.assertEqual(room['step'], 1)
        self.assertEqual(room['phase'], 'input')

    def test_every_tap_is_broadcast_so_the_other_player_watches_it_land(self):
        room = self.make_room(seq=(2, 5, 7), active='A')
        self._tap(room, 'A', 2)
        body = self.payload('sq_tap_landed')
        self.assertEqual(body['sid'], 'A')
        self.assertEqual(body['index'], 2)
        self.assertTrue(body['correct'])
        # broadcast to the room, not just the tapper
        landed = next(c for c in self.sio.emit.call_args_list if c.args[0] == 'sq_tap_landed')
        self.assertEqual(landed.kwargs.get('room'), self.CODE)

    def test_a_wrong_tap_ends_the_game_for_the_tapper(self):
        room = self.make_room(seq=(2, 5, 7), active='A')
        self._tap(room, 'A', 9)
        self.assertFalse(self.payload('sq_tap_landed')['correct'])
        over = self.payload('sq_game_over')
        self.assertEqual(over['loserSid'], 'A')
        self.assertEqual(over['winnerSid'], 'B')
        self.assertEqual(room['phase'], 'finished')

    def test_the_idle_player_cannot_tap(self):
        room = self.make_room(seq=(2, 5, 7), active='A')
        self._tap(room, 'B', 2)
        self.assertEqual(room['step'], 0)
        self.assertNotIn('sq_tap_landed', self.events())
        self.assertNotIn('sq_game_over', self.events())

    def test_completing_the_sequence_clears_the_turn(self):
        room = self.make_room(seq=(2, 5, 7), active='A')
        for cell in (2, 5, 7):
            self._tap(room, 'A', cell)
        self.assertEqual(room['phase'], 'between')
        self.assertEqual(room['cleared']['A'], 1)
        self.assertNotIn('sq_game_over', self.events())

    def test_taps_are_ignored_once_the_game_is_over(self):
        room = self.make_room(phase='finished', seq=(2, 5, 7), active='A')
        self._tap(room, 'A', 2)
        self.assertEqual(room['step'], 0)
        self.assertNotIn('sq_tap_landed', self.events())


class TestSequenceDuelDeadline(_SqBase):

    def test_the_active_player_loses_on_timeout(self):
        room = self.make_room(active='B')
        _app._sq_deadline(self.CODE, room['deadline_token'], 1)
        self.assertEqual(self.payload('sq_game_over')['loserSid'], 'B')

    def test_a_stale_deadline_task_does_nothing(self):
        """Clearing a turn bumps the token; the old timer must not fire."""
        room = self.make_room()
        stale = room['deadline_token']
        room['deadline_token'] += 1
        _app._sq_deadline(self.CODE, stale, 1)
        self.assertIsNone(self.payload('sq_game_over'))

    def test_deadline_does_nothing_once_the_turn_is_cleared(self):
        room = self.make_room(phase='between')
        _app._sq_deadline(self.CODE, room['deadline_token'], 1)
        self.assertIsNone(self.payload('sq_game_over'))


class TestSequenceDuelRematch(_SqBase):

    def setUp(self):
        super().setUp()
        # Starting a rematch rebuilds the board, which reaches the DB for the
        # players' content blocks — not what these tests are about.
        for name, kw in (('_sq_build_board', {'return_value': (['u%d' % i for i in range(16)], 16)}),
                         ('_union_blocked_pairs', {'return_value': set()})):
            p = patch.object(_app, name, **kw)
            p.start()
            self.addCleanup(p.stop)

    def _ask(self, sid):
        with _app.app.test_request_context('/'):
            _app.request.sid = sid
            _app._sq_sid_room[sid] = self.CODE
            self.addCleanup(_app._sq_sid_room.pop, sid, None)
            _app.sq_rematch({})

    def test_one_player_asking_only_announces_it(self):
        room = self.make_room(phase='finished')
        self._ask('A')
        self.assertEqual(self.payload('sq_rematch_state')['ready'], ['A'])
        self.assertIsNone(self.payload('sq_rematch_start'))
        self.assertEqual(room['phase'], 'finished')

    def test_both_asking_starts_a_fresh_game(self):
        room = self.make_room(phase='finished', turn=7)
        room['cleared'] = {'A': 3, 'B': 3}
        self._ask('A')
        self._ask('B')
        self.assertIsNotNone(self.payload('sq_rematch_start'))
        self.assertEqual(room['turn'], 0)
        self.assertEqual(room['sequence'], [])
        self.assertEqual(room['cleared'], {'A': 0, 'B': 0})

    def test_rematch_swaps_who_opens(self):
        """Going first is a small edge — it shouldn't stay with the same player."""
        room = self.make_room(phase='finished')
        room['turn_order'] = ['A', 'B']
        self._ask('A')
        self._ask('B')
        self.assertEqual(room['turn_order'], ['B', 'A'])

    def test_rematch_is_ignored_mid_game(self):
        room = self.make_room(phase='input')
        self._ask('A')
        self.assertEqual(room['rematch'], set())


class TestSequenceDuelBoard(_SqBase):

    def _images(self, n):
        return [{'url': f'https://cdn/img{i}.jpg'} for i in range(n)]

    def test_board_fills_the_grid_by_repeating_a_small_collection(self):
        with patch.object(_app, '_vz_collection_images', return_value=self._images(5)):
            board, available = _app._sq_build_board('col', 6)
        self.assertEqual(len(board), 36)
        self.assertEqual(available, 5)

    def test_board_refuses_a_collection_below_the_minimum(self):
        with patch.object(_app, '_vz_collection_images', return_value=self._images(3)):
            board, available = _app._sq_build_board('col', 4)
        self.assertIsNone(board)
        self.assertEqual(available, 3)


class TestSequenceDuelDisconnect(_SqBase):

    def test_leaving_mid_game_hands_the_win_to_whoever_stayed(self):
        room = self.make_room(phase='input')
        _app._sq_sid_room['A'] = self.CODE
        _app._sq_handle_disconnect('A')
        self.assertIn('sq_game_over', self.events())
        self.assertIn('sq_opponent_left', self.events())
        self.assertEqual(room['phase'], 'finished')

    def test_last_player_out_drops_the_room(self):
        self.make_room(phase='finished')
        _app._sq_sid_room['A'] = self.CODE
        _app._sq_sid_room['B'] = self.CODE
        _app._sq_handle_disconnect('A')
        _app._sq_handle_disconnect('B')
        self.assertNotIn(self.CODE, _app._sq_rooms)


class TestSequenceDuelRouting(unittest.TestCase):

    def test_route_is_registered(self):
        rules = {r.endpoint for r in _app.app.url_map.iter_rules()}
        self.assertIn('collection_sequenceduel', rules)

    def test_share_links_work_for_guests_like_the_other_duels(self):
        self.assertIn('collection_sequenceduel', _app._GUEST_ENDPOINTS)
        game, _registry = _app._GUEST_ENDPOINTS['collection_sequenceduel']
        self.assertEqual(game, 'sequenceduel')
        self.assertIs(_app._room_registry(game), _app._sq_rooms)

    def test_disconnect_dispatcher_cleans_up_this_game_too(self):
        """Flask-SocketIO keeps only the last 'disconnect' handler, so every game
        has to be dispatched from the one handler."""
        import inspect
        self.assertIn('_sq_handle_disconnect', inspect.getsource(_app.handle_disconnect))
