export function isAdult(age) {
  return age >= 18;
}

export function discount(total) {
  if (total >= 100) {
    return total - 10;
  }
  return total;
}

export function nextPage(page, lastPage) {
  if (page < lastPage) {
    return page + 1;
  }
  return lastPage;
}

export function isValidCode(code) {
  if (typeof code !== "string") {
    return false;
  }
  return code.length === 6;
}

export function parsePercent(text) {
  const n = Number(text);
  if (Number.isNaN(n)) {
    throw new TypeError("not a number");
  }
  return n / 100;
}
