export function displayName(user) {
  if (!user.first) {
    throw new Error("first name is required");
  }
  return user.last ? `${user.first} ${user.last}` : user.first;
}

export function isActive(user, now) {
  return user.lastSeen >= now - 30;
}
