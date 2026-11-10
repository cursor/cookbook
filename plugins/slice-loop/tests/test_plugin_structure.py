import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOOP_SKILLS = ["create-loop", "plan-tasks", "scaffold", "implement", "validate", "reflect"]


def frontmatter(path: Path) -> dict[str, str]:
    text = path.read_text()
    match = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
    if not match:
        raise AssertionError(f"{path} has no frontmatter")
    fields = {}
    for line in match.group(1).splitlines():
        if ":" in line and not line.startswith(" "):
            key, value = line.split(":", 1)
            fields[key.strip()] = value.strip()
    return fields


class ManifestTest(unittest.TestCase):
    def test_plugin_manifest_points_at_real_dirs(self):
        manifest = json.loads((ROOT / ".cursor-plugin/plugin.json").read_text())
        self.assertEqual(manifest["name"], "slice-loop")
        for key in ("skills", "agents"):
            self.assertTrue((ROOT / manifest[key]).is_dir(), key)

    def test_marketplace_version_matches_plugin(self):
        plugin = json.loads((ROOT / ".cursor-plugin/plugin.json").read_text())
        market = json.loads((ROOT / ".cursor-plugin/marketplace.json").read_text())
        self.assertEqual(market["plugins"][0]["name"], plugin["name"])
        self.assertEqual(market["plugins"][0]["version"], plugin["version"])


class SkillsTest(unittest.TestCase):
    def test_every_loop_skill_exists_with_matching_name(self):
        for name in LOOP_SKILLS:
            path = ROOT / "skills" / name / "SKILL.md"
            self.assertTrue(path.exists(), path)
            fields = frontmatter(path)
            self.assertEqual(fields.get("name"), name)
            self.assertGreater(len(fields.get("description", "")), 40, f"{name} description too thin")

    def test_template_skills_load_manifest_and_overlay(self):
        for name in LOOP_SKILLS[1:]:
            text = (ROOT / "skills" / name / "SKILL.md").read_text()
            self.assertIn(".cursor/loop/LOOP.md", text, name)
            self.assertIn(f"overlays/{name}.md", text, name)

    def test_overlay_targets_are_real_step_headings(self):
        # Overlays address steps by heading text, so template skills must keep "### " step headings.
        for name in ["plan-tasks", "scaffold", "implement", "validate"]:
            text = (ROOT / "skills" / name / "SKILL.md").read_text()
            self.assertGreaterEqual(len(re.findall(r"^### ", text, re.MULTILINE)), 3, name)

    def test_relative_references_resolve(self):
        pattern = re.compile(r"`((?:templates|references|scripts)/[\w./-]+)`")
        for skill_md in (ROOT / "skills").glob("*/SKILL.md"):
            for ref in pattern.findall(skill_md.read_text()):
                if "<" in ref or ref.endswith("/"):
                    continue
                self.assertTrue((skill_md.parent / ref).exists(), f"{skill_md.parent.name}: {ref}")

    def test_validate_scripts_exist(self):
        scripts = ROOT / "skills/validate/scripts"
        for name in ["compress_log.py", "compress_media.sh", "run_flow.mjs"]:
            self.assertTrue((scripts / name).exists(), name)

    def test_loop_manifest_template_has_required_keys(self):
        text = (ROOT / "skills/create-loop/templates/LOOP.md").read_text()
        for key in ["commands:", "boot:", "dirs:", "limits:", "gates:", "review:", "## Assumptions", "## Harness status", "## Changelog"]:
            self.assertIn(key, text)


class AgentTest(unittest.TestCase):
    def test_implement_slice_agent_references_every_loop_skill(self):
        path = ROOT / "agents/implement-slice.md"
        self.assertEqual(frontmatter(path).get("name"), "implement-slice")
        text = path.read_text()
        for name in LOOP_SKILLS:
            self.assertIn(f"`{name}`", text, name)


if __name__ == "__main__":
    unittest.main()
