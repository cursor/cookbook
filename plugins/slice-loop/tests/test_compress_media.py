import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "skills/validate/scripts/compress_media.sh"


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(SCRIPT), *args], capture_output=True, text=True)


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
class CompressMediaTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.video = cls.tmp / "flow.webm"
        cls.image = cls.tmp / "shot.png"
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=25",
             "-t", "8", "-c:v", "libvpx-vp9", "-b:v", "1M", str(cls.video)],
            check=True,
        )
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=2560x1600",
             "-frames:v", "1", str(cls.image)],
            check=True,
        )

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def probe(self, path: Path, entries: str) -> str:
        return subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", entries, "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, check=True,
        ).stdout.strip()

    def test_image_is_downscaled(self):
        out = self.tmp / "out/shot.png"
        result = run("image", str(self.image), str(out))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.probe(out, "stream=width"), "1280")

    def test_video_is_trimmed_scaled_and_mp4(self):
        out = self.tmp / "out/flow.mp4"
        result = run("video", str(self.video), str(out), "3")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.probe(out, "stream=codec_name,width"), "h264,1280")
        duration = float(subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(out)],
            capture_output=True, text=True, check=True,
        ).stdout)
        self.assertLessEqual(duration, 3.2)

    def test_gif_and_contact_sheet(self):
        gif = self.tmp / "out/flow.gif"
        sheet = self.tmp / "out/sheet.jpg"
        self.assertEqual(run("gif", str(self.video), str(gif), "2").returncode, 0)
        result = run("sheet", str(self.video), str(sheet), "6")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(gif.stat().st_size > 0)
        width, height = self.probe(sheet, "stream=width,height").split(",")
        self.assertGreater(int(width), int(height))


class CompressMediaUsageTest(unittest.TestCase):
    def test_missing_input_fails(self):
        result = run("image", "/nonexistent.png", "/tmp/out.png")
        self.assertNotEqual(result.returncode, 0)

    def test_usage_without_args(self):
        self.assertEqual(run().returncode, 2)


if __name__ == "__main__":
    unittest.main()
