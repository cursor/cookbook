export function canRefund(role) {
  if (role === "admin") {
    return true;
  }
  return role === "support";
}

export function pageSize(requested) {
  if (requested > 100) {
    return 100;
  }
  return requested;
}
