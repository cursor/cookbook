def total(prices):
    return sum(prices)


def discount(total):
    if total >= 100:
        return total - 10
    return total
