from __future__ import annotations

import json
import unittest

from prompt_studio.imagine import (
    aspect_size,
    auto_imagine_pipeline,
    brainstorm_ideas,
    candidates_instruction,
    expand_candidate,
    imagine_candidates,
    parse_brainstorm,
    parse_candidates,
)


def fake_call(responses):
    calls = []

    def call(instruction, max_tokens, temperature):
        calls.append(instruction)
        return responses[len(calls) - 1]

    call.calls = calls
    return call


BRAINSTORM_JSON = json.dumps({
    "ideas": [
        {"title": "深海发光水母殿堂", "idea": "身穿发光珊瑚礼服的少女在深海巨大发光水母群中下潜。", "theme": "fantasy"},
        {"title": "轨道站日出微醺", "idea": "太空宇航员在近地轨道观景穹顶内手持热咖啡凝视晨昏线。", "theme": "cyberpunk"},
    ]
}, ensure_ascii=False)

CANDIDATES_JSON = json.dumps({
    "candidates": [
        {"title": "雨夜回眸", "aspect": "portrait", "prompt": "A mechanical girl turns back under neon rain."},
        {"title": "霓虹俯瞰", "aspect": "landscape", "prompt": "A wide aerial view of a neon street at night."},
        {"title": "伞下特写", "aspect": "square", "prompt": "A close-up of a clear umbrella dripping with rain."},
    ]
}, ensure_ascii=False)


class BrainstormTests(unittest.TestCase):
    def test_brainstorm_ideas_parsed(self):
        call = fake_call([BRAINSTORM_JSON])
        ideas = brainstorm_ideas(call, theme="fantasy", count=2)
        self.assertEqual(len(ideas), 2)
        self.assertEqual(ideas[0]["title"], "深海发光水母殿堂")
        self.assertIn("发光珊瑚礼服", ideas[0]["idea"])
        self.assertIn("Theme Inspiration", call.calls[0])

    def test_brainstorm_fallback_on_plain_text(self):
        call = fake_call(["夕阳下的巨型风力发电机与金色麦浪"])
        ideas = brainstorm_ideas(call, theme="nature", count=1)
        self.assertEqual(len(ideas), 1)
        self.assertIn("金色麦浪", ideas[0]["idea"])


class ImagineCandidatesTests(unittest.TestCase):
    def test_parses_three_candidates_with_sizes(self):
        call = fake_call([CANDIDATES_JSON])
        out = imagine_candidates(call, "雨夜霓虹机械少女", count=3)
        self.assertEqual(len(out), 3)
        self.assertEqual(out[0]["title"], "雨夜回眸")
        self.assertEqual(out[0]["aspect"], "portrait")
        self.assertLess(out[0]["width"], out[0]["height"])
        self.assertGreater(out[1]["width"], out[1]["height"])
        for cand in out:
            self.assertEqual(cand["width"] % 16, 0)
            self.assertEqual(cand["height"] % 16, 0)
        self.assertIn("雨夜霓虹机械少女", call.calls[0])

    def test_forced_aspect_overrides_model_choice(self):
        out = parse_candidates(CANDIDATES_JSON, count=3, aspect="square")
        self.assertTrue(all(c["aspect"] == "square" for c in out))
        self.assertEqual(out[0]["width"], out[0]["height"])

    def test_count_limits_results(self):
        out = parse_candidates(CANDIDATES_JSON, count=1, aspect="auto")
        self.assertEqual(len(out), 1)

    def test_fenced_json_is_accepted(self):
        out = parse_candidates("```json\n" + CANDIDATES_JSON + "\n```", count=3, aspect="auto")
        self.assertEqual(len(out), 3)

    def test_plain_prose_falls_back_to_one_candidate(self):
        out = parse_candidates("A lone lighthouse at dawn.", count=3, aspect="auto")
        self.assertEqual(len(out), 1)
        self.assertIn("lighthouse", out[0]["prompt"])

    def test_empty_idea_rejected(self):
        with self.assertRaises(ValueError):
            imagine_candidates(fake_call(["x"]), "   ")

    def test_instruction_mentions_spatial_anchoring_and_style(self):
        instr = candidates_instruction("cat", count=3, style="anime", aspect="auto")
        self.assertIn("viewer's left", instr)
        self.assertIn("anime", instr.lower())
        self.assertIn("different interpretation", instr)

    def test_aspect_size_is_moss_compatible(self):
        for aspect in ("portrait", "landscape", "square", "bogus"):
            w, h = aspect_size(aspect)
            self.assertEqual(w % 16, 0)
            self.assertEqual(h % 16, 0)
            self.assertLessEqual(w * h, 2097152)


