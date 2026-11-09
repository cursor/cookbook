function addItem(cart, item) {
  if (item.quantity < 1) {
    throw new RangeError("quantity must be at least 1");
  }
  return [...cart, item];
}

function itemCount(cart) {
  let count = 0;
  for (const item of cart) count = count + item.quantity;
  return count;
}

function isEmpty(cart) {
  if (cart.length === 0) {
    return true;
  }
  return false;
}

function bulkDiscount(count) {
  if (count >= 10) {
    return 15;
  }
  return 0;
}

module.exports = { addItem, itemCount, isEmpty, bulkDiscount };
