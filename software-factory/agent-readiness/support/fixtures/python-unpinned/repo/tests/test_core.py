import unittest

from calc.core import grade, is_leap


class CoreTest(unittest.TestCase):
    def test_leap(self):
        self.assertTrue(is_leap(2000))
        self.assertFalse(is_leap(1900))
        self.assertTrue(is_leap(2024))
        self.assertFalse(is_leap(2023))

    def test_grade(self):
        self.assertEqual(grade(90), "A")
        self.assertEqual(grade(89), "B")
        self.assertEqual(grade(75), "B")
        self.assertEqual(grade(74), "C")
        self.assertEqual(grade(0), "C")
        with self.assertRaises(ValueError):
            grade(-1)


if __name__ == "__main__":
    unittest.main()
