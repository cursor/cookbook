import { discount } from "@fx/core";

export function checkout(total) {
  return discount(total);
}
