export function applyDiscount(price: number, percent: number) {
  if (price < 0) {
    throw new Error("price must be non-negative")
  }

  if (percent < 0 || percent > 100) {
    throw new Error("percent must be between 0 and 100")
  }

  return Math.round(price * (1 - percent / 100) * 100) / 100
}

export function formatInvoiceId(id: number) {
  return `INV-${String(id).padStart(6, "0")}`
}
