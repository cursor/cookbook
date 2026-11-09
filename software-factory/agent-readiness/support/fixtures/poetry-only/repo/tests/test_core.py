import unittest

from pricing.core import discount, is_adult, next_page


class CoreTest(unittest.TestCase):
    def test_discount(self):
        self.assertEqual(discount(99), 99)
        self.assertEqual(discount(100), 90)
        self.assertEqual(discount(150), 140)

    def test_is_adult(self):
        self.assertFalse(is_adult(0))
        self.assertFalse(is_adult(17))
        self.assertTrue(is_adult(18))
        self.assertTrue(is_adult(19))
        with self.assertRaises(ValueError):
            is_adult(-1)

    def test_next_page(self):
        self.assertEqual(next_page(1, 3), 2)
        self.assertEqual(next_page(2, 3), 3)
        self.assertEqual(next_page(3, 3), 3)


if __name__ == "__main__":
    unittest.main()
