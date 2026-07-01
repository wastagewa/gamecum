"""
Unit tests for body-part tagging logic and related helpers.
All DB / cloud dependencies are stubbed so no real services are needed.
Run: python -m pytest tests.py -v   (or: python tests.py)
"""
import sys, os, types, unittest
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
    @patch.object(_app, '_b2_sign_url', side_effect=lambda k: f'signed:{k}')
    def test_two_matching_parts_eligible(self, _sign, mock_load):
        mock_load.return_value = self._fake_tags_data([
            ({'boobs': 'n', 'pussy': 'x'}, []),
        ])
        result = _app._cc_collection_images('col', self.KM)
        self.assertEqual(len(result), 1)

    @patch.object(_app, '_load_tags')
    @patch.object(_app, '_b2_sign_url', side_effect=lambda k: f'signed:{k}')
    def test_one_matching_part_not_eligible(self, _sign, mock_load):
        mock_load.return_value = self._fake_tags_data([
            ({'boobs': 'n'}, []),
        ])
        result = _app._cc_collection_images('col', self.KM)
        self.assertEqual(len(result), 0)

    @patch.object(_app, '_load_tags')
    @patch.object(_app, '_b2_sign_url', side_effect=lambda k: f'signed:{k}')
    def test_options_keys_match_body_part_names(self, _sign, mock_load):
        mock_load.return_value = self._fake_tags_data([
            ({'boobs': 'n', 'butt': 'sn', 'face': 'c'}, []),
        ])
        result = _app._cc_collection_images('col', self.KM)
        self.assertSetEqual(set(result[0]['options'].keys()), {'boobs', 'butt', 'face'})

    @patch.object(_app, '_load_tags')
    @patch.object(_app, '_b2_sign_url', side_effect=lambda k: f'signed:{k}')
    def test_body_part_not_in_keyword_map_excluded_from_options(self, _sign, mock_load):
        # 'chest' is in CC_CATEGORY_KEYWORDS_GAY but not DEFAULT — should be ignored
        mock_load.return_value = self._fake_tags_data([
            ({'boobs': 'n', 'chest': 'sn'}, []),   # only 1 valid for DEFAULT map
        ])
        result = _app._cc_collection_images('col', self.KM)
        self.assertEqual(len(result), 0)

    @patch.object(_app, '_load_tags')
    @patch.object(_app, '_b2_sign_url', side_effect=lambda k: f'signed:{k}')
    def test_legacy_flat_tags_fallback_when_no_body_parts(self, _sign, mock_load):
        mock_load.return_value = self._fake_tags_data([
            ({}, ['boobs', 'pussy', 'n']),
        ])
        result = _app._cc_collection_images('col', self.KM)
        self.assertEqual(len(result), 1)
        self.assertIn('boobs', result[0]['options'])
        self.assertIn('pussy', result[0]['options'])

    @patch.object(_app, '_load_tags')
    @patch.object(_app, '_b2_sign_url', side_effect=lambda k: f'signed:{k}')
    def test_empty_body_parts_and_no_tags_not_eligible(self, _sign, mock_load):
        mock_load.return_value = self._fake_tags_data([
            ({}, []),
        ])
        result = _app._cc_collection_images('col', self.KM)
        self.assertEqual(len(result), 0)

    @patch.object(_app, '_load_tags')
    @patch.object(_app, '_b2_sign_url', side_effect=lambda k: f'signed:{k}')
    def test_mixed_new_and_legacy_images(self, _sign, mock_load):
        mock_load.return_value = self._fake_tags_data([
            ({'boobs': 'n', 'face': 'sn'}, []),          # new format — eligible
            ({}, ['boobs', 'butt', 'sn']),                 # legacy — eligible
            ({'legs': 'c'}, []),                           # new format, 1 part only — not eligible
        ])
        result = _app._cc_collection_images('col', self.KM)
        self.assertEqual(len(result), 2)

    @patch.object(_app, '_load_tags')
    @patch.object(_app, '_b2_sign_url', side_effect=lambda k: f'signed:{k}')
    def test_url_is_signed(self, _sign, mock_load):
        mock_load.return_value = self._fake_tags_data([
            ({'boobs': 'n', 'butt': 'sn'}, []),
        ])
        result = _app._cc_collection_images('col', self.KM)
        self.assertTrue(result[0]['url'].startswith('signed:'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
