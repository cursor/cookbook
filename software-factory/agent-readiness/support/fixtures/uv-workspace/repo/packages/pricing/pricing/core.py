def discount(total):
    if total >= 100:
        return total - 10
    return total


def is_adult(age):
    if age < 0:
        raise ValueError("age must not be negative")
    return age >= 18


def next_page(page, last_page):
    if page < last_page:
        return page + 1
    return last_page
