from __future__ import annotations

import unittest

from prompt_studio.capabilities import CapabilityProber

from tests.support import make_client


class CapabilityProbeTests(unittest.TestCase):
    def test_vision_model_is_fully_capable(self):
        _mock, _settings, client, _audit = make_client(self, model="vision-pro")
        report = CapabilityProber(client).probe()
        self.assertTrue(report.text)
        self.assertTrue(report.vision)
        self.assertTrue(report.streaming)
        self.assertIsNotNone(report.declared_modalities)
        self.assertIn("both_probe_images_described", str(report.details["vision"]))
        self.assertFalse(report.cached)

    def test_text_only_model_is_identified(self):
        _mock, _settings, client, _audit = make_client(self, model="text-only")
        report = CapabilityProber(client).probe()
        self.assertTrue(report.text)
        self.assertIs(report.vision, False)
        self.assertEqual(report.details["vision"]["reason"], "rejected_by_api")
        self.assertTrue(report.streaming)
        # Declared modalities corroborate the direct evidence.
        self.assertEqual(report.declared_modalities["input"], ["text"])

    def test_probe_is_cached_and_force_refreshes(self):
        mock, _settings, client, _audit = make_client(self, model="vision-pro")
        prober = CapabilityProber(client)
        first = prober.probe()
        requests_after_first = len(mock.state.requests)
        second = prober.probe()
        self.assertTrue(second.cached)
        self.assertEqual(len(mock.state.requests), requests_after_first)
        third = prober.probe(force=True)
        self.assertFalse(third.cached)
        self.assertGreater(len(mock.state.requests), requests_after_first)
        self.assertEqual(first.model, third.model)

    def test_probe_records_text_failure_without_false_vision_claim(self):
        _mock, _settings, client, _audit = make_client(self, model="vision-pro", api_key="mock-" + "wrong-" + "999")
        report = CapabilityProber(client).probe()
        self.assertFalse(report.text)
        self.assertIsNone(report.vision)
        self.assertIsNone(report.streaming)
        self.assertEqual(report.details["vision"]["reason"], "text_probe_failed")


if __name__ == "__main__":
    unittest.main()
