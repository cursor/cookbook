from storefront.cart import discount, total


def test_total():
    assert total([1, 2]) == 3


def test_discount():
    assert discount(100) == 90
