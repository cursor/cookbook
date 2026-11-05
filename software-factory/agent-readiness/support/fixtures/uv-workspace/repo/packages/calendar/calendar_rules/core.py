def is_leap(year):
    if year % 400 == 0:
        return True
    if year % 100 == 0:
        return False
    return year % 4 == 0


def grade(score):
    if score < 0:
        raise ValueError("score must not be negative")
    if score >= 90:
        return "A"
    if score >= 75:
        return "B"
    return "C"
