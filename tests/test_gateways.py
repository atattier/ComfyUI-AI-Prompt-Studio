from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from pathlib import Path

from prompt_studio import wincred
from prompt_studio.credentials import (
    Credentials,
    add_key,
    delete_credentials,
    delete_key,
    key_list,
    save_credentials,
)
from prompt_studio.gateways import (
    activate_gateway,
    delete_gateway,
    list_gateways,
    save_gateway,
)

KEY_A = "mock-" + "gateway-" + "key-a"
KEY_B = "mock-" + "gateway-" + "key-b"
URL_A = "https://a.example.com/v1"
URL_B = "https://b.example.com/v1"


class GatewayProfileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.cred_path = self.home / "credentials.json"
        self.prefix = "test-" + uuid.uuid4().hex
        save_credentials(URL_A, KEY_A, "model-a", self.cred_path, target=self.prefix)
        self.addCleanup(delete_credentials, self.cred_path, target=self.prefix)

    def test_saved_gateways_are_listed_without_any_secret(self):
        a = save_gateway(self.home, base_url=URL_A, model="model-a", label="A 网关")
        b = save_gateway(self.home, base_url=URL_B, model="model-b", label="B 网关")
        listing = list_gateways(
            self.home,
            credential_path=self.cred_path,
            current_base_url=URL_B,
            current_model="model-b",
        )
        self.assertEqual([g["id"] for g in listing["gateways"]], [a["id"], b["id"]])
        self.assertEqual(listing["active_gateway_id"], b["id"])
        self.assertEqual(listing["gateways"][0]["base_url"], URL_A)
        self.assertEqual(listing["gateways"][1]["model"], "model-b")
        self.assertNotIn(KEY_A, json.dumps(listing))

    def test_saving_the_same_gateway_twice_updates_instead_of_duplicating(self):
        first = save_gateway(self.home, base_url=URL_A, model="model-a", label="A")
        again = save_gateway(self.home, base_url=URL_A, model="model-a", label="A2")
        self.assertEqual(first["id"], again["id"])
        self.assertEqual(len(list_gateways(self.home)["gateways"]), 1)
        self.assertEqual(list_gateways(self.home)["gateways"][0]["label"], "A2")

    @unittest.skipUnless(wincred.available(), "Windows Credential Manager is not available")
    def test_activating_a_gateway_switches_url_model_and_key_together(self):
        first_id = key_list(self.cred_path)[0]["id"]
        add_key(KEY_B, "B key", self.cred_path, target_prefix=self.prefix)
        second_id = next(k["id"] for k in key_list(self.cred_path) if k["label"] == "B key")

        a = save_gateway(
            self.home, base_url=URL_A, model="model-a", label="A", key_id=first_id
        )
        b = save_gateway(
            self.home,
            base_url=URL_B,
            model="model-b",
            label="B",
            key_id=second_id,
            activate=False,
        )

        activate_gateway(self.home, b["id"], credential_path=self.cred_path)
        creds = Credentials.load(self.cred_path)
        assert creds is not None
        self.assertEqual(creds.base_url, URL_B)
        self.assertEqual(creds.model, "model-b")
        self.assertEqual(creds.api_key, KEY_B)
        self.assertEqual(creds.active_key_id, second_id)

        activate_gateway(self.home, a["id"], credential_path=self.cred_path)
        creds = Credentials.load(self.cred_path)
        assert creds is not None
        self.assertEqual(creds.base_url, URL_A)
        self.assertEqual(creds.model, "model-a")
        self.assertEqual(creds.api_key, KEY_A)

    @unittest.skipUnless(wincred.available(), "Windows Credential Manager is not available")
    def test_activating_a_gateway_whose_key_is_gone_reports_it(self):
        add_key(KEY_B, "B key", self.cred_path, target_prefix=self.prefix)
        second_id = next(k["id"] for k in key_list(self.cred_path) if k["label"] == "B key")
        profile = save_gateway(
            self.home, base_url=URL_B, model="model-b", label="B", key_id=second_id
        )
        delete_key(second_id, self.cred_path)
        with self.assertRaises(ValueError) as ctx:
            activate_gateway(self.home, profile["id"], credential_path=self.cred_path)
        self.assertIn("密钥", str(ctx.exception))

    def test_deleting_the_active_gateway_clears_the_active_binding(self):
        a = save_gateway(self.home, base_url=URL_A, model="model-a", label="A")
        b = save_gateway(self.home, base_url=URL_B, model="model-b", label="B")
        self.assertTrue(delete_gateway(self.home, b["id"]))
        listing = list_gateways(self.home)
        self.assertEqual([g["id"] for g in listing["gateways"]], [a["id"]])
        self.assertFalse(delete_gateway(self.home, b["id"]))


if __name__ == "__main__":
    unittest.main()