export function orderTotal(items) {
  let total = 0;
  for (const item of items) {
    if (item.qty < 1) {
      throw new RangeError("qty must be at least 1");
    }
    total += item.price * item.qty;
  }
  return total;
}
