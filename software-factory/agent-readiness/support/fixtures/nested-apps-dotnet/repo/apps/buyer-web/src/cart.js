export function lineTotal(price, quantity) {
  if (quantity < 1) {
    return 0;
  }
  return price * quantity;
}

export function freeShipping(subtotal) {
  return subtotal >= 50;
}

export function nextStep(step, lastStep) {
  if (step < lastStep) {
    return step + 1;
  }
  return lastStep;
}

export function isPostcode(text) {
  if (typeof text !== "string") {
    return false;
  }
  return text.length === 5;
}

export function parseQuantity(text) {
  const n = Number(text);
  if (Number.isNaN(n)) {
    throw new TypeError("not a number");
  }
  return Math.floor(n);
}
