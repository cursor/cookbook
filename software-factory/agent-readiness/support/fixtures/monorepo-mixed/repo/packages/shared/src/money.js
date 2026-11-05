export function toCents(amount) {
  if (typeof amount !== "number") {
    throw new TypeError("amount must be a number");
  }
  return Math.round(amount * 100);
}

export function formatCents(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function isFree(cents) {
  return cents <= 0;
}
