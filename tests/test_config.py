from __future__ import annotations

import tempfile
import unittest
import uuid
from pathlib import Path

from prompt_studio import wincred
from prompt_studio.config import DEFAULT_BASE_URL, DEFAULT_MODEL, Settings, load_settings, normalize_base_url
from prompt_studio.credentials import save_credentials
from prompt_studio.errors import ConfigError

KEY = "mock-" + "config-" + "key-001"


def make_settings(**overrides):
    params = {
        "base_url": "https://api.example.com",
        "model": "some-model",
        "api_key": KEY,
        "home": Path(tempfile.mkdtemp()),
    }
    params.update(overrides)
    return Settings(**params)


class EndpointJoinTests(unittest.TestCase):
    def test_appends_v1_when_missing(self):
        self.assertEqual(make_settings().api_url("/chat/completions"), "https://api.example.com/v1/chat/completions")

    def test_keeps_existing_v1(self):
        settings = make_settings(base_url="https://api.example.com/v1/")
        self.assertEqual(settings.api_url("/models"), "https://api.example.com/v1/models")

    def test_keeps_openai_compatible_gemini_path(self):
        settings = make_settings(base_url="https://generativelanguage.googleapis.com/v1beta/openai")
        self.assertEqual(
            settings.api_url("/chat/completions"),
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        )


class ValidationTests(unittest.TestCase):
    def test_rejects_non_http_scheme(self):
        with self.assertRaises(ConfigError):
            normalize_base_url("api.example.com")

    def test_rejects_whitespace(self):
        with self.assertRaises(ConfigError):
            normalize_base_url("https://api.example.com /v1")

    def test_requires_key(self):
        with self.assertRaises(ConfigError):
            make_settings(api_key="")

    def test_requires_model(self):
        with self.assertRaises(ConfigError):
            make_settings(model=" ")


class PublicViewTests(unittest.TestCase):
    def test_public_dict_never_contains_key(self):
        settings = make_settings()
        public = settings.public_dict()
        self.assertTrue(public["api_key_configured"])
        self.assertNotIn(KEY, str(public))
        self.assertFalse(public.get("api_key"))
        self.assertIn("...", public["api_key_masked"])


class LoadOrderTests(unittest.TestCase):
    def setUp(self):
        # Never touch the real "default" vault entry from tests.
        self.target = "test-" + uuid.uuid4().hex
        self.addCleanup(wincred.delete, target=self.target)

    def _save(self, path: Path) -> None:
        save_credentials(
            "https://from-file.example.com", "file-" + "key-" + "999", "file-model", path, target=self.target
        )

    def test_environment_overrides_credential_file(self):
        tmp = Path(tempfile.mkdtemp())
        cred_path = tmp / "credentials.json"
        self._save(cred_path)
        settings = load_settings(
            env={
                "PROMPT_STUDIO_BASE_URL": "https://from-env.example.com",
                "PROMPT_STUDIO_API_KEY": KEY,
                "PROMPT_STUDIO_MODEL": "env-model",
            },
            credential_path=cred_path,
            home=tmp,
        )
        self.assertEqual(settings.base_url, "https://from-env.example.com")
        self.assertEqual(settings.model, "env-model")
        self.assertEqual(settings.api_key, KEY)

    def test_credential_file_used_when_env_absent(self):
        tmp = Path(tempfile.mkdtemp())
        cred_path = tmp / "credentials.json"
        self._save(cred_path)
        settings = load_settings(env={}, credential_path=cred_path, home=tmp)
        self.assertEqual(settings.base_url, "https://from-file.example.com")
        self.assertEqual(settings.model, "file-model")

    def test_builtin_defaults_fill_base_and_model(self):
        tmp = Path(tempfile.mkdtemp())
        settings = load_settings(
            env={"PROMPT_STUDIO_API_KEY": KEY},
            credential_path=tmp / "missing.json",
            home=tmp,
        )
        self.assertEqual(settings.base_url, DEFAULT_BASE_URL)
        self.assertEqual(settings.model, DEFAULT_MODEL)

    def test_missing_configuration_is_explicit(self):
        tmp = Path(tempfile.mkdtemp())
        with self.assertRaises(ConfigError):
            load_settings(env={}, credential_path=tmp / "missing.json", home=tmp)


if __name__ == "__main__":
    unittest.main()
