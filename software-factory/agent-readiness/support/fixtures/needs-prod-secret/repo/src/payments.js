export function fee(amount) {
  if (amount <= 0) {
    throw new RangeError("amount must be positive");
  }
  return Math.round(amount * 0.029 + 30);
}
