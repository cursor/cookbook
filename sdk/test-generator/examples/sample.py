def apply_discount(price: float, percent: float) -> float:
    if price < 0:
        raise ValueError("price must be non-negative")

    if percent < 0 or percent > 100:
        raise ValueError("percent must be between 0 and 100")

    return round(price * (1 - percent / 100), 2)


def format_invoice_id(invoice_id: int) -> str:
    return f"INV-{invoice_id:06d}"
