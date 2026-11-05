export function lineTotal(price: number, quantity: number): number {
  if (quantity < 1) {
    return 0;
  }
  return price * quantity;
}

export function freeShipping(subtotal: number): boolean {
  return subtotal >= 50;
}

export function nextStep(step: number, lastStep: number): number {
  if (step < lastStep) {
    return step + 1;
  }
  return lastStep;
}

export function isPostcode(text: unknown): boolean {
  if (typeof text !== "string") {
    return false;
  }
  return text.length === 5;
}

export function parseQuantity(text: string): number {
  const n = Number(text);
  if (Number.isNaN(n)) {
    throw new TypeError("not a number");
  }
  return Math.floor(n);
}
