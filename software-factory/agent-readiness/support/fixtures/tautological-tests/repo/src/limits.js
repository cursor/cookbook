export function clampPercent(n) {
  if (n < 0) {
    return 0;
  }
  if (n > 100) {
    return 100;
  }
  return n;
}

export function isBusinessDay(day) {
  return day >= 1 && day <= 5;
}