class ImagineExpandTests(unittest.TestCase):
    PROMPT = "A girl on the viewer's left holds a sign reading \"OPEN\"."

    def test_caption_only_makes_no_extra_calls(self):
        call = fake_call([])
        state = expand_candidate(call, self.PROMPT, modes=["caption"], width=832, height=1216)
        self.assertEqual(call.calls, [])
        self.assertEqual(state["caption_text"], self.PROMPT)
        self.assertEqual(state["source"], "imagine")
        self.assertEqual((state["width"], state["height"]), (832, 1216))
        self.assertNotIn("draft", state)

    def test_layout_and_danbooru_are_generated(self):
        layout = json.dumps({
            "summary": {"caption": "x"},
            "items": [
                {"name": "少女", "label": "character", "bbox": [50, 100, 450, 950], "caption": "girl"},
                {"name": "招牌文字", "label": "text", "bbox": [100, 200, 400, 300], "caption": "sign", "text": "OPEN"},
            ],
        })
        call = fake_call([layout, "1girl, solo, holding_sign"])
        state = expand_candidate(
            call, self.PROMPT, modes=["layout", "caption", "danbooru"], width=1024, height=1024,
        )
        self.assertEqual(len(call.calls), 2)
        self.assertEqual(state["mode"], "layout")
        self.assertEqual(len(state["draft"]["items"]), 2)
        self.assertEqual(state["hybrid_draft"]["summary"]["caption"], self.PROMPT)
        self.assertEqual(state["draft"]["items"][1]["text"], "OPEN")
        self.assertLess(state["draft"]["items"][0]["bbox"][2], 512)
        self.assertEqual(state["danbooru_prompt"], "1girl, solo, holding_sign")


class AutoImaginePipelineTests(unittest.TestCase):
    def test_auto_pipeline_brainstorms_when_idea_is_empty(self):
        one_cand = json.dumps({
            "candidates": [
                {"title": "水晶温室", "aspect": "portrait", "prompt": "A crystal greenhouse glowing at night."}
            ]
        })
        # 1. brainstorm call, 2. imagine candidates call
        call = fake_call([BRAINSTORM_JSON, one_cand])
        state = auto_imagine_pipeline(call, idea="", modes=["caption"])
        self.assertEqual(len(call.calls), 2)
        self.assertEqual(state["idea_title"], "深海发光水母殿堂")
        self.assertEqual(state["caption"], "A crystal greenhouse glowing at night.")

    def test_auto_pipeline_uses_provided_idea(self):
        one_cand = json.dumps({
            "candidates": [
                {"title": "极光列车", "aspect": "landscape", "prompt": "A train under aurora borealis."}
            ]
        })
        # only imagine candidates call, no brainstorm
        call = fake_call([one_cand])
        state = auto_imagine_pipeline(call, idea="极光下列车", modes=["caption"])
        self.assertEqual(len(call.calls), 1)
        self.assertEqual(state["idea"], "极光下列车")
        self.assertEqual(state["caption"], "A train under aurora borealis.")


class ImagineBackendTests(unittest.TestCase):
    def test_backend_routes_use_text_call(self):
        from prompt_studio.aiohttp_api import StudioBackend

        backend = StudioBackend.__new__(StudioBackend)

        class _S:
            max_regions = 8
            rule_preset = "moss"
            prompt_rules = ""
            user_custom_rules = ""
            output_language = "en"

        backend.settings = _S()
        backend._text_call = lambda model: fake_call([BRAINSTORM_JSON])
        b_out = backend.brainstorm({"theme": "fantasy", "count": 2})
        self.assertEqual(len(b_out["ideas"]), 2)

        backend._text_call = lambda model: fake_call([CANDIDATES_JSON])
        out = backend.imagine({"idea": "rainy neon", "count": 2})
        self.assertEqual(len(out["candidates"]), 2)

        backend._text_call = lambda model: fake_call([])
        res = backend.imagine_expand({"prompt": "A cat.", "modes": ["caption"], "width": 1216, "height": 832})
        self.assertEqual(res["payload"]["caption"], "A cat.")
        self.assertEqual((res["width"], res["height"]), (1216, 832))


if __name__ == "__main__":
    unittest.main()
